// Import the DB entrypoint so identity policies are part of the plugin graph.
import "../db/index.js";
import { migrateShop } from "../db/migrations.js";
import { migrateRecipes } from "../db/recipe-migrations.js";
import { migrateTeach } from "../db/teach-migrations.js";
import { migrateDashboard } from "../db/dashboard-migrations.js";

const migrateApp: typeof migrateShop = async (app) => {
  await migrateShop(app);
  await migrateRecipes(app);
  await migrateTeach(app);
  return migrateDashboard(app);
};
export default migrateApp;
