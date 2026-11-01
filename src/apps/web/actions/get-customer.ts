import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { traced } from "../server/infra/traced.js";
import {
  shopId,
  customerSchema,
  shopErrors,
  shopResult,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Read a shop customer by customerId, including name, email and address book entry.",
  schema: z.object({
    customerId: shopId("customer").describe("Customer ID such as cus_0001"),
  }),
  outputSchema: customerSchema,
  errors: shopErrors,
  http: { method: "GET" },
  readOnly: true,
  run: traced(
    "get-customer",
    async (input) => shopResult(getShopUseCases().getCustomer.execute(input)),
    shopTraceCapture,
  ),
});
