import type { JsonObject } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES, ValidateRequestFields, type Order } from "@muscle-memory/shop-domain";
import { describe, expect, it, vi } from "vitest";
import { createShopDemoData } from "../db/shop-demo-data.js";
import { ShopRequestExtractor, requestExtractionFields } from "./shop-request-extractor.js";

const data = createShopDemoData();
const order = data.orders.find((row) => row.id === "ord_1042")!;
const validator = new ValidateRequestFields({
  getCustomer: async (id) => data.customers.find((row) => row.id === id) ?? null,
  getOrder: async (id) => data.orders.find((row) => row.id === id) ?? null,
});
const address = { name: "Demo Recipient", line1: "8 Clay Lane", city: "Portland", region: "OR", postalCode: "97201", countryCode: "US" };
const tokens = { input: 18, output: 9 };
const extract = (output: JsonObject) => {
  const fake = vi.fn(async () => ({ output, tokens }));
  return { extractor: new ShopRequestExtractor({ extract: fake }, validator, order.customerId), fake };
};

describe("shop request extraction mapping (no model/network)", () => {
  it.each([
    { type: "damaged_item", orderId: order.id, productId: order.items[0]!.productId, quantity: 1, description: "Broken handle" },
    { type: "where_is_my_order", orderId: order.id },
    { type: "return", orderId: order.id, reason: "Wrong size" },
    { type: "wholesale_inquiry", company: "Demo Cafe", message: "Quote for 60 mugs" },
  ] satisfies JsonObject[])("validates complete %s fields with one shared TextExtractor call", async (fields) => {
    const { extractor, fake } = extract(fields);
    expect(await extractor.extract("Original message")).toEqual({ fields, tokens });
    expect(fake).toHaveBeenCalledExactlyOnceWith({ text: "Original message", fields: requestExtractionFields });
  });
  it("reconstructs the complete nested address, omitting absent line2", async () => {
    const fields = { type: "address_change", orderId: order.id, ...Object.fromEntries(Object.entries(address).map(([key, value]) => [`address${key[0]!.toUpperCase()}${key.slice(1)}`, value])) };
    expect(await extract(fields).extractor.extract("New address")).toEqual({ fields: { type: "address_change", orderId: order.id, address }, tokens });
    expect(await extract({ ...fields, addressLine2: "Apt 2" }).extractor.extract("New address")).toEqual({ fields: { type: "address_change", orderId: order.id, address: { ...address, line2: "Apt 2" } }, tokens });
  });
  it.each([
    { type: "damaged", orderId: order.id },
    { type: "shipment", orderId: order.id },
    { type: "other" },
    { type: "damaged_item", orderId: order.id },
    { type: "damaged_item", orderId: order.id, productId: order.items[0]!.productId, quantity: 0, description: "Broken" },
    { type: "where_is_my_order", orderId: "ord_1001" },
    { type: "where_is_my_order", orderId: order.id, requestId: "req_injected" },
    { type: "address_change", orderId: order.id, addressLine1: "Incomplete" },
  ] satisfies JsonObject[])("rejects unsupported, incomplete, extra or unowned fields while preserving usage: %j", async (fields) => {
    const { extractor, fake } = extract(fields);
    expect(await extractor.extract("Message")).toEqual({ fields: null, tokens });
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("declares exactly shop-domain categories in the extraction contract", () => {
    for (const type of REQUEST_TYPES) expect(requestExtractionFields.type?.description).toContain(type);
    expect(requestExtractionFields.quantity).toMatchObject({ type: "number", required: false });
  });

  const platterOrder: Order = { ...order, items: [
    { ...order.items[0]!, productId: "prd_0023", name: "Ember Large Serving Platter", quantity: 2 },
    { ...order.items[0]!, productId: "prd_0024", name: "Moss Large Serving Platter", quantity: 3 },
  ] };
  function contextual(output: JsonObject, linkedOrder: Order = platterOrder, orderId: Order["id"] | null = order.id) {
    const shop = {
      getCustomer: async (id: string) => data.customers.find((row) => row.id === id) ?? null,
      getOrder: vi.fn(async (id: string) => id === linkedOrder.id ? linkedOrder : null),
      getProduct: async (id: string) => data.products.find((row) => row.id === id) ?? null,
    };
    const fake = vi.fn(async () => ({ output, tokens }));
    return { extractor: new ShopRequestExtractor({ extract: fake }, new ValidateRequestFields(shop), order.customerId, { orderId, shop }), fake, shop };
  }
  const damage = { type: "damaged_item", orderId: order.id, productId: "prd_0023", quantity: 1, description: "Chipped rim", productMention: "large Ember platters" };
  const message = "Hi, one of the large Ember platters arrived chipped. Could you help?";

  it("offers only linked order lines and validates a natural product mention and word quantity", async () => {
    const { extractor, fake } = contextual(damage);
    const { productMention: _mention, ...fields } = damage;
    expect(await extractor.extract(message)).toEqual({ fields, tokens });
    expect(fake).toHaveBeenCalledExactlyOnceWith({ text: message, fields: requestExtractionFields, context: {
      orderId: order.id, lines: [
        { name: "Ember Large Serving Platter", sku: "KILN-023", productId: "prd_0023", quantity: 2 },
        { name: "Moss Large Serving Platter", sku: "KILN-024", productId: "prd_0024", quantity: 3 },
      ],
    } });
  });

  it("resolves one explicit owned order reference for new unlinked intake", async () => {
    const { extractor, fake, shop } = contextual(damage, platterOrder, null);
    expect((await extractor.extract(`${message} Order ${order.id}.`)).fields).not.toBeNull();
    expect(shop.getOrder).toHaveBeenCalledWith(order.id);
    expect(fake.mock.calls[0]).toEqual([expect.objectContaining({ context: expect.objectContaining({ orderId: order.id }) })]);
  });

  it.each([
    { output: { ...damage, productId: "prd_0001" }, text: message },
    { output: { ...damage, productId: "prd_0024" }, text: message },
    { output: { ...damage, orderId: "ord_1002" }, text: message },
    { output: { ...damage, quantity: 3 }, text: message },
    { output: { ...damage, productMention: "platters" }, text: "One of the platters arrived chipped." },
    { output: damage, text: "One piece arrived chipped." },
    { output: { ...damage, productMention: "" }, text: message },
    { output: { ...damage, productMention: "Ember" }, text: "One piece arrived chipped." },
    { output: { ...damage, productMention: "Ember" }, text: "One piece arrived chipped. Please remember to reply." },
  ])("fails closed for wrong-order IDs, guesses, absent or ambiguous product mentions: %j", async ({ output, text }) => {
    expect(await contextual(output).extractor.extract(text)).toEqual({ fields: null, tokens });
  });

  it("rejects identically named lines even if the model selects one", async () => {
    const sameNames = { ...platterOrder, items: platterOrder.items.map((line) => ({ ...line, name: "Ember Large Serving Platter" })) };
    expect(await contextual(damage, sameNames).extractor.extract(message)).toEqual({ fields: null, tokens });
  });

  it("never offers an unowned order or multiple unlinked order references", async () => {
    for (const [linkedOrder, orderId, text] of [
      [{ ...platterOrder, customerId: "cus_0001" }, order.id, message],
      [platterOrder, null, `Orders ${order.id} and ord_1002: ${message}`],
    ] as const) {
      const { extractor, fake } = contextual({ ...damage, productId: "prd_9999" }, linkedOrder, orderId);
      expect((await extractor.extract(text)).fields).toBeNull();
      expect(fake.mock.calls[0]).toEqual([{ text, fields: requestExtractionFields }]);
    }
  });
});
