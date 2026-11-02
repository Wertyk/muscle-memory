import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getRecipeStudio } from "../server/composition.js";
import { studioLink } from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "List catalog recipes with draft/active status, latest saved version, run count and last result. Open /recipes/:recipeId to inspect.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  link: ({ result }) => studioLink(result),
  run: (_input, context) => getRecipeStudio(context).list(),
});
