import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { PROPOSAL_CARD_RENDERER, proposalNotesSchema } from "../shared/recipe-proposal.js";

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
    "Validate the current draft at expectedRevision and save a NEW immutable recipe version. Optional proposal {description, trigger (human terms), resolutions:[{ambiguity,resolution}]} displays the crystallization chat card; these are presentation notes, not executable DSL. Never activates automatically. Read back after uncertain failure before retrying.",
  schema: z.object({ recipeId: studioId, expectedRevision: studioRevision, proposal: proposalNotesSchema.optional() }),
  chatUI: {
    renderer: PROPOSAL_CARD_RENDERER,
    title: "Recipe proposal",
    projectResult: (args, result) => ({ version: result, ...(args.proposal ? { proposal: args.proposal } : {}) }),
  },
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: (input, context) => studioResult(getRecipeStudio(context).save(input)),
});
