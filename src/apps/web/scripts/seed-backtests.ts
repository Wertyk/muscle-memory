import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadEnv } from "@agent-native/core/scripts";

import { getDb } from "../server/db/index.js";
import { damagedItemBacktestFixture } from "../server/fixtures/backtest-recipes.js";
import { DrizzleRecipeCatalog } from "../server/infra/recipe-catalog.js";
import migrateApp from "../server/plugins/db.js";

// Explicit rehearsal setup only; reports still use the real historical source/extractor.
loadEnv();
try {
  await withMigrationRuntime(async () => { await migrateApp(undefined); });
  const catalog = new DrizzleRecipeCatalog(getDb());
  const version = damagedItemBacktestFixture;
  await catalog.saveVersion(version);
  if (!await catalog.get(version.recipeId))
    await catalog.save({ id: version.recipeId, name: version.name, status: "draft", activeVersionId: null });
  console.log(`Backtest fixture: /recipes/${version.recipeId} · v${version.version} (${version.id}). Not activated.`);
} finally {
  await closeDbExec();
}
