import { describe, expect, it } from "vitest";
import { buildRequestTrigger } from "../index.js";

describe("public request trigger builder", () => {
  it("flattens fields with the same request identity and subject used by intake", () => {
    const fields = { type: "damaged_item", orderId: "ord_1042", productId: "prd_0001", quantity: 1, description: "Broken handle" };
    const context = { requestId: "req_0007", customerId: "cus_0001", subject: "Broken mug" };
    expect(buildRequestTrigger(fields, context)).toEqual({
      type: "damaged_item", orderId: "ord_1042", productId: "prd_0001", quantity: 1, description: "Broken handle",
      requestId: "req_0007", customerId: "cus_0001", subject: "Broken mug",
    });
  });

  it("keeps trusted identity and subject over conflicting customer fields without changing either input", () => {
    const fields = Object.freeze({ type: "where_is_my_order", orderId: "ord_1042", requestId: "req_other", customerId: "cus_other", subject: "Untrusted subject" });
    const context = Object.freeze({ requestId: "req_0007", customerId: "cus_0001", subject: "Delivery update" });
    const trigger = buildRequestTrigger(fields, context);
    expect(trigger).toEqual({ type: "where_is_my_order", orderId: "ord_1042", ...context });
    expect(fields.requestId).toBe("req_other");
    expect(fields.customerId).toBe("cus_other");
    expect(fields.subject).toBe("Untrusted subject");
    expect(trigger).not.toBe(fields);
    expect(trigger).not.toBe(context);
    expect(buildRequestTrigger({}, context)).toEqual(context);
  });
});
