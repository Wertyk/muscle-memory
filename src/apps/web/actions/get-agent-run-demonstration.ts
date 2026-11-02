import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentRunTraces } from "../server/composition.js";
import { shopId } from "../server/shop-action-contracts.js";
import { demonstrationSchema, teachErrors, teachOperation } from "../server/teach-action-contracts.js";

export default defineAction({
  description: "Get the owned, complete forward-recorded agent trace for a resolved, known-type request that no recipe completed, including seed/manual requests, intake no-match requests and recipe handoffs. Null means it is not eligible to crystallize. Pass its id to draft-recipe-from-demonstration, then open Recipe Studio. Never reconstruct chat history.",
  schema: z.object({ requestId: shopId("request") }),
  outputSchema: demonstrationSchema.nullable(),
  errors: teachErrors,
  readOnly: true,
  http: { method: "GET" },
  run: (input, context) => teachOperation(() => getAgentRunTraces().get(input.requestId, context)),
});
