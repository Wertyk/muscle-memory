import { type ActionDefinition, preparedCallNeedsApproval, actionCallIntent } from "@agent-native/core/action";
import { failure, success, type ShopError } from "@muscle-memory/shop-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import listRequests from "../actions/list-requests.js";
import getRequest from "../actions/get-request.js";
import getRequestActivity from "../actions/get-request-activity.js";
import getOrder from "../actions/get-order.js";
import getCustomer from "../actions/get-customer.js";
import getShipmentStatus from "../actions/get-shipment-status.js";
import issueRefund from "../actions/issue-refund.js";
import sendReply from "../actions/send-reply.js";
import tagRequest from "../actions/tag-request.js";
import setRequestStatus from "../actions/set-request-status.js";
import escalate from "../actions/escalate.js";
import createReplacementOrder from "../actions/create-replacement-order.js";
import updateShippingAddress from "../actions/update-shipping-address.js";
import generateReturnLabel from "../actions/generate-return-label.js";
import * as composition from "./composition.js";
import { createShopDemoData } from "./db/shop-demo-data.js";
import type { CapturedAction } from "./infra/traced.js";

const data = createShopDemoData();
const request = data.requests[0]!;
const order = data.orders[0]!;
const customer = data.customers[0]!;
const shipment = { orderStatus: order.status, shipment: data.shipments[0]! };
const refund = data.refunds[0]!;
const reply = data.replies[0]!;
const label = data.orders.find((item) => item.returnLabel)!.returnLabel!;
const context = { caller: "frontend" as const };
type TestAction = Pick<ActionDefinition<never, unknown>, "run" | "http" | "readOnly" | "outputSchema">;

const cases: Array<{
  name: string;
  action: TestAction;
  key: keyof ReturnType<typeof composition.createShopUseCases>;
  input: object;
  output: unknown;
}> = [
  { name: "list-requests", action: listRequests, key: "listRequests", input: { status: "open", type: "damaged_item", customerId: customer.id, tag: "priority" }, output: [request] },
  { name: "get-request", action: getRequest, key: "getRequest", input: { requestId: request.id }, output: request },
  { name: "get-request-activity", action: getRequestActivity, key: "getRequestActivity", input: { requestId: request.id }, output: [{ id: request.id, at: request.createdAt, kind: "request_received" }] },
  { name: "get-order", action: getOrder, key: "getOrder", input: { orderId: order.id }, output: order },
  { name: "get-customer", action: getCustomer, key: "getCustomer", input: { customerId: customer.id }, output: customer },
  { name: "get-shipment-status", action: getShipmentStatus, key: "getShipmentStatus", input: { orderId: order.id }, output: shipment },
  { name: "issue-refund", action: issueRefund, key: "issueRefund", input: { orderId: order.id, amount: { amountMinor: 500, currency: "USD" }, reason: "Damage" }, output: refund },
  { name: "send-reply", action: sendReply, key: "sendReply", input: { requestId: request.id, template: "Hello {{name}}", variables: { name: "Maya" } }, output: reply },
  { name: "tag-request", action: tagRequest, key: "tagRequest", input: { requestId: request.id, tag: "handled" }, output: request },
  { name: "set-request-status", action: setRequestStatus, key: "setRequestStatus", input: { requestId: request.id, status: "resolved" }, output: request },
  { name: "escalate", action: escalate, key: "escalate", input: { requestId: request.id, reason: "Review" }, output: request },
  { name: "create-replacement-order", action: createReplacementOrder, key: "createReplacementOrder", input: { orderId: order.id, items: [{ productId: order.items[0]!.productId, quantity: 1 }] }, output: order },
  { name: "update-shipping-address", action: updateShippingAddress, key: "updateShippingAddress", input: { orderId: order.id, address: customer.shippingAddress }, output: order },
  { name: "generate-return-label", action: generateReturnLabel, key: "generateReturnLabel", input: { orderId: order.id }, output: label },
];
const executions = Object.fromEntries(cases.map(({ key }) => [key, { execute: vi.fn() }]));
const useCases = executions as unknown as ReturnType<typeof composition.createShopUseCases>;

