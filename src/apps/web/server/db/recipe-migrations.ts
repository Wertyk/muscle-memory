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
}, {
  version: 2,
  name: "task15-recipe-catalog-and-intake",
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_owner_idx ON recipe_versions(recipe_id, id);
    CREATE TABLE IF NOT EXISTS recipes (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^[A-Za-z_][A-Za-z0-9_-]*$'),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      status TEXT NOT NULL CHECK (status IN ('draft', 'active')),
      active_version_id VARCHAR(31),
      FOREIGN KEY (id, active_version_id) REFERENCES recipe_versions(recipe_id, id),
      CHECK ((status = 'draft' AND active_version_id IS NULL) OR (status = 'active' AND active_version_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS request_processing (
      request_id VARCHAR(31) PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
      run_id VARCHAR(31) NOT NULL UNIQUE CHECK (run_id ~ '^run_[A-Za-z0-9_-]+$'),
      match JSONB
    );
  `,
}, {
  version: 3,
  name: "task11-draft-review-evidence",
  sql: `CREATE TABLE IF NOT EXISTS recipe_drafts (
    version_id VARCHAR(31) PRIMARY KEY REFERENCES recipe_versions(id),
    owner_email TEXT NOT NULL, workspace_id TEXT NOT NULL, evidence JSONB NOT NULL
  );`,
}, {
  version: 4,
  name: "task17-recipe-corrections",
  sql: `CREATE TABLE IF NOT EXISTS recipe_corrections (
    id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^cor_[A-Za-z0-9_-]+$'),
    request_id VARCHAR(31) NOT NULL REFERENCES requests(id),
    run_id VARCHAR(31) NOT NULL REFERENCES recipe_runs(id),
    recipe_version_id VARCHAR(31) NOT NULL REFERENCES recipe_versions(id),
    proposal_version_id VARCHAR(31) REFERENCES recipe_versions(id),
    created_at BIGINT NOT NULL, snapshot JSONB NOT NULL,
    CHECK (snapshot->>'id' = id AND snapshot->>'requestId' = request_id AND snapshot->>'runId' = run_id),
    CHECK (snapshot->>'status' IN ('recorded','proposed','accepted','rejected'))
  );
  CREATE INDEX IF NOT EXISTS recipe_corrections_request_idx ON recipe_corrections(request_id);
  CREATE INDEX IF NOT EXISTS recipe_corrections_run_idx ON recipe_corrections(run_id);`,
}, {
  version: 5,
  name: "task17-correction-owner-scope",
  sql: `ALTER TABLE recipe_corrections ADD COLUMN IF NOT EXISTS owner_email TEXT,
    ADD COLUMN IF NOT EXISTS workspace_id TEXT;
  UPDATE recipe_corrections SET owner_email = snapshot->'owner'->>'userId',
    workspace_id = snapshot->'owner'->>'workspaceId'
    WHERE owner_email IS NULL OR workspace_id IS NULL;
  ALTER TABLE recipe_corrections ALTER COLUMN owner_email SET NOT NULL,
    ALTER COLUMN workspace_id SET NOT NULL;`,
}];

export const migrateRecipes = runMigrations(recipeMigrations, { table: "_muscle_memory_recipe_migrations" });
