import { runMigrations, type MigrationEntry } from "@agent-native/core/db";

// Independent migration namespace avoids colliding with concurrent draft work.
export const studioMigrations: MigrationEntry[] = [
  {
    version: 1,
    name: "task13-studio-drafts",
    sql: `CREATE TABLE IF NOT EXISTS recipe_studio_drafts (
    recipe_id VARCHAR(31) PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    base_version_id VARCHAR(31), content JSONB NOT NULL, ambiguities JSONB NOT NULL
  );`,
  },
];
export const migrateStudio = runMigrations(studioMigrations, {
  table: "_muscle_memory_studio_migrations",
});
