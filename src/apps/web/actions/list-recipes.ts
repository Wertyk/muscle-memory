import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getRecipeStudio } from "../server/composition.js";
import { studioLink } from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "List catalog recipes; status active discovers runnable recipes with their active immutable snapshot and trigger. activeVersion.version is the runnable version number; version is the latest saved number, which may be an inactive draft. Includes skill publication status, run count and last result. Open /recipes/:recipeId to inspect.",
  schema: z.object({ status: z.enum(["draft", "active"]).optional() }),
  http: { method: "GET" },
  readOnly: true,
  link: ({ result }) => studioLink(result),
  run: (input, context) => getRecipeStudio(context).list(input.status),
});
