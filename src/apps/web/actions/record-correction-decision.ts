import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { correctionOwner, getCorrections } from "../server/composition.js";
import { studioErrors, studioId, studioResult } from "../server/studio-action-contracts.js";

export default defineAction({
  description: "Reject a pending correction proposal with the operator's reason. Acceptance uses activate-recipe for the saved proposal version, atomically activating and recording accepted → version N. Never decide without the operator's explicit choice.",
  schema: z.object({ correctionId: studioId, decision: z.literal("rejected"), reason: z.string().trim().min(1).max(1000) }),
  errors: studioErrors,
  run: (input, context) => studioResult(getCorrections().reject(correctionOwner(context), input.correctionId, input.reason)),
});
