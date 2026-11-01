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
    "Discard the active recording and free the session for another demonstration. Already performed shop effects remain saved. The cancelled trace is retained for inspection.",
  schema: z.object({ demonstrationId: demonstrationIdSchema }),
  outputSchema: demonstrationSchema,
  errors: teachErrors,
  run: (input, context) =>
    teachOperation(() =>
      getTeachUseCases().finish(input.demonstrationId, true, context),
    ),
});
