import { runMigrations, type MigrationEntry } from "@agent-native/core/db";

export const recipeMigrations: MigrationEntry[] = [{
  version: 1,
  name: "task14-recipe-execution",
  sql: `
    CREATE TABLE IF NOT EXISTS recipe_versions (
      id VARCHAR(31) PRIMARY KEY, recipe_id VARCHAR(31) NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0), snapshot JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_number_idx ON recipe_versions(recipe_id, version);
    CREATE OR REPLACE FUNCTION reject_recipe_version_update() RETURNS trigger LANGUAGE plpgsql AS '
      BEGIN RAISE EXCEPTION ''Recipe versions are immutable''; END;
    ';
    DROP TRIGGER IF EXISTS recipe_versions_immutable ON recipe_versions;
    CREATE TRIGGER recipe_versions_immutable BEFORE UPDATE ON recipe_versions
      FOR EACH ROW EXECUTE FUNCTION reject_recipe_version_update();
    CREATE TABLE IF NOT EXISTS recipe_runs (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^run_[A-Za-z0-9_-]+$'),
      recipe_version_id VARCHAR(31) NOT NULL REFERENCES recipe_versions(id),
      checkpoint JSONB NOT NULL,
      CHECK (checkpoint->>'id' = id AND checkpoint->'recipe'->>'id' = recipe_version_id)
    );
    CREATE INDEX IF NOT EXISTS recipe_runs_version_idx ON recipe_runs(recipe_version_id);
    CREATE TABLE IF NOT EXISTS recipe_handoffs (
      idempotency_key TEXT PRIMARY KEY, run_id VARCHAR(31) NOT NULL REFERENCES recipe_runs(id),
      request_id VARCHAR(31) REFERENCES requests(id), context JSONB NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('with_agent', 'with_human'))
    );
    CREATE INDEX IF NOT EXISTS recipe_handoffs_request_idx ON recipe_handoffs(request_id);
  `,
}];

export const migrateRecipes = runMigrations(recipeMigrations, { table: "_muscle_memory_recipe_migrations" });
