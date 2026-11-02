import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, nonEmpty, replySchema, shopErrors, shopResult } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";
import { jsonContainerInput } from "../server/action-input.js";

export default defineAction({
  description: "Store an outbound demo reply to a request using a literal {{variable}} template and variables; this does not deliver external email.",
  schema: z.object({
    requestId: shopId("request").describe('Request ID to reply to, such as req_0007'),
    template: nonEmpty.describe('Reply text with optional literal {{variable}} placeholders; no expressions'),
    variables: jsonContainerInput(z.record(z.string(), z.union([z.string(), z.number()])), "variables").describe('Values for every template placeholder; use {} for plain text'),
  }),
  outputSchema: replySchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  run: traced("send-reply", async (input) => shopResult(getShopUseCases().sendReply.execute(input)), shopTraceCapture),
});
