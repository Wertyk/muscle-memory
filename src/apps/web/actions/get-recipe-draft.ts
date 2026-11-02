import { defineAction } from "@agent-native/core/action";

import { getRecipeStudio } from "../server/composition.js";
import {
  studioErrors,
  studioLink,
  studioDraftRead,
  studioResult,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Read by recipeId for the editable Studio draft, or versionId for the owned TASK-11 original draft (null if unavailable). Studio result: content {name, trigger, steps}, revision, baseVersionId, ambiguities and inline validation issues. Reading never writes or calls a model.",
  schema: studioDraftRead,
  errors: studioErrors,
  http: { method: "GET" },
  readOnly: true,
  link: ({ result }) => studioLink(result),
  run: async (input, context) =>
    input.versionId
      ? studioResult(getRecipeStudio(context).getOriginalDraft(input.versionId))
      : studioResult(getRecipeStudio(context).getDraft(input.recipeId!)),
});
