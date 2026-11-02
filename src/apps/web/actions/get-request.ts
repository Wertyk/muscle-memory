import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getShopUseCases, shopTraceCapture, readCorrections } from "../server/composition.js";
import { traced } from "../server/infra/traced.js";
import {
  shopId,
  requestSchema,
  shopErrors,
  shopResult,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Read a support request by requestId, including customerId, orderId, original content, status, tags, escalation and scoped correction evidence (run, version, step, new inputs and proposal decision).",
  schema: z.object({
    requestId: shopId("request").describe("Request ID such as req_0007"),
  }),
  outputSchema: requestSchema.extend({ corrections: z.array(z.unknown()).optional() }),
  errors: shopErrors,
  http: { method: "GET" },
  readOnly: true,
  run: traced(
    "get-request",
    async (input, context) => {
      const request = await shopResult(getShopUseCases().getRequest.execute(input));
      const corrections = await readCorrections(context, input);
      return corrections.length ? { ...request, corrections } : request;
    },
    shopTraceCapture,
  ),
});
