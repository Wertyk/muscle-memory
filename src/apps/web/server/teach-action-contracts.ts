import { defineActionErrors } from "@agent-native/core/action";
import {
  DemonstrationError,
  type Demonstration,
  type JsonObject,
} from "@muscle-memory/recipe-engine";
import { z } from "zod";

import { isRecipeJson } from "./infra/recipe-json.js";
import { TeachInputError } from "./infra/shop-demonstrations.js";
import { recipeJsonSchema } from "./recipe-action-contracts.js";

export const demonstrationIdSchema = z
  .string()
  .max(31)
  .regex(/^demo_[a-z0-9]+$/);
const jsonObject = z.custom<JsonObject>(
  (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && isRecipeJson(v),
);
export const demonstrationSchema: z.ZodType<Demonstration> = z.object({
  id: demonstrationIdSchema,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("teach") }),
    z.object({ kind: z.literal("agent_run"), threadId: z.string(), runIds: z.array(z.string()) }),
  ]).optional(),
  scope: z.object({
    userId: z.string(),
    workspaceId: z.string(),
    sessionId: z.string(),
  }),
  subjectId: z.string(),
  references: z.record(z.string(), z.string()),
  trigger: jsonObject,
  status: z.enum(["recording", "completed", "incomplete", "cancelled"]),
  startedAt: z.number(),
  stoppedAt: z.number().nullable(),
  incompleteReason: z.string().nullable(),
  nextSequence: z.number().int().positive(),
  pending: z.array(z.number().int().positive()),
  steps: z.array(
    z.object({
      id: z.string(),
      runId: z.string().optional(),
      action: z.string(),
      sequence: z.number().int().positive(),
      input: jsonObject,
      output: recipeJsonSchema,
      navigation: recipeJsonSchema,
      caller: z.string().nullable(),
      startedAt: z.number(),
      durationMs: z.number().nonnegative(),
    }),
  ),
});
export const teachErrors = defineActionErrors(
  "TEACH_INPUT",
  "TEACH_OVERLAP",
  "DEMONSTRATION_NOT_FOUND",
  "TEACH_UNAVAILABLE",
);
export async function teachOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof TeachInputError)
      return teachErrors.fail(cause.message, "TEACH_INPUT", {
        statusCode: 400,
      });
    if (cause instanceof DemonstrationError)
      return teachErrors.fail(
        cause.message,
        cause.code === "OVERLAP" ? "TEACH_OVERLAP" : "DEMONSTRATION_NOT_FOUND",
        { statusCode: 409 },
      );
    return teachErrors.fail(
      "Teach could not save its state. Read the demonstration before retrying; shop actions are independent.",
      "TEACH_UNAVAILABLE",
      { statusCode: 503 },
    );
  }
}
