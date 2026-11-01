import { describe, expect, it } from "vitest";
import {
  CreateReplacementOrder, Escalate, GenerateReturnLabel, GetCustomer, GetOrder, GetRequest,
  GetShipmentStatus, IssueRefund, ListRequests, SendReply, SetRequestStatus, TagRequest, UpdateShippingAddress,
} from "./use-cases.js";
import { renderReplyTemplate } from "./templates.js";
import type { Order, ReplacementItemSelection, Request, Result } from "../domain/index.js";
import { address, customer, order, request, setup, shipment } from "../../test/fakes.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("request and order queries", () => {
  it("lists all requests and passes combined status/type/customer/tag filters", async () => {
    const { shop } = setup();
    const email: Request = { ...request, id: "req_0008", tags: ["damage"], content: { source: "free_text", type: "damaged_item", text: "My mug broke" } };
    const wholesale: Request = { ...request, id: "req_0009", orderId: null, status: "pending", content: { source: "structured", fields: { type: "wholesale_inquiry", company: "Cafe", message: "50 mugs?" } } };
    const unclassified: Request = { ...request, id: "req_0010", content: { source: "free_text", type: null, text: "Hello" } };
    shop.requests.set(email.id, email);
    shop.requests.set(wholesale.id, wholesale);
    shop.requests.set(unclassified.id, unclassified);
    const query = new ListRequests(shop);
    expect(value(await query.execute())).toHaveLength(4);
    expect(value(await query.execute({ type: "damaged_item" })).map((entry) => entry.id)).toEqual([request.id, email.id]);
    expect(value(await query.execute({ status: "open", type: "damaged_item", customerId: customer.id, tag: "damage" }))).toEqual([email]);
    expect(value(await query.execute({ status: "pending" }))).toEqual([wholesale]);
    expect(value(await query.execute({ customerId: "cus_unknown" }))).toEqual([]);
    expect(value(await query.execute({ tag: "missing" }))).toEqual([]);
  });
  it("gets the request, order and customer snapshots", async () => {
    const { shop } = setup();
    expect(value(await new GetRequest(shop).execute({ requestId: request.id }))).toEqual(request);
    expect(value(await new GetOrder(shop).execute({ orderId: order.id }))).toEqual(order);
    expect(value(await new GetCustomer(shop).execute({ customerId: customer.id }))).toEqual(customer);
  });
  it("returns typed not-found errors for each query", async () => {
    const { shop } = setup();
    expect(await new GetRequest(shop).execute({ requestId: "req_missing" })).toEqual({ ok: false, error: { code: "NOT_FOUND", entity: "request", id: "req_missing" } });
    expect(await new GetOrder(shop).execute({ orderId: "ord_missing" })).toMatchObject({ error: { code: "NOT_FOUND", entity: "order" } });
    expect(await new GetCustomer(shop).execute({ customerId: "cus_missing" })).toMatchObject({ error: { code: "NOT_FOUND", entity: "customer" } });
    expect(await new GetShipmentStatus(shop).execute({ orderId: "ord_missing" })).toMatchObject({ error: { code: "NOT_FOUND", entity: "order" } });
  });
  it("distinguishes an unshipped order with no shipment from a missing order", async () => {
    const { shop } = setup();
    expect(value(await new GetShipmentStatus(shop).execute({ orderId: order.id }))).toEqual({ orderStatus: "delivered", shipment });
    shop.shipments.clear();
    shop.orders.set(order.id, { ...order, status: "unshipped", deliveredAt: null });
    expect(value(await new GetShipmentStatus(shop).execute({ orderId: order.id }))).toEqual({ orderStatus: "unshipped", shipment: null });
  });
});

