import { recipeVersionSchema } from "@muscle-memory/recipe-engine";
import { z } from "zod";

export const PROPOSAL_CARD_RENDERER = "muscle-memory.recipe-proposal";
// Presentation notes travel with the chat tool result, not the executable DSL.
export const proposalNotesSchema = z.object({
  description: z.string().trim().min(1).max(1000),
  trigger: z.string().trim().min(1).max(500),
  resolutions: z
    .array(
      z.object({
        ambiguity: z.string().trim().min(1).max(300),
        resolution: z.string().trim().min(1).max(1000),
      }),
    )
    .max(50),
});
export const recipeProposalSchema = z.object({
  version: recipeVersionSchema,
  correctionId: z.string().optional(),
  proposal: proposalNotesSchema.optional(),
});
