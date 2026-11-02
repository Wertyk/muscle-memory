import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { PROPOSAL_CARD_RENDERER, proposalNotesSchema } from "../shared/recipe-proposal.js";

import { saveRecipeVersion } from "../server/composition.js";
import { jsonContainerInput } from "../server/action-input.js";
import {
  studioErrors,
  studioLink,
  studioId,
  studioResult,
  studioRevision,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Validate the current draft at expectedRevision and save a NEW immutable recipe version. For a human correction include correctionId and proposal notes; read get-request/get-recipe-run first. Generalise the correction in the editable draft with update-recipe-draft, preserving bindings, then save here. Optional proposal {description, trigger (human terms), resolutions:[{ambiguity,resolution}]} displays the crystallization chat card; these are presentation notes, not executable DSL. Never activates automatically. Read back after uncertain failure before retrying.",
  schema: z.object({ recipeId: studioId, expectedRevision: studioRevision, proposal: jsonContainerInput(proposalNotesSchema, "proposal").optional(), correctionId: studioId.optional().describe("Correction being proposed; preserves the run/step link and records a pending proposal. Include proposal notes.") }).refine(input => !input.correctionId || Boolean(input.proposal), { path: ["proposal"], message: "Correction proposals require proposal notes." }),
  chatUI: {
    renderer: PROPOSAL_CARD_RENDERER,
    title: "Recipe proposal",
    projectResult: (args, result) => ({ version: result, ...(args.correctionId ? { correctionId: args.correctionId } : {}), ...(args.proposal ? { proposal: args.proposal } : {}) }),
  },
  errors: studioErrors,
  link: ({ result }) => studioLink(result),
  run: (input, context) => studioResult(saveRecipeVersion(input, context)),
});
