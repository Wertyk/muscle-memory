import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, addressSchema, orderSchema, shopErrors, shopResult } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: "Change an order shipping address before dispatch only; leaves the customer address book unchanged.",
  schema: z.object({
    orderId: shopId("order").describe('Order ID such as ord_1042'),
    address: addressSchema.describe('Complete replacement shipping address'),
  }),
  outputSchema: orderSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  run: traced("update-shipping-address", async (input) => shopResult(getShopUseCases().updateShippingAddress.execute(input)), shopTraceCapture),
});
