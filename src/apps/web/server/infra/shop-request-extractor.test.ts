import type { JsonObject } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES, ValidateRequestFields } from "@muscle-memory/shop-domain";
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
});
