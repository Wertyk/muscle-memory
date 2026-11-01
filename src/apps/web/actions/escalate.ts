import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, nonEmpty, requestSchema, shopErrors, shopResult } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: "Escalate a support request by requestId with a reason for human review; records escalation history and sets status escalated.",
  schema: z.object({
    requestId: shopId("request").describe('Request ID such as req_0007'),
    reason: nonEmpty.describe('Reason a human needs to review this request'),
  }),
  outputSchema: requestSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  run: traced("escalate", async (input) => shopResult(getShopUseCases().escalate.execute(input)), shopTraceCapture),
});
