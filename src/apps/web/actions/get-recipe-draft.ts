import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDraftRecipeUseCases } from "../server/composition.js";
import { draftErrors, draftOperation, draftOwner, recipeDraftSchema, recipeVersionIdSchema } from "../server/draft-action-contracts.js";

export default defineAction({
  description: "Read an owned saved recipe draft by versionId, including catalog status and original ambiguities. Available to UI, agent, MCP and CLI; null means absent or no access.",
  schema: z.object({ versionId: recipeVersionIdSchema.describe("Immutable draft.id from draft-recipe-from-demonstration") }),
  outputSchema: recipeDraftSchema.nullable(), errors: draftErrors,
  readOnly: true, http: { method: "GET" },
  run: (input, context) => {
    const owner = draftOwner(context);
    return draftOperation(() => getDraftRecipeUseCases().get(owner, input.versionId));
  },
});
