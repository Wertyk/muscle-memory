import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getRecipeStudio } from "../server/composition.js";
import {
  studioErrors,
  studioLink,
  studioId,
  studioResult,
  studioRevision,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Validate the current draft at expectedRevision and save a NEW immutable recipe version. Never overwrites history or activates automatically. Read back after an uncertain failure before retrying.",
  schema: z.object({ recipeId: studioId, expectedRevision: studioRevision }),
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: (input, context) => studioResult(getRecipeStudio(context).save(input)),
});
