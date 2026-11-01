import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { traced } from "../server/infra/traced.js";
import {
  shopId,
  orderSchema,
  shopErrors,
  shopResult,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Read an order by orderId, including purchased items, prices, payment, shipping address and any return label.",
  schema: z.object({
    orderId: shopId("order").describe("Order ID such as ord_1042"),
  }),
  outputSchema: orderSchema,
  errors: shopErrors,
  http: { method: "GET" },
  readOnly: true,
  run: traced(
    "get-order",
    async (input) => shopResult(getShopUseCases().getOrder.execute(input)),
    shopTraceCapture,
  ),
});
