import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getRecipeStudio } from "../server/composition.js";
import {
  studioErrors,
  studioLink,
  studioId,
  studioResult,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Deactivate a recipe for future intake; preserve all immutable versions and already-pinned runs. Removes the runtime skill; skillPublication reports retryable sync failures.",
  schema: z.object({ recipeId: studioId }),
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: ({ recipeId }, context) =>
    studioResult(getRecipeStudio(context).deactivate(recipeId)),
});
