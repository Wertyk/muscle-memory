import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getTeachUseCases } from "../server/composition.js";
import {
  demonstrationIdSchema,
  demonstrationSchema,
  teachErrors,
  teachOperation,
} from "../server/teach-action-contracts.js";

export default defineAction({
  description:
    "Stop Teach and retain the demonstration. In-flight or failed captures are explicitly incomplete; shop actions are never repeated.",
  schema: z.object({ demonstrationId: demonstrationIdSchema }),
  outputSchema: demonstrationSchema,
  errors: teachErrors,
  run: (input, context) =>
    teachOperation(() =>
      getTeachUseCases().finish(input.demonstrationId, false, context),
    ),
});
