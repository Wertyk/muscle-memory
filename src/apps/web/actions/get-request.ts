import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { traced } from "../server/infra/traced.js";
import {
  shopId,
  requestSchema,
  shopErrors,
  shopResult,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Read a support request by requestId, including customerId, orderId, original content, status, tags and escalation.",
  schema: z.object({
    requestId: shopId("request").describe("Request ID such as req_0007"),
  }),
  outputSchema: requestSchema,
  errors: shopErrors,
  http: { method: "GET" },
  readOnly: true,
  run: traced(
    "get-request",
    async (input) => shopResult(getShopUseCases().getRequest.execute(input)),
    shopTraceCapture,
  ),
});
