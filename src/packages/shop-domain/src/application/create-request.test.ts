import { describe, expect, it, vi } from "vitest";
import { CreateRequest, ValidateRequestFields, type CreateRequestInput } from "./create-request.js";
import { setup, customer, order, request, address } from "../../test/fakes.js";

const input = (): CreateRequestInput => ({ customerId: customer.id, subject: "New request", content: request.content.source === "structured" ? request.content : { source: "free_text", text: "Hi" } });

describe("shop request intake", () => {
  it("creates a detached open structured request, linked to its customer's order", async () => {
    const deps = setup();
    const result = await new CreateRequest(deps).execute(input());
    expect(result).toMatchObject({ ok: true, value: { id: "req_0008", customerId: customer.id, orderId: order.id, status: "open", tags: [], escalation: null } });
    expect(deps.shop.requests.size).toBe(2);
  });
  it("keeps free text unclassified until extraction", async () => {
    const result = await new CreateRequest(setup()).execute({ customerId: customer.id, subject: "Hi", content: { source: "free_text", text: "Hello" } });
    expect(result).toMatchObject({ ok: true, value: { orderId: null, content: { source: "free_text", type: null, text: "Hello" } } });
  });
  it.each([
    { type: "where_is_my_order", orderId: "ord_missing" },
    { type: "damaged_item", orderId: order.id, productId: "prd_other", quantity: 1, description: "Broken" },
    { type: "damaged_item", orderId: order.id, productId: order.items[0]!.productId, quantity: 3, description: "Broken" },
    { type: "damaged_item", orderId: order.id },
    { type: "address_change", orderId: order.id, address: { ...address, city: "" } },
  ])("rejects invalid or unowned fields without inserting a request: %j", async (fields) => {
    const deps = setup();
    const value = { ...input(), content: { source: "structured", fields } } as CreateRequestInput;
    expect((await new CreateRequest(deps).execute(value)).ok).toBe(false);
    expect(deps.shop.requests.size).toBe(1);
  });
  it("does not let another customer access an order, including extracted fields", async () => {
    const deps = setup();
    deps.shop.customers.set("cus_other", { ...customer, id: "cus_other" });
    const result = await new ValidateRequestFields(deps.shop).execute({ customerId: "cus_other", fields: { type: "where_is_my_order", orderId: order.id } });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND", entity: "order" } });
  });
  it("validates address requests and unknown customers; refuses duplicate generated IDs", async () => {
    const deps = setup();
    const create = new CreateRequest(deps);
    expect((await create.execute({ customerId: "cus_missing", subject: "Hi", content: { source: "free_text", text: "Hi" } })).ok).toBe(false);
    expect((await create.execute({ ...input(), content: { source: "structured", fields: { type: "address_change", orderId: order.id, address } } })).ok).toBe(true);
    vi.spyOn(deps.shop, "nextSequentialId").mockResolvedValue(request.id);
    await expect(create.execute(input())).rejects.toThrow("Duplicate request ID");
    expect(deps.shop.requests.size).toBe(2);
  });
  it("allocates readable IDs in the transaction without using the random ID port", async () => {
    const deps = setup();
    const next = vi.spyOn(deps.ids, "next");
    const create = new CreateRequest(deps);
    const results = await Promise.all(Array.from({ length: 6 }, () => create.execute(input())));
    expect(results.map(result => result.ok ? result.value.id : null)).toEqual([
      "req_0008", "req_0009", "req_0010", "req_0011", "req_0012", "req_0013",
    ]);
    expect(next).not.toHaveBeenCalled();
  });
  it.each(["ord_1001", `req_${"9".repeat(28)}`])("rejects an invalid allocated request ID %s", async (id) => {
    const deps = setup();
    vi.spyOn(deps.shop, "nextSequentialId").mockResolvedValue(id);
    expect(await new CreateRequest(deps).execute(input())).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", field: "id" } });
    expect(deps.shop.requests.size).toBe(1);
  });
});
