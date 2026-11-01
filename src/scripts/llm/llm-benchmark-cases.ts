import { isDeepStrictEqual } from "node:util";

export const candidates = [
  { role: "main", model: "kimi-k3" },
  { role: "main", model: "glm-5.3" },
  { role: "main", model: "deepseek-v4-pro:0813" },
  { role: "main", model: "gpt-oss:120b" },
  { role: "cheap", model: "glm-5.3-flash" },
  { role: "cheap", model: "gpt-oss:20b" },
] as const;

function tool(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: "function",
    function: {
      name, description,
      parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

const string = { type: "string" };
export const tools = [
  tool("lookup_order", "Read an order by ID.", { orderId: string }),
  tool("tag_request", "Add tags to a request.", {
    requestId: string, tags: { type: "array", items: string },
  }),
  tool("issue_refund", "Refund an amount in integer cents.", {
    orderId: string, amountCents: { type: "integer" }, reason: { type: "string", enum: ["damaged", "return"] },
  }),
  tool("send_reply", "Send exact reply text.", { requestId: string, text: string }),
  tool("update_address", "Replace an order's shipping address.", {
    orderId: string,
    address: {
      type: "object", properties: { city: string, postalCode: string },
      required: ["city", "postalCode"], additionalProperties: false,
    },
  }),
];

export const cases = [
  { id: "order", prompt: "Look up order ord_1042.", name: "lookup_order", args: { orderId: "ord_1042" } },
  { id: "order-from-text", prompt: "Customer: 'Where is ord_1099?' Fetch that order.", name: "lookup_order", args: { orderId: "ord_1099" } },
  { id: "tag", prompt: "Tag req_0007 with damaged.", name: "tag_request", args: { requestId: "req_0007", tags: ["damaged"] } },
  { id: "multiple-tags", prompt: "Add tags urgent then return to req_0012, preserving that order.", name: "tag_request", args: { requestId: "req_0012", tags: ["urgent", "return"] } },
  { id: "refund-cents", prompt: "Refund 1250 cents on ord_1042 for damaged goods.", name: "issue_refund", args: { orderId: "ord_1042", amountCents: 1250, reason: "damaged" } },
  { id: "refund-dollars", prompt: "Refund $8.50 on ord_1088 for a return. Use cents.", name: "issue_refund", args: { orderId: "ord_1088", amountCents: 850, reason: "return" } },
  { id: "reply", prompt: "Reply to req_0007 with exactly: Your refund is on its way.", name: "send_reply", args: { requestId: "req_0007", text: "Your refund is on its way." } },
  { id: "reply-escaping", prompt: 'Reply to req_0012 with exactly: We received your "Blue Mug" return.', name: "send_reply", args: { requestId: "req_0012", text: 'We received your "Blue Mug" return.' } },
  { id: "nested-address", prompt: "Set ord_1060 shipping city to Boston and postalCode to 02108. Preserve the leading zero.", name: "update_address", args: { orderId: "ord_1060", address: { city: "Boston", postalCode: "02108" } } },
  { id: "unicode-address", prompt: "Set ord_1077 shipping city to Montréal and postalCode to H2X 1Y4.", name: "update_address", args: { orderId: "ord_1077", address: { city: "Montréal", postalCode: "H2X 1Y4" } } },
];

// Require exactly one real tool call, valid JSON, the right tool and all exact arguments.
// Plain text that merely resembles a call does not pass. No tool ever executes.
export function gradeCalls(value: unknown, expected: (typeof cases)[number]): string {
  if (!Array.isArray(value) || value.length !== 1) return "wrong-call-count";
  const call = value[0];
  if (call?.type !== "function" || call.function?.name !== expected.name) return "wrong-tool";
  try {
    return isDeepStrictEqual(JSON.parse(call.function.arguments), expected.args) ? "pass" : "wrong-arguments";
  } catch {
    return "invalid-arguments-json";
  }
}
