import { runMigrations, type MigrationEntry } from "@agent-native/core/db";

export const teachMigrations: MigrationEntry[] = [
  {
    version: 1,
    name: "task9-demonstrations",
    sql: `
  CREATE TABLE IF NOT EXISTS demonstrations (
    id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^demo_[a-z0-9]+$'),
    owner_email TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
    subject_id TEXT NOT NULL, started_at BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('recording','completed','incomplete','cancelled')),
    checkpoint JSONB NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS demonstrations_active_session_idx
    ON demonstrations(owner_email, workspace_id, session_id) WHERE status = 'recording';
  CREATE INDEX IF NOT EXISTS demonstrations_subject_idx
    ON demonstrations(owner_email, workspace_id, session_id, subject_id, started_at);
  CREATE TABLE IF NOT EXISTS demo_steps (
    owner_email TEXT NOT NULL, workspace_id TEXT NOT NULL,
    demonstration_id VARCHAR(31) NOT NULL REFERENCES demonstrations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0), snapshot JSONB NOT NULL,
    PRIMARY KEY(demonstration_id, sequence)
  );
`,
  },
];
export const migrateTeach = runMigrations(teachMigrations, {
  table: "_muscle_memory_teach_migrations",
});
