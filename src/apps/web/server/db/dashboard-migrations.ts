import { runMigrations, type MigrationEntry } from "@agent-native/core/db";

export const dashboardMigrations: MigrationEntry[] = [
  {
    version: 1,
    name: "task21-measured-handling",
    sql: `
    ALTER TABLE request_processing ADD COLUMN IF NOT EXISTS match_duration_ms BIGINT;
    CREATE TABLE IF NOT EXISTS request_agent_runs (
      request_id VARCHAR(31) NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      owner_email TEXT NOT NULL, workspace_id TEXT NOT NULL,
      observed_at BIGINT NOT NULL, resolved_at BIGINT,
      PRIMARY KEY (request_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS request_agent_runs_run_idx ON request_agent_runs(run_id);
  `,
  },
];
export const migrateDashboard = runMigrations(dashboardMigrations, {
  table: "_muscle_memory_dashboard_migrations",
});
