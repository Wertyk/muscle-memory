import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, requestStatusSchema, requestSchema, shopErrors, shopResult } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: "Set a request to open, pending or resolved after handling it; use escalate for a first escalation with a reason. Escalation history is preserved.",
  schema: z.object({
    requestId: shopId("request").describe('Request ID such as req_0007'),
    status: requestStatusSchema.describe('New status: open, pending, resolved, or escalated only if an escalation reason was already recorded'),
  }),
  outputSchema: requestSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  run: traced("set-request-status", async (input) => shopResult(getShopUseCases().setRequestStatus.execute(input)), shopTraceCapture),
});
