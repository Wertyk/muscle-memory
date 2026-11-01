import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getShopUseCases } from "../server/composition.js";
import {
  requestActivitySchema,
  shopErrors,
  shopId,
  shopResult,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Read persisted activity for a support request and its linked order: reply excerpts, refunds, replacements, return labels and recorded request state, newest first.",
  schema: z.object({
    requestId: shopId("request").describe("Request ID such as req_0007"),
  }),
  outputSchema: z.array(requestActivitySchema).readonly(),
  readOnly: true,
  http: { method: "GET" },
  errors: shopErrors,
  run: async (input) =>
    shopResult(getShopUseCases().getRequestActivity.execute(input)),
});
