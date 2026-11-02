import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getRecipeStudio } from "../server/composition.js";
import { studioErrors, studioId, studioLink, studioResult } from "../server/studio-action-contracts.js";

export default defineAction({
  description: "Retry runtime skill publication/removal after a failure. Reconciles the current active pointer; never activates a recipe or runs shop actions. Idempotent. Read publication status with get-recipe or list-recipes.",
  schema: z.object({ recipeId: studioId }),
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: ({ recipeId }, context) => studioResult(getRecipeStudio(context).syncSkill(recipeId).then(skillPublication => ({ recipeId, skillPublication }))),
});
