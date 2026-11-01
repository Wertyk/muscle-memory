import { defineAction } from "@agent-native/core/action";
import { REQUEST_TYPES } from "@muscle-memory/shop-domain";
import { z } from "zod";

import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { traced } from "../server/infra/traced.js";
import {
  requestStatusSchema,
  shopId,
  nonEmpty,
  requestSchema,
  shopErrors,
  shopResult,
  definedFields,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "List shop support requests; combine optional status, type, customerId and exact tag filters. Read a request before handling it.",
  schema: z.object({
    status: requestStatusSchema
      .optional()
      .describe(
        "Filter open, pending, resolved or escalated; omit for all statuses",
      ),
    type: z
      .enum(REQUEST_TYPES)
      .optional()
      .describe(
        "Filter damaged_item, where_is_my_order, return, address_change or wholesale_inquiry; omit for all categories",
      ),
    customerId: shopId("customer")
      .optional()
      .describe("Customer ID such as cus_0001; omit for all customers"),
    tag: nonEmpty.optional().describe("Exact tag filter; omit for all tags"),
  }),
  outputSchema: z.array(requestSchema).readonly(),
  errors: shopErrors,
  http: { method: "GET" },
  readOnly: true,
  run: traced(
    "list-requests",
    async (input) =>
      shopResult(getShopUseCases().listRequests.execute(definedFields(input))),
    shopTraceCapture,
  ),
});
