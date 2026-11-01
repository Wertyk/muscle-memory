import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { traced } from "../server/infra/traced.js";
import {
  shopId,
  shipmentStatusSchema,
  shopErrors,
  shopResult,
} from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Look up shipment status for orderId, including carrier, tracking number and estimated delivery; shipment is null when no shipment record exists.",
  schema: z.object({
    orderId: shopId("order").describe("Order ID such as ord_1042"),
  }),
  outputSchema: shipmentStatusSchema,
  errors: shopErrors,
  http: { method: "GET" },
  readOnly: true,
  run: traced(
    "get-shipment-status",
    async (input) =>
      shopResult(getShopUseCases().getShipmentStatus.execute(input)),
    shopTraceCapture,
  ),
});
