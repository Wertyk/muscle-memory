import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getRequestIntake } from "../server/composition.js";
import { requestProcessingSchema } from "../server/intake-action-contracts.js";
import { shopId } from "../server/shop-action-contracts.js";

export default defineAction({
  description: "Read inbox processing state, run ID, match reason and measured extraction+execution tokens, recipe identity and active duration. totalTokens/durationMs include intake for completed recipes; null means unknown (including queued agent work). States are auto_handled, awaiting_approval, with_agent, done; null means in-flight/interrupted intake. Read-only, never calls a model.",
  schema: z.object({ requestIds: z.array(shopId("request")).max(1000).optional().describe("Filter by request IDs, at most 1000; omit for all intake records; existing seed requests have no intake record") }),
  outputSchema: z.array(requestProcessingSchema),
  http: { method: "GET" }, readOnly: true,
  run: (input, context) => getRequestIntake(context).processing.list(input.requestIds),
});
