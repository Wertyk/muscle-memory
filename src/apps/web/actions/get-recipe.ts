import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getRecipeStudio, readCorrections } from "../server/composition.js";
import {
  studioErrors,
  studioLink,
  studioId,
  studioResult,
} from "../server/studio-action-contracts.js";
export default defineAction({
  description:
    "Inspect recipe catalog metadata and immutable version history with field diffs and scoped human correction proposals/decisions. Also read get-recipe-draft before editing.",
  schema: z.object({ recipeId: studioId }),
  errors: studioErrors,
  http: { method: "GET" },
  readOnly: true,
  link: ({ result }) => studioLink(result),
  run: ({ recipeId }, context) => studioResult((async () => {
    const detail = await getRecipeStudio(context).get(recipeId);
    return { ...detail, corrections: await readCorrections(context, { recipeId }) };
  })()),
});
