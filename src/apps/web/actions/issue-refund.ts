import { defineAction } from "@agent-native/core/action";
import { AUTO_REFUND_LIMIT, isWithinAutoRefundLimit } from "@muscle-memory/shop-domain";
import { z } from "zod";
import { getShopUseCases, shopTraceCapture } from "../server/composition.js";
import { shopId, moneySchema, nonEmpty, refundSchema, shopErrors, shopResult, definedFields } from "../server/shop-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: `Issue a refund for orderId in minor units; agent approval is required above ${AUTO_REFUND_LIMIT.currency} ${AUTO_REFUND_LIMIT.amountMinor / 100} or when amount is omitted (remaining payment).`,
  schema: z.object({
    orderId: shopId("order").describe('Order ID to refund, such as ord_1042'),
    amount: moneySchema.extend({ amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('Positive refund amount in minor units; USD cents') }).optional().describe('Explicit refund amount; omit to refund the remaining payment, which always asks the agent for approval'),
    reason: nonEmpty.describe('Reason for the refund'),
  }),
  outputSchema: refundSchema,
  errors: shopErrors,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  needsApproval: (input, context) => context?.caller !== "frontend" &&
    (input.amount === undefined || !isWithinAutoRefundLimit(input.amount)),
  run: traced("issue-refund", async (input) => shopResult(getShopUseCases().issueRefund.execute(definedFields(input))), shopTraceCapture),
});
