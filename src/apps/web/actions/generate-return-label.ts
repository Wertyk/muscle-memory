import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, returnLabelSchema, shopErrors, shopResult } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: "Generate a synthetic demo return label for orderId within 30 days of delivery; repeat calls return the existing label. No carrier purchase occurs.",
  schema: z.object({
    orderId: shopId("order").describe('Delivered order ID such as ord_1042'),
  }),
  outputSchema: returnLabelSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  run: traced("generate-return-label", async (input) => shopResult(getShopUseCases().generateReturnLabel.execute(input)), shopTraceCapture),
});
