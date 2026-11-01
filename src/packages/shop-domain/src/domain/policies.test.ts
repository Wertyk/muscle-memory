import { describe, expect, it } from "vitest";
import {
  addMoney, checkAddressChange, checkRefund, checkReturnWindow, isWithinAutoRefundLimit,
  money, parseShopId, refundableBalance, replacementContents, requestType, REQUEST_TYPES, validateAddress,
  type IdKind, type Order, type Refund, type Request, type StructuredRequestFields,
} from "./index.js";
import { address, order, request, shipment } from "../../test/fakes.js";

const prior: Refund = {
  id: "ref_0001", orderId: order.id, amount: { amountMinor: 3_000, currency: "USD" },
  reason: "Partial damage", createdAt: "2026-11-01T00:00:00.000Z",
};

describe("Money and short IDs", () => {
  it.each([-1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid minor units %s", (value) => {
    expect(money(value)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
  it("keeps integer arithmetic and checks currency and overflow", () => {
    expect(money(0)).toEqual({ ok: true, value: { amountMinor: 0, currency: "USD" } });
    expect(money(10, "usd").ok).toBe(false);
    expect(addMoney({ amountMinor: 10, currency: "USD" }, { amountMinor: 20, currency: "USD" })).toMatchObject({ value: { amountMinor: 30 } });
    expect(addMoney({ amountMinor: 10, currency: "USD" }, { amountMinor: 20, currency: "EUR" })).toMatchObject({ error: { code: "CURRENCY_MISMATCH" } });
    expect(addMoney({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" }, { amountMinor: 1, currency: "USD" }).ok).toBe(false);
    expect(addMoney({ amountMinor: -1, currency: "USD" }, { amountMinor: 1, currency: "USD" }).ok).toBe(false);
  });
  it.each<[IdKind, string]>([
    ["customer", "cus_0001"], ["product", "prd_0001"], ["order", "ord_1042"],
    ["request", "req_0007"], ["shipment", "shp_0001"], ["refund", "ref_0001"],
    ["reply", "rpl_0001"], ["returnLabel", "lbl_0001"],
  ])("accepts readable %s IDs", (kind, id) => { expect(parseShopId(kind, id)).toEqual({ ok: true, value: id }); });
  it.each(["", "ord_", "req_0001", "ord_A", "ord_a-b", "ord_" + "a".repeat(28), "facade00-0000-0000-0000-000000000000"])("rejects non-domain or redacted IDs %s", (id) => {
    expect(parseShopId("order", id).ok).toBe(false);
  });
  it("accepts exactly 31 characters", () => { expect(parseShopId("order", "ord_" + "a".repeat(27)).ok).toBe(true); });
});

describe("request forms", () => {
  const fields: StructuredRequestFields[] = [
    { type: "damaged_item", orderId: order.id, productId: "prd_0001", quantity: 1, description: "Broken" },
    { type: "where_is_my_order", orderId: order.id },
    { type: "return", orderId: order.id, reason: "Changed mind" },
    { type: "address_change", orderId: order.id, address },
    { type: "wholesale_inquiry", company: "Cafe", message: "50 mugs?" },
  ];
  it.each(fields)("models structured and free-text $type", (value) => {
    const structured: Request = { ...request, content: { source: "structured", fields: value } };
    const text: Request = { ...request, content: { source: "free_text", text: "Customer email", type: value.type } };
    expect(requestType(structured)).toBe(value.type);
    expect(requestType(text)).toBe(value.type);
    expect(REQUEST_TYPES).toContain(value.type);
  });
  it("retains unclassified free text without inventing a category", () => {
    expect(requestType({ ...request, orderId: null, content: { source: "free_text", text: "Hello!", type: null } })).toBeNull();
  });
});

describe("refund policies", () => {
  it("uses actual payment minus only this order's prior refunds", () => {
    expect(refundableBalance(order, [prior])).toEqual({ ok: true, value: { amountMinor: 5_000, currency: "USD" } });
    expect(checkRefund(order, [prior], { amountMinor: 5_000, currency: "USD" }).ok).toBe(true);
    expect(checkRefund(order, [prior], { amountMinor: 5_001, currency: "USD" })).toMatchObject({ error: { code: "REFUND_EXCEEDS_BALANCE", availableMinor: 5_000 } });
  });
  it("rejects currency mismatch and invalid history", () => {
    expect(checkRefund(order, [], { amountMinor: 1, currency: "EUR" })).toMatchObject({ error: { code: "CURRENCY_MISMATCH" } });
    expect(refundableBalance(order, [{ ...prior, orderId: "ord_other" }]).ok).toBe(false);
    expect(refundableBalance(order, [{ ...prior, amount: { amountMinor: 8_001, currency: "USD" } }]).ok).toBe(false);
    expect(refundableBalance(order, [{ ...prior, amount: { amountMinor: -1, currency: "USD" } }]).ok).toBe(false);
    expect(refundableBalance(order, [{ ...prior, amount: { amountMinor: 1, currency: "EUR" } }])).toMatchObject({ error: { code: "CURRENCY_MISMATCH" } });
  });
  it("exposes the inclusive $100 automatic threshold without converting currencies", () => {
    expect(isWithinAutoRefundLimit({ amountMinor: 10_000, currency: "USD" })).toBe(true);
    for (const amount of [0, -1, 10_001, NaN]) expect(isWithinAutoRefundLimit({ amountMinor: amount, currency: "USD" })).toBe(false);
    expect(isWithinAutoRefundLimit({ amountMinor: 1, currency: "EUR" })).toBe(false);
  });
});

describe("replacement policy", () => {
  it("calculates a multi-product selection from original unit prices and quantities", () => {
    const original: Order = {
      ...order,
      items: [...order.items, { productId: "prd_0002", name: "Clay bowl", quantity: 3, unitPrice: { amountMinor: 1_500, currency: "USD" } }],
      total: { amountMinor: 12_500, currency: "USD" },
    };
    const contents = replacementContents(original, [{ productId: "prd_0002", quantity: 2 }, { productId: "prd_0001", quantity: 1 }]);
    expect(contents).toEqual({ ok: true, value: {
      items: [
        { productId: "prd_0002", name: "Clay bowl", quantity: 2, unitPrice: { amountMinor: 1_500, currency: "USD" } },
        { productId: "prd_0001", name: "Sand mug", quantity: 1, unitPrice: { amountMinor: 4_000, currency: "USD" } },
      ],
      total: { amountMinor: 7_000, currency: "USD" },
    } });
    expect(original.items.map((item) => item.quantity)).toEqual([2, 3]);
    expect(original.total.amountMinor).toBe(12_500);
  });
  it("rejects a replacement whose line value overflows safe integer money", () => {
    const original: Order = { ...order, items: [{ productId: "prd_0001", name: "Mug", quantity: 2, unitPrice: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" } }] };
    expect(replacementContents(original)).toMatchObject({ error: { code: "INVALID_INPUT", field: "amountMinor" } });
  });
  it("rejects overflow when adding individually valid line values", () => {
    const original: Order = { ...order, items: [
      { productId: "prd_0001", name: "Mug", quantity: 1, unitPrice: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" } },
      { productId: "prd_0002", name: "Bowl", quantity: 1, unitPrice: { amountMinor: 1, currency: "USD" } },
    ] };
    expect(replacementContents(original)).toMatchObject({ error: { code: "INVALID_INPUT", field: "amountMinor" } });
  });
  it("rejects line prices in a different currency from the order", () => {
    const original: Order = { ...order, items: [{ productId: "prd_0001", name: "Mug", quantity: 1, unitPrice: { amountMinor: 4_000, currency: "EUR" } }] };
    expect(replacementContents(original)).toMatchObject({ error: { code: "CURRENCY_MISMATCH", expected: "USD", actual: "EUR" } });
  });
});

describe("return and shipment policies", () => {
  it("allows the exact 30-day boundary, rejects the next millisecond", () => {
    const delivered = { ...order, deliveredAt: "2026-10-03T12:00:00.000Z" };
    expect(checkReturnWindow(delivered, "2026-11-02T12:00:00.000Z").ok).toBe(true);
    expect(checkReturnWindow(delivered, "2026-11-02T12:00:00.001Z")).toMatchObject({ error: { code: "RETURN_WINDOW_EXPIRED" } });
    expect(checkReturnWindow(delivered, "2026-10-03T11:59:59.999Z").ok).toBe(false);
    expect(checkReturnWindow({ ...delivered, deliveredAt: "bad" }, "2026-11-02T12:00:00.000Z").ok).toBe(false);
    expect(checkReturnWindow({ ...delivered, deliveredAt: null }, "2026-11-02T12:00:00.000Z")).toMatchObject({ error: { code: "ORDER_NOT_DELIVERED" } });
  });
  it("requires both the order and shipment to be unshipped", () => {
    const unshipped = { ...order, status: "unshipped" as const, deliveredAt: null };
    expect(checkAddressChange(unshipped, null).ok).toBe(true);
    expect(checkAddressChange(unshipped, { ...shipment, status: "pending", shippedAt: null }).ok).toBe(true);
    expect(checkAddressChange(unshipped, shipment)).toMatchObject({ error: { code: "ADDRESS_CHANGE_NOT_ALLOWED" } });
    expect(checkAddressChange(unshipped, { ...shipment, status: "pending" }).ok).toBe(false);
    for (const status of ["shipped", "delivered", "cancelled"] as const) expect(checkAddressChange({ ...order, status }, null).ok).toBe(false);
  });
  it("validates address fields", () => {
    expect(validateAddress(address).ok).toBe(true);
    expect(validateAddress({ ...address, line1: " " }).ok).toBe(false);
    expect(validateAddress({ ...address, countryCode: "USA" }).ok).toBe(false);
  });
});
