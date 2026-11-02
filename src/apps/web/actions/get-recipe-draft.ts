import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import {
  getDraftRecipeUseCases,
  getRecipeStudio,
} from "../server/composition.js";
import {
  draftOperation,
  draftOwner,
  recipeDraftSchema,
} from "../server/draft-action-contracts.js";
import {
  studioDraftRead,
  studioDraftOutputSchema,
  studioLink,
  studioResult,
} from "../server/studio-action-contracts.js";

export default defineAction({
  description:
    "Read by versionId for the original owned TASK-11 draft (null if absent or no access), or recipeId for editable Studio content, revision, base version, ambiguities and inline issues. Both use the canonical recipe_drafts store. No model calls.",
  schema: studioDraftRead,
  outputSchema: z
    .union([recipeDraftSchema, studioDraftOutputSchema])
    .nullable(),
  errors: defineActionErrors(
    "DRAFT_INPUT",
    "DRAFT_NOT_FOUND",
    "DRAFT_UNAVAILABLE",
    "RECIPE_NOT_FOUND",
    "RECIPE_CONFLICT",
    "RECIPE_INVALID",
  ),
  readOnly: true,
  http: { method: "GET" },
  link: ({ result }) => studioLink(result),
  run: async (input, context) => {
    const owner = draftOwner(context);
    return input.versionId
      ? draftOperation(() =>
          getDraftRecipeUseCases().get(owner, input.versionId!),
        )
      : studioResult(getRecipeStudio(context).getDraft(input.recipeId!));
  },
});
