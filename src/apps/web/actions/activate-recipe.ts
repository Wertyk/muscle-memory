import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { activateRecipeVersion } from "../server/composition.js";
import {
  studioErrors,
  studioLink,
  studioId,
  studioResult,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Activate an explicitly selected valid saved version belonging to recipeId. Intake uses this immutable pointer for future requests. Draft edits never run. Activating a correction proposal atomically records acceptance; rejected proposals cannot activate. Only activate on an explicit operator decision.",
  schema: z.object({ recipeId: studioId, versionId: studioId }),
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: (input, context) =>
    studioResult(activateRecipeVersion(input, context)),
});
