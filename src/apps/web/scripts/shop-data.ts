import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadEnv } from "@agent-native/core/scripts";
import { getDb } from "../server/db/index.js";
import { migrateShop } from "../server/db/migrations.js";
import { DEMO_SEED } from "../server/db/shop-demo-data.js";
import { resetShop, seedShop } from "../server/infra/shop-demo-store.js";

const command = process.argv[2];
if (command !== "seed" && command !== "reset") throw new Error("Usage: tsx scripts/shop-data.ts seed|reset");
loadEnv();

try {
  await withMigrationRuntime(async () => { await migrateShop(undefined); });
  if (command === "seed") {
    console.log(`Shop seeded (fixed seed ${DEMO_SEED}):`, await seedShop(getDb()));
  } else {
    await resetShop(getDb());
    console.log("Shop reset: seven shop tables emptied; non-shop data retained.");
  }
} finally {
  await closeDbExec();
}
