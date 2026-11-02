import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDraftRecipeUseCases } from "../server/composition.js";
import { draftErrors, draftOperation, draftOwner, recipeDraftSchema } from "../server/draft-action-contracts.js";
import { demonstrationIdSchema } from "../server/teach-action-contracts.js";

export default defineAction({
  description: "Draft a recipe from an owned, completed stored demonstration without a model. Returns immutable draft, catalog metadata and ambiguities for review; never activates. Each call creates a new draft.",
  schema: z.object({ demonstrationId: demonstrationIdSchema.describe("Completed demonstration ID returned by stop-demonstration") }),
  outputSchema: recipeDraftSchema,
  errors: draftErrors,
  run: (input, context) => {
    const owner = draftOwner(context);
    return draftOperation(() => getDraftRecipeUseCases().execute({ ...input, owner }));
  },
});
