import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getHandlingStats } from "../server/composition.js";

export default defineAction({
  description:
    "Read measured AI dependency: latest 100 handled requests, saved recipe names/versions, total/intake/recipe-step tokens and active milliseconds by recipe/agent, deterministic share, pending approvals, active recipes and overall/same-type mean costs with sample counts. Null means unknown. Agent traces are scoped to the signed-in actor/workspace. No model calls or writes. Navigate to view=dashboard for the UI; preserve unknowns and sample counts when reporting.",
  schema: z.object({}),
  readOnly: true,
  http: { method: "GET" },
  run: (_input, context) => getHandlingStats(context).execute(),
});
