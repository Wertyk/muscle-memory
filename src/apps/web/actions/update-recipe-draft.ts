import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getRecipeStudio } from "../server/composition.js";
import { jsonContainerInput } from "../server/action-input.js";
import {
  studioContentInput,
  studioErrors,
  studioLink,
  studioId,
  studioResult,
  studioRevision,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Replace editable draft content {name, trigger, steps} using its expectedRevision. Preserves ambiguities; returns revision and validation issues. Invalid drafts are editable but cannot be saved as executable versions. Does not change the active recipe.",
  schema: z.object({
    recipeId: studioId,
    expectedRevision: studioRevision,
    content: jsonContainerInput(studioContentInput, "content"),
  }),
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: (input, context) => studioResult(getRecipeStudio(context).update(input)),
});
