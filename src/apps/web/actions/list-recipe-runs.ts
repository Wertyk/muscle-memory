import { defineAction } from "@agent-native/core/action";

import { getRecipeUseCases } from "../server/composition.js";
import {
  runFiltersSchema,
  runSummariesSchema,
} from "../server/recipe-action-contracts.js";

export default defineAction({
  description:
    "List saved recipe runs, newest first, with request, immutable recipe version, status, active execution duration and execution tokens. Filters combine. Intake extraction tokens are separate.",
  schema: runFiltersSchema,
  outputSchema: runSummariesSchema,
  http: { method: "GET" },
  readOnly: true,
  run: (input) => getRecipeUseCases().runs.list(input),
});
