import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, nonEmpty, requestSchema, shopErrors, shopResult } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: "Add one tag to a support request by requestId; tags are trimmed and duplicates are ignored.",
  schema: z.object({
    requestId: shopId("request").describe('Request ID such as req_0007'),
    tag: nonEmpty.describe('One tag to add; existing identical tags are retained once'),
  }),
  outputSchema: requestSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  run: traced("tag-request", async (input) => shopResult(getShopUseCases().tagRequest.execute(input)), shopTraceCapture),
});