describe("IssueRefund", () => {
  it("issues a partial refund followed by the full remaining balance", async () => {
    const deps = setup();
    const useCase = new IssueRefund(deps);
    const partial = value(await useCase.execute({ orderId: order.id, amount: { amountMinor: 2_000, currency: "USD" }, reason: " Damage " }));
    expect(partial).toEqual({ id: "ref_101", orderId: order.id, amount: { amountMinor: 2_000, currency: "USD" }, reason: "Damage", createdAt: deps.clock.now() });
    const full = value(await useCase.execute({ orderId: order.id, reason: "Rest of order" }));
    expect(full.amount.amountMinor).toBe(6_000);
    expect(deps.shop.refunds).toEqual([partial, full]);
    const rejected = await useCase.execute({ orderId: order.id, amount: { amountMinor: 1, currency: "USD" }, reason: "Again" });
    expect(rejected).toMatchObject({ error: { code: "REFUND_EXCEEDS_BALANCE", availableMinor: 0 } });
    expect(deps.shop.refunds).toHaveLength(2);
  });
  it("uses paid rather than catalog total and ignores other orders' refunds", async () => {
    const deps = setup();
    deps.shop.orders.set(order.id, { ...order, paid: { amountMinor: 5_000, currency: "USD" } });
    deps.shop.refunds.push({ id: "ref_other", orderId: "ord_other", amount: { amountMinor: 4_000, currency: "USD" }, reason: "Other", createdAt: deps.clock.now() });
    expect(value(await new IssueRefund(deps).execute({ orderId: order.id, reason: "Full" })).amount.amountMinor).toBe(5_000);
  });
  it.each([
    { amount: { amountMinor: -1, currency: "USD" }, code: "INVALID_INPUT" },
    { amount: { amountMinor: 0, currency: "USD" }, code: "INVALID_INPUT" },
    { amount: { amountMinor: 1.5, currency: "USD" }, code: "INVALID_INPUT" },
    { amount: { amountMinor: 8_001, currency: "USD" }, code: "REFUND_EXCEEDS_BALANCE" },
    { amount: { amountMinor: 1, currency: "EUR" }, code: "CURRENCY_MISMATCH" },
  ])("rejects invalid or excessive refund $amount", async ({ amount, code }) => {
    const deps = setup();
    expect(await new IssueRefund(deps).execute({ orderId: order.id, amount, reason: "Damage" })).toMatchObject({ ok: false, error: { code } });
    expect(deps.shop.refunds).toEqual([]);
  });
  it("rejects a blank reason and a zero remaining full refund", async () => {
    const deps = setup();
    const useCase = new IssueRefund(deps);
    expect(await useCase.execute({ orderId: order.id, reason: " " })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    value(await useCase.execute({ orderId: order.id, reason: "Full" }));
    expect(await useCase.execute({ orderId: order.id, reason: "Again" })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(deps.shop.refunds).toHaveLength(1);
  });
  it("keeps approval policy in the caller rather than blocking a valid manual refund", async () => {
    const deps = setup();
    deps.shop.orders.set(order.id, { ...order, paid: { amountMinor: 20_000, currency: "USD" }, total: { amountMinor: 20_000, currency: "USD" } });
    expect(value(await new IssueRefund(deps).execute({ orderId: order.id, reason: "Full" })).amount.amountMinor).toBe(20_000);
  });
  it("serializes competing refunds so their sum cannot exceed payment", async () => {
    const deps = setup();
    const useCase = new IssueRefund(deps);
    const results = await Promise.all([1, 2].map(() => useCase.execute({ orderId: order.id, amount: { amountMinor: 5_000, currency: "USD" }, reason: "Damage" })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: "REFUND_EXCEEDS_BALANCE", availableMinor: 3_000 } });
    expect(deps.shop.refunds).toHaveLength(1);
  });
  it("rolls back a failed persistence write and surfaces infrastructure failure", async () => {
    const deps = setup();
    deps.shop.createRefund = async (refund) => { deps.shop.refunds.push(refund); throw new Error("Storage unavailable"); };
    await expect(new IssueRefund(deps).execute({ orderId: order.id, reason: "Damage" })).rejects.toThrow("Storage unavailable");
    expect(deps.shop.refunds).toEqual([]);
  });
});

describe("SendReply", () => {
  it("renders and stores a reply using the request customer's address", async () => {
    const deps = setup();
    const reply = value(await new SendReply(deps).execute({ requestId: request.id, template: "Hi {{name}}, we refunded {{amount}}. Thanks, {{ name }}.", variables: { name: customer.name, amount: 20 } }));
    expect(reply).toMatchObject({ id: "rpl_101", requestId: request.id, to: customer.email, customerId: customer.id, body: "Hi Avery Reed, we refunded 20. Thanks, Avery Reed.", createdAt: deps.clock.now() });
    expect(deps.shop.replies).toEqual([reply]);
  });
  it("does not recursively interpolate or interpret variable values", () => {
    expect(value(renderReplyTemplate("{{name}} {{amount}}", { name: "$& {{other}}", amount: 0 }))).toBe("$& {{other}} 0");
    expect(value(renderReplyTemplate("A literal reply", {}))).toBe("A literal reply");
  });
  it.each<{ template: string; variables: Readonly<Record<string, string | number>>; code: string }>([
    { template: "Hi {{missing}}", variables: {}, code: "MISSING_TEMPLATE_VARIABLE" },
    { template: "Hi {{toString}}", variables: {}, code: "MISSING_TEMPLATE_VARIABLE" },
    { template: "Hi {{name.first}}", variables: {}, code: "INVALID_INPUT" },
    { template: "Hi {{name", variables: {}, code: "INVALID_INPUT" },
    { template: " ", variables: {}, code: "INVALID_INPUT" },
    { template: "Hi {{amount}}", variables: { amount: Infinity }, code: "INVALID_INPUT" },
  ])("rejects invalid template $template without sending", async ({ template, variables, code }) => {
    const deps = setup();
    expect(await new SendReply(deps).execute({ requestId: request.id, template, variables })).toMatchObject({ error: { code } });
    expect(deps.shop.replies).toEqual([]);
  });
  it("rejects a request whose customer cannot be found", async () => {
    const deps = setup();
    deps.shop.customers.clear();
    expect(await new SendReply(deps).execute({ requestId: request.id, template: "Hi", variables: {} })).toMatchObject({ error: { code: "NOT_FOUND", entity: "customer" } });
    expect(deps.shop.replies).toEqual([]);
  });
});

describe("request mutations", () => {
  it("adds a tag once, preserving existing tags and the stored source snapshot", async () => {
    const deps = setup();
    const original = await deps.shop.getRequest(request.id);
    const useCase = new TagRequest(deps);
    value(await useCase.execute({ requestId: request.id, tag: " damage " }));
    const tagged = value(await useCase.execute({ requestId: request.id, tag: "damage" }));
    expect(tagged.tags).toEqual(["damage"]);
    expect(tagged.updatedAt).toBe(deps.clock.now());
    expect(await deps.shop.getRequest(request.id)).toEqual(tagged);
    expect(original).toEqual(request);
    expect(await useCase.execute({ requestId: request.id, tag: " " })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await deps.shop.getRequest(request.id)).toEqual(tagged);
  });
  it("sets each regular status and rejects invalid or unreasoned escalation", async () => {
    const deps = setup();
    const useCase = new SetRequestStatus(deps);
    for (const status of ["pending", "resolved", "open"] as const) {
      const updated = value(await useCase.execute({ requestId: request.id, status }));
      expect(updated.status).toBe(status);
      expect(await deps.shop.getRequest(request.id)).toEqual(updated);
    }
    expect(await useCase.execute({ requestId: request.id, status: "escalated" })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await useCase.execute({ requestId: request.id, status: "invalid" as "open" })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect((await deps.shop.getRequest(request.id))?.status).toBe("open");
  });
  it("records a human handoff reason and timestamp, then allows resolving it", async () => {
    const deps = setup();
    const useCase = new Escalate(deps);
    expect(await useCase.execute({ requestId: request.id, reason: " " })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    const escalated = value(await useCase.execute({ requestId: request.id, reason: " Wholesale review " }));
    expect(escalated).toMatchObject({ status: "escalated", escalation: { reason: "Wholesale review", escalatedAt: deps.clock.now() }, updatedAt: deps.clock.now() });
    expect(await deps.shop.getRequest(request.id)).toEqual(escalated);
    expect(value(await new SetRequestStatus(deps).execute({ requestId: request.id, status: "resolved" })).status).toBe("resolved");
  });
});

describe("CreateReplacementOrder", () => {
  const mixedOrder: Order = {
    ...order,
    items: [...order.items, { productId: "prd_0002", name: "Clay bowl", quantity: 3, unitPrice: { amountMinor: 1_500, currency: "USD" } }],
    total: { amountMinor: 12_500, currency: "USD" },
  };
  it("defaults to all original lines in a new unshipped, no-charge order", async () => {
    const deps = setup();
    deps.shop.orders.set(order.id, mixedOrder);
    const replacement = value(await new CreateReplacementOrder(deps).execute({ orderId: order.id }));
    expect(replacement).toEqual({ ...mixedOrder, id: "ord_1043", status: "unshipped", paid: { amountMinor: 0, currency: "USD" }, createdAt: deps.clock.now(), deliveredAt: null, replacementForOrderId: order.id });
    expect(await deps.shop.getOrder(replacement.id)).toEqual(replacement);
    expect(await deps.shop.getOrder(order.id)).toEqual(mixedOrder);
    expect(await new IssueRefund(deps).execute({ orderId: replacement.id, amount: { amountMinor: 1, currency: "USD" }, reason: "Damage" })).toMatchObject({ error: { code: "REFUND_EXCEEDS_BALANCE" } });
  });
  it("replaces one broken mug while leaving other mugs and products out", async () => {
    const deps = setup();
    deps.shop.orders.set(order.id, mixedOrder);
    const replacement = value(await new CreateReplacementOrder(deps).execute({ orderId: order.id, items: [{ productId: "prd_0001", quantity: 1 }] }));
    expect(replacement).toEqual({
      ...mixedOrder, id: "ord_1043", status: "unshipped", paid: { amountMinor: 0, currency: "USD" },
      items: [{ productId: "prd_0001", name: "Sand mug", quantity: 1, unitPrice: { amountMinor: 4_000, currency: "USD" } }],
      total: { amountMinor: 4_000, currency: "USD" }, createdAt: deps.clock.now(), deliveredAt: null, replacementForOrderId: order.id,
    });
    expect(await deps.shop.getOrder(replacement.id)).toEqual(replacement);
    expect(await deps.shop.getOrder(order.id)).toEqual(mixedOrder);
  });
  it.each<{ name: string; items: readonly ReplacementItemSelection[]; field: string }>([
    { name: "unknown product", items: [{ productId: "prd_unknown", quantity: 1 }], field: "items.productId" },
    { name: "excessive quantity", items: [{ productId: "prd_0001", quantity: 3 }], field: "items.quantity" },
    { name: "duplicate lines", items: [{ productId: "prd_0001", quantity: 1 }, { productId: "prd_0001", quantity: 1 }], field: "items.productId" },
    { name: "empty selection", items: [], field: "items" },
  ])("rejects $name without creating a replacement", async ({ items, field }) => {
    const deps = setup();
    expect(await new CreateReplacementOrder(deps).execute({ orderId: order.id, items })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", field } });
    expect([...deps.shop.orders.values()]).toEqual([order]);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s without writes", async (quantity) => {
    const deps = setup();
    expect(await new CreateReplacementOrder(deps).execute({ orderId: order.id, items: [{ productId: "prd_0001", quantity }] })).toMatchObject({ error: { code: "INVALID_INPUT", field: "items.quantity" } });
    expect([...deps.shop.orders.values()]).toEqual([order]);
  });
  it("rejects cancelled originals with a typed error for both full and subset replacements", async () => {
    const deps = setup();
    const cancelled: Order = { ...order, status: "cancelled" };
    deps.shop.orders.set(order.id, cancelled);
    const useCase = new CreateReplacementOrder(deps);
    expect(await useCase.execute({ orderId: order.id })).toEqual({ ok: false, error: { code: "ORDER_CANCELLED" } });
    expect(await useCase.execute({ orderId: order.id, items: [{ productId: "prd_0001", quantity: 1 }] })).toEqual({ ok: false, error: { code: "ORDER_CANCELLED" } });
    expect([...deps.shop.orders.values()]).toEqual([cancelled]);
  });
});

describe("UpdateShippingAddress", () => {
  it.each([false, true])("updates an unshipped order (pending shipment: %s)", async (pendingShipment) => {
    const deps = setup();
    deps.shop.orders.set(order.id, { ...order, status: "unshipped", deliveredAt: null });
    if (pendingShipment) deps.shop.shipments.set(order.id, { ...shipment, status: "pending", shippedAt: null, deliveredAt: null });
    else deps.shop.shipments.clear();
    const newAddress = { ...address, line1: "34 New Street" };
    const updated = value(await new UpdateShippingAddress(deps).execute({ orderId: order.id, address: newAddress }));
    expect(updated.shippingAddress).toEqual(newAddress);
    expect(await deps.shop.getOrder(order.id)).toEqual(updated);
    expect((await deps.shop.getCustomer(customer.id))?.shippingAddress).toEqual(address);
  });
  it("rejects shipped orders and stale unshipped statuses with an in-flight shipment", async () => {
    const deps = setup();
    const useCase = new UpdateShippingAddress(deps);
    expect(await useCase.execute({ orderId: order.id, address: { ...address, line1: "34 New Street" } })).toMatchObject({ error: { code: "ADDRESS_CHANGE_NOT_ALLOWED" } });
    expect(await deps.shop.getOrder(order.id)).toEqual(order);
    deps.shop.orders.set(order.id, { ...order, status: "unshipped" });
    expect(await useCase.execute({ orderId: order.id, address })).toMatchObject({ error: { code: "ADDRESS_CHANGE_NOT_ALLOWED" } });
  });
  it("rejects incomplete addresses without mutation", async () => {
    const deps = setup();
    const before = { ...order, status: "unshipped" as const, deliveredAt: null };
    deps.shop.orders.set(order.id, before);
    deps.shop.shipments.clear();
    expect(await new UpdateShippingAddress(deps).execute({ orderId: order.id, address: { ...address, postalCode: "" } })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await deps.shop.getOrder(order.id)).toEqual(before);
  });
});

describe("GenerateReturnLabel", () => {
  it("persists a label at the 30-day boundary and reuses it on repeat calls", async () => {
    const deps = setup();
    deps.shop.orders.set(order.id, { ...order, deliveredAt: "2026-10-03T12:00:00.000Z" });
    const useCase = new GenerateReturnLabel(deps);
    const label = value(await useCase.execute({ orderId: order.id }));
    expect(label).toEqual({ id: "lbl_101", orderId: order.id, createdAt: deps.clock.now(), fromAddress: address });
    expect((await deps.shop.getOrder(order.id))?.returnLabel).toEqual(label);
    deps.clock.timestamp = "2026-11-03T12:00:00.000Z";
    expect(value(await useCase.execute({ orderId: order.id }))).toEqual(label);
  });
  it.each([
    { status: "delivered" as const, deliveredAt: "2026-10-03T11:59:59.999Z", code: "RETURN_WINDOW_EXPIRED" },
    { status: "unshipped" as const, deliveredAt: null, code: "ORDER_NOT_DELIVERED" },
    { status: "delivered" as const, deliveredAt: "2026-11-03T12:00:00.000Z", code: "INVALID_INPUT" },
  ])("rejects ineligible order $status / $deliveredAt", async ({ status, deliveredAt, code }) => {
    const deps = setup();
    const before = { ...order, status, deliveredAt };
    deps.shop.orders.set(order.id, before);
    expect(await new GenerateReturnLabel(deps).execute({ orderId: order.id })).toMatchObject({ error: { code } });
    expect(await deps.shop.getOrder(order.id)).toEqual(before);
  });
});

describe("mutation failures", () => {
  it("returns not-found errors from every mutating use-case without writes", async () => {
    const deps = setup();
    const results = [
      await new IssueRefund(deps).execute({ orderId: "ord_missing", reason: "Damage" }),
      await new CreateReplacementOrder(deps).execute({ orderId: "ord_missing" }),
      await new UpdateShippingAddress(deps).execute({ orderId: "ord_missing", address }),
      await new GenerateReturnLabel(deps).execute({ orderId: "ord_missing" }),
      await new SendReply(deps).execute({ requestId: "req_missing", template: "Hi", variables: {} }),
      await new TagRequest(deps).execute({ requestId: "req_missing", tag: "damage" }),
      await new SetRequestStatus(deps).execute({ requestId: "req_missing", status: "resolved" }),
      await new Escalate(deps).execute({ requestId: "req_missing", reason: "Review" }),
    ];
    for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(deps.shop.refunds).toEqual([]);
    expect(deps.shop.replies).toEqual([]);
    expect([...deps.shop.orders.values()]).toEqual([order]);
    expect([...deps.shop.requests.values()]).toEqual([request]);
  });
  it("rejects long/incorrect generated IDs before persisting records", async () => {
    const deps = setup();
    const invalid = { ...deps, ids: { next: () => "00000000-0000-0000-0000-000000000000" } };
    deps.shop.nextSequentialId = async () => "00000000-0000-0000-0000-000000000000";
    for (const result of [
      await new IssueRefund(invalid).execute({ orderId: order.id, reason: "Damage" }),
      await new SendReply(invalid).execute({ requestId: request.id, template: "Hi", variables: {} }),
      await new CreateReplacementOrder(invalid).execute({ orderId: order.id }),
      await new GenerateReturnLabel(invalid).execute({ orderId: order.id }),
    ]) expect(result).toMatchObject({ error: { code: "INVALID_INPUT", field: "id" } });
    expect(deps.shop.orders.size).toBe(1);
    expect(deps.shop.refunds).toEqual([]);
    expect(deps.shop.replies).toEqual([]);
    expect((await deps.shop.getOrder(order.id))?.returnLabel).toBeNull();
  });
  it("rejects invalid injected clock values without writes", async () => {
    const deps = setup();
    deps.clock.timestamp = "invalid";
    for (const result of [
      await new IssueRefund(deps).execute({ orderId: order.id, reason: "Damage" }),
      await new SendReply(deps).execute({ requestId: request.id, template: "Hi", variables: {} }),
      await new CreateReplacementOrder(deps).execute({ orderId: order.id }),
      await new GenerateReturnLabel(deps).execute({ orderId: order.id }),
      await new TagRequest(deps).execute({ requestId: request.id, tag: "damage" }),
    ]) expect(result).toMatchObject({ error: { code: "INVALID_INPUT", field: "clock" } });
    expect(deps.shop.refunds).toEqual([]);
    expect(deps.shop.replies).toEqual([]);
    expect([...deps.shop.requests.values()]).toEqual([request]);
    expect([...deps.shop.orders.values()]).toEqual([order]);
  });
});