beforeEach(() => {
  vi.spyOn(composition, "getShopUseCases").mockReturnValue(useCases);
  for (const item of cases) vi.mocked(useCases[item.key].execute).mockResolvedValue(success(item.output) as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("shop action controllers", () => {
  it.each(cases)("$name forwards input to exactly its use-case and unwraps the result", async ({ action, key, input, output }) => {
    expect(await action.run(input as never, context)).toEqual(output);
    expect(useCases[key].execute).toHaveBeenCalledExactlyOnceWith(input);
    for (const other of cases.filter((item) => item.key !== key)) expect(useCases[other.key].execute).not.toHaveBeenCalled();
  });

  it.each(cases.filter(({ action }) => action.readOnly))("$name is a read-only HTTP query", ({ action }) => {
    expect(action.http).toEqual({ method: "GET" });
    expect(action.outputSchema).toBeDefined();
  });

  it.each(cases.filter(({ action }) => !action.readOnly))("$name captures validated input/output with the injected decorator", async ({ action, input, name }) => {
    const steps: CapturedAction[] = [];
    vi.spyOn(composition.shopTraceCapture, "recording").mockResolvedValue({ append: async (step) => { steps.push(step); } });
    composition.shopTraceCapture.navigation = async () => ({ view: "request", requestId: request.id });
    try {
      const output = await action.run(input as never, context);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ actionName: name, input, output, caller: "frontend", navigation: { view: "request", requestId: request.id } });
    } finally { delete composition.shopTraceCapture.navigation; }
  });

  it("leaves capture inactive in the shipped composition", async () => {
    expect(await composition.shopTraceCapture.recording(context)).toBeNull();
    const capture = vi.spyOn(composition.shopTraceCapture, "recording");
    await tagRequest.run({ requestId: request.id, tag: "done" }, context);
    expect(capture).toHaveBeenCalledExactlyOnceWith(context);
  });

  it("maps missing entities into typed failures instead of successful error objects", async () => {
    vi.mocked(useCases.getOrder.execute).mockResolvedValue(failure({ code: "NOT_FOUND", entity: "order", id: "ord_missing" }));
    await expect(getOrder.run({ orderId: "ord_missing" }, context)).rejects.toMatchObject({ errorCode: "NOT_FOUND", statusCode: 404, noWrite: true });
  });

  const policyErrors: ShopError[] = [
    { code: "INVALID_INPUT", field: "amount", message: "Invalid amount" },
    { code: "CURRENCY_MISMATCH", expected: "USD", actual: "EUR" },
    { code: "REFUND_EXCEEDS_BALANCE", availableMinor: 200 },
    { code: "RETURN_WINDOW_EXPIRED", days: 30 },
    { code: "ORDER_NOT_DELIVERED" }, { code: "ORDER_CANCELLED" },
    { code: "ADDRESS_CHANGE_NOT_ALLOWED" }, { code: "MISSING_TEMPLATE_VARIABLE", variable: "name" },
  ];
  it.each(policyErrors)("preserves $code and excludes rejected calls from tracing", async (error) => {
    const append = vi.fn();
    vi.spyOn(composition.shopTraceCapture, "recording").mockResolvedValue({ append });
    composition.shopTraceCapture.navigation = async () => null;
    vi.mocked(useCases.issueRefund.execute).mockResolvedValue(failure(error));
    try {
      await expect(issueRefund.run({ orderId: order.id, reason: "Damage" }, context)).rejects.toMatchObject({ errorCode: error.code, details: error });
      expect(append).not.toHaveBeenCalled();
    } finally { delete composition.shopTraceCapture.navigation; }
  });

  it("propagates infrastructure failures and rejects malformed success output", async () => {
    const failure = new Error("Storage unavailable");
    vi.mocked(useCases.getOrder.execute).mockRejectedValueOnce(failure);
    await expect(getOrder.run({ orderId: order.id }, context)).rejects.toBe(failure);
    vi.mocked(useCases.getOrder.execute).mockResolvedValueOnce(success({ id: order.id }) as never);
    await expect(getOrder.run({ orderId: order.id }, context)).rejects.toMatchObject({ errorCode: "output_contract_violation" });
  });

  it("preserves omitted optional arguments for full refunds and all-line replacements", async () => {
    await listRequests.run({}, context);
    await issueRefund.run({ orderId: order.id, reason: "Full refund" }, context);
    await createReplacementOrder.run({ orderId: order.id }, context);
    expect(useCases.listRequests.execute).toHaveBeenCalledWith({});
    expect(useCases.issueRefund.execute).toHaveBeenCalledWith({ orderId: order.id, reason: "Full refund" });
    expect(useCases.createReplacementOrder.execute).toHaveBeenCalledWith({ orderId: order.id });
  });

  it("distinguishes a missing shipment from a missing order", async () => {
    vi.mocked(useCases.getShipmentStatus.execute).mockResolvedValue(success({ orderStatus: "unshipped", shipment: null }));
    expect(await getShipmentStatus.run({ orderId: order.id }, context)).toEqual({ orderStatus: "unshipped", shipment: null });
  });
});

describe("shop action validation", () => {
  const invalid: Array<[TestAction, object]> = [
    [getRequest, {}], [getRequest, { requestId: "ord_1001" }],
    [getOrder, { orderId: `ord_${"a".repeat(28)}` }], [getOrder, { orderId: "ord_UPPER" }],
    [getCustomer, { customerId: "cus_" }], [getShipmentStatus, { orderId: 1001 }],
    [listRequests, { status: "closed" }], [listRequests, { type: "unknown" }],
    [listRequests, { customerId: "req_0001" }], [listRequests, { tag: " " }],
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100"].map((amountMinor): [TestAction, object] => [issueRefund, { orderId: order.id, amount: { amountMinor, currency: "USD" }, reason: "Damage" }]),
    [issueRefund, { orderId: order.id, amount: { amountMinor: 1, currency: "usd" }, reason: "Damage" }],
    [issueRefund, { orderId: order.id, reason: " " }],
    [sendReply, { requestId: request.id, template: "Hello" }],
    [sendReply, { requestId: request.id, template: "Hello", variables: { value: {} } }],
    [tagRequest, { requestId: request.id, tag: " " }],
    [setRequestStatus, { requestId: request.id, status: "closed" }],
    [escalate, { requestId: request.id, reason: " " }],
    [createReplacementOrder, { orderId: order.id, items: [] }],
    [createReplacementOrder, { orderId: order.id, items: [{ productId: "prd_0001", quantity: 0 }] }],
    [updateShippingAddress, { orderId: order.id, address: { ...customer.shippingAddress, countryCode: "USA" } }],
    [generateReturnLabel, { orderId: "req_0001" }],
  ];
  it.each(invalid)("rejects invalid input before any use-case or capture", async (action, input) => {
    const capture = vi.spyOn(composition.shopTraceCapture, "recording");
    await expect(action.run(input as never, context)).rejects.toThrow("Invalid action parameters");
    for (const item of cases) expect(useCases[item.key].execute).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("refund agent approval", () => {
  it.each([
    [9999, "USD", false], [10000, "USD", false], [10001, "USD", true], [1, "EUR", true],
  ])("gates %i minor units in %s using the domain policy", async (amountMinor, currency, expected) => {
    const prepared = await actionCallIntent(issueRefund, { orderId: order.id, reason: "Damage", amount: { amountMinor, currency } });
    if (!prepared.valid) throw prepared.error;
    expect(await preparedCallNeedsApproval(issueRefund, prepared, { caller: "tool" })).toBe(expected);
    expect(await preparedCallNeedsApproval(issueRefund, prepared, context)).toBe(false);
    expect(useCases.issueRefund.execute).not.toHaveBeenCalled();
  });
  it("requires approval for a remaining-balance refund and leaves frontend calls ungated", async () => {
    const prepared = await actionCallIntent(issueRefund, { orderId: order.id, reason: "Full refund" });
    if (!prepared.valid) throw prepared.error;
    expect(await preparedCallNeedsApproval(issueRefund, prepared, { caller: "tool" })).toBe(true);
    expect(await preparedCallNeedsApproval(issueRefund, prepared, context)).toBe(false);
  });
});
