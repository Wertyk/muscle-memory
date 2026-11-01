import { defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";
import { shopId } from "./shop-action-contracts.js";
import { runIdSchema } from "./recipe-action-contracts.js";

export const intakeErrors = defineActionErrors("INTAKE_FAILED");
export const requestProcessingSchema = z.object({
  requestId: shopId("request"), runId: runIdSchema,
  state: z.enum(["auto_handled", "awaiting_approval", "with_agent", "done"]).nullable(),
  matchReason: z.enum(["matched", "no_match", "extraction_failed", "ambiguous", "matching_failed"]).nullable(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
});

export async function intakeOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch {
    return intakeErrors.fail("Intake could not finish. Some requests or effects may already be saved; inspect list-requests and list-request-processing before retrying.", "INTAKE_FAILED", { statusCode: 409 });
  }
}
