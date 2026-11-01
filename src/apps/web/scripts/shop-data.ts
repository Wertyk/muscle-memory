import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadEnv } from "@agent-native/core/scripts";
import { getDb } from "../server/db/index.js";
import migrateApp from "../server/plugins/db.js";
import { DEMO_SEED, shopDemoAnchor } from "../server/db/shop-demo-data.js";
import { resetShop, seedShop } from "../server/infra/shop-demo-store.js";

const [command, ...flags] = process.argv.slice(2);
if ((command !== "seed" && command !== "reset") || flags.some(flag => flag !== "--all") || flags.length > 1) {
  throw new Error("Usage: tsx scripts/shop-data.ts seed|reset [--all]");
}
const options = { all: flags.includes("--all") };
loadEnv();
// Validate before migrations/writes. seedShop reads the same optional anchor;
// without it, data is anchored to the actual seeding minute.
if (command === "seed") shopDemoAnchor();

try {
  await withMigrationRuntime(async () => { await migrateApp(undefined); });
  if (command === "seed") {
    console.log(`Shop seeded (content seed ${DEMO_SEED}; minute-aligned time anchor):`, await seedShop(getDb(), options));
  } else {
    await resetShop(getDb(), options);
    console.log("Shop reset: shop rows and related operational data emptied.");
  }
  console.log(options.all ? "Pristine rehearsal: recipe catalog, versions and all recipe runs cleared." : "Recipe catalog, versions and unrelated recipe runs retained.");
} finally {
  await closeDbExec();
}
