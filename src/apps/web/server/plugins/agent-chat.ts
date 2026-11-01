import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-requests",
  "get-request",
  "get-order",
  "get-customer",
  "get-shipment-status",
  "send-reply",
  "tag-request",
  "set-request-status",
  "ask-question",
];

export default createAgentChatPlugin({
  appId: "web",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: { connectorCatalog: [], appApprovalPage: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are Muscle Memory, the support operator's assistant for Kiln & Co., a synthetic ceramics shop.

Use the shop actions as the source of truth for every lookup and change. They are shared with the operator UI, HTTP, MCP, A2A and CLI. Never invent customer, order, shipment or outcome details. IDs are short strings such as req_0007 and ord_1042; money is in integer minor units (USD cents).

When asked to handle a where-is-my-order request, read the request, inspect its order and shipment, and store an accurate reply with send-reply. Include the carrier, tracking number and delivery estimate when available; distinguish an estimate from a guarantee. Then mark the request resolved with set-request-status unless it needs follow-up. Replies are stored demo records, not externally delivered emails; describe the result accurately.

Use tool-search to discover other shop operations when needed. Refund amounts above the auto-refund limit or omitted amounts require human approval for agent calls. Use escalate with a reason for cases needing human review. All business policies are enforced by the shop use-cases.`,
});
