import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getTeachUseCases } from "../server/composition.js";
import { shopId } from "../server/shop-action-contracts.js";
import {
  demonstrationIdSchema,
  demonstrationSchema,
  teachErrors,
  teachOperation,
} from "../server/teach-action-contracts.js";

export default defineAction({
  description:
    "Retrieve an owned demonstration as a trace, with trigger and ordered action input/output/navigation/timing. Use demonstrationId from UI, agent, MCP or CLI; requestId returns the latest demonstration for this browser session. Null means none or no access.",
  schema: z
    .object({
      demonstrationId: demonstrationIdSchema.optional(),
      requestId: shopId("request").optional(),
    })
    .refine(
      (v) => Boolean(v.demonstrationId) !== Boolean(v.requestId),
      "Supply exactly one of demonstrationId or requestId",
    ),
  outputSchema: demonstrationSchema.nullable(),
  errors: teachErrors,
  readOnly: true,
  http: { method: "GET" },
  run: (input, context) =>
    teachOperation(() => getTeachUseCases().get(input, context)),
});
