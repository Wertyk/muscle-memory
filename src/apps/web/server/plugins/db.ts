// Import the DB entrypoint so identity policies are part of the plugin graph.
import "../db/index.js";
export { migrateShop as default } from "../db/migrations.js";
