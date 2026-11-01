// Import the DB entrypoint so identity policies are part of the plugin graph.
import "../db/index.js";
import { migrateShop } from "../db/migrations.js";
import { migrateRecipes } from "../db/recipe-migrations.js";

const migrateApp: typeof migrateShop = async (app) => {
  await migrateShop(app);
  return migrateRecipes(app);
};
export default migrateApp;
