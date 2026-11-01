import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadEnv } from "@agent-native/core/scripts";
import { getDb } from "../server/db/index.js";
import { migrateShop } from "../server/db/migrations.js";
import { DEMO_SEED, shopDemoAnchor } from "../server/db/shop-demo-data.js";
import { resetShop, seedShop } from "../server/infra/shop-demo-store.js";

const command = process.argv[2];
if (command !== "seed" && command !== "reset") throw new Error("Usage: tsx scripts/shop-data.ts seed|reset");
loadEnv();
// Validate before migrations/writes. seedShop reads the same optional anchor;
// without it, data is anchored to the actual seeding minute.
if (command === "seed") shopDemoAnchor();

try {
  await withMigrationRuntime(async () => { await migrateShop(undefined); });
  if (command === "seed") {
    console.log(`Shop seeded (content seed ${DEMO_SEED}; minute-aligned time anchor):`, await seedShop(getDb()));
  } else {
    await resetShop(getDb());
    console.log("Shop reset: seven shop tables emptied; non-shop data retained.");
  }
} finally {
  await closeDbExec();
}
