import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadEnv } from "@agent-native/core/scripts";

import {
  getRecipeUseCases,
  getRequestIntake,
  getShopUseCases,
} from "../server/composition.js";
import { runFixtures } from "../server/fixtures/run-recipes.js";
import migrateApp from "../server/plugins/db.js";
import { shopResult } from "../server/shop-action-contracts.js";

loadEnv();
try {
  await withMigrationRuntime(async () => {
    await migrateApp(undefined);
  });
  const cases = getRecipeUseCases({
    caller: "cli",
    userEmail: "dev@local.test",
  });
  await shopResult(
    getShopUseCases().getRequest.execute({ requestId: "req_0001" }),
  );
  const catalog = getRequestIntake().catalog;
  if (
    (await cases.runs.list()).some((run) =>
      run.recipeId.startsWith("recipe_run_"),
    )
  ) {
    throw new Error(
      "Run fixtures already exist. Reseed the shop between rehearsals; completed shop effects must not be replayed.",
    );
  }
  // Existing deterministic shop seed IDs; these are real stored effects/checkpoints.
  const contexts = {
    completed: { requestId: "req_0002", orderId: "ord_1002" },
    approval: { requestId: "req_0001", orderId: "ord_1001" },
    rejected: { requestId: "req_0003" },
    handoff: { requestId: "req_0005" },
    failed: { requestId: "req_0004" },
  };
  for (const key of Object.keys(runFixtures) as (keyof typeof runFixtures)[]) {
    await catalog.saveVersion(runFixtures[key]);
    await catalog.save({
      id: runFixtures[key].recipeId,
      name: runFixtures[key].name,
      status: "draft",
      activeVersionId: null,
    });
    let run = await cases.runRecipe.execute({
      recipe: runFixtures[key],
      trigger: contexts[key],
    });
    if (key === "rejected")
      run = await cases.runRecipe.resume({
        runId: run.id,
        approval: { stepId: "tag", decision: "reject" },
      });
    console.log(
      `${key}: ${run.id} · ${run.status} · ${run.tokens.input + run.tokens.output} execution tokens`,
    );
  }
} finally {
  await closeDbExec();
}
