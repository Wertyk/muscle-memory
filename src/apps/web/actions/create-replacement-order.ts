import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, orderSchema, shopErrors, shopResult, definedFields } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";
import { jsonContainerInput } from "../server/action-input.js";

export default defineAction({
  description: "Create an unshipped replacement at no extra charge for orderId; optional items select original products and quantities, otherwise all lines are replaced.",
  schema: z.object({
    orderId: shopId("order").describe('Original order ID such as ord_1042'),
    items: jsonContainerInput(z.array(z.object({ productId: shopId("product").describe('Product ID from the original order'), quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('Quantity no greater than the original line quantity') })).min(1), "items", "array").optional().describe('Original products to replace without duplicates; omit to replace all original lines'),
  }),
  outputSchema: orderSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  run: traced("create-replacement-order", async (input) => shopResult(getShopUseCases().createReplacementOrder.execute(definedFields(input))), shopTraceCapture),
});
