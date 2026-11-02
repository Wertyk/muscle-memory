import type {
  HandlingSample,
  HandlingStatsSource,
} from "@muscle-memory/shop-domain";
import { sql } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";

/** Bounded SQL projection: no prompts, message bodies, step outputs or N+1 reads. */
export class DrizzleHandlingStats implements HandlingStatsSource {
  constructor(
    private readonly db: ShopDb,
    private readonly owner: { userId: string; workspaceId: string },
  ) {}
  async read(limit: number) {
    const [tables] = await this.db
      .select({
        present: sql<boolean>`to_regclass('agent_trace_summaries') is not null`,
      })
      .from(sql`(SELECT 1) presence`);
    // The first dashboard visit can precede the framework's first agent turn.
    // A read never creates observability tables or backfills usage.
    const traceJoin = tables?.present
      ? sql`LEFT JOIN agent_trace_summaries t
      ON t.run_id = a.run_id AND t.thread_id = a.thread_id
      AND lower(t.user_id) = a.owner_email
      AND coalesce(t.org_id, 'personal') = a.workspace_id`
      : sql``;
    const traceTokens = tables?.present
      ? sql`CASE WHEN t.llm_calls > 0
      AND t.total_input_tokens >= 0 AND t.total_output_tokens >= 0
      AND t.total_input_tokens + t.total_output_tokens > 0
      THEN t.total_input_tokens + t.total_output_tokens END`
      : sql`NULL::bigint`;
    const traceMs = tables?.present
      ? sql`CASE WHEN t.total_duration_ms >= 0 THEN t.total_duration_ms END`
      : sql`NULL::bigint`;
    const traceTime = tables?.present ? sql`t.created_at` : sql`NULL::bigint`;
    // Include order-only/chat-only continuations between explicit request anchors.
    // Overlapping request windows cannot be allocated and are marked unknown below.
    const intervening = tables?.present
      ? sql`
      SELECT w.request_id, t.run_id, NULL::bigint AS resolved_at, ${traceTokens} AS tokens, ${traceMs} AS ms,
        EXISTS (SELECT 1 FROM request_agent_runs other WHERE other.run_id = t.run_id AND other.request_id <> w.request_id) AS shared
      FROM thread_windows w JOIN agent_trace_summaries t ON t.thread_id = w.thread_id
        AND lower(t.user_id) = w.owner_email AND coalesce(t.org_id, 'personal') = w.workspace_id
        AND t.created_at BETWEEN w.first_at AND w.last_at
      WHERE w.resolved_at IS NOT NULL
    `
      : sql`SELECT request_id, run_id, resolved_at, tokens, ms, shared FROM linked_runs WHERE false`;
    const [rows, counters] = await Promise.all([
      this.db
        .select({
          sample: sql<HandlingSample>`jsonb_build_object(
        'requestId', d.id, 'requestType', d.category, 'handler', d.handler,
        'completedAt', d.completed_at,
        'agentTokens', CASE WHEN d.handler = 'agent' THEN d.agent_tokens ELSE NULL END,
        'intakeTokens', CASE WHEN d.has_intake AND (d.match IS NULL OR d.match->>'reason' = 'extraction_failed') THEN NULL ELSE d.intake_tokens END,
        'runTokens', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(d.checkpoint->'steps', '[]'::jsonb)) step
          WHERE step->>'kind' = 'extract' AND step->>'status' IN ('failed', 'running')) THEN NULL ELSE d.run_tokens END,
        'tokens', CASE WHEN d.handler = 'unattributed' OR NOT d.intake_known
          OR (d.handler = 'agent' AND d.agent_tokens IS NULL)
          OR (d.handler = 'recipe' AND d.agent_turns > 0) THEN NULL
          ELSE d.intake_tokens + d.run_tokens + CASE WHEN d.handler = 'agent' THEN d.agent_tokens ELSE 0 END END,
        'durationMs', CASE WHEN d.handler = 'unattributed'
          OR (d.has_intake AND d.match_ms IS NULL)
          OR (d.handler = 'agent' AND d.agent_ms IS NULL)
          OR (d.handler = 'recipe' AND d.agent_turns > 0) THEN NULL
          ELSE coalesce(d.match_ms, 0) + d.run_ms + CASE WHEN d.handler = 'agent' THEN d.agent_ms ELSE 0 END END
      )`,
        })
        .from(sql`(
        WITH linked_runs AS (
          SELECT a.request_id, a.run_id, a.thread_id, a.owner_email, a.workspace_id, a.resolved_at,
            ${traceTime} AS created_at, ${traceTokens} AS tokens, ${traceMs} AS ms,
            EXISTS (SELECT 1 FROM request_agent_runs other WHERE other.run_id = a.run_id AND other.request_id <> a.request_id) AS shared
          FROM request_agent_runs a ${traceJoin}
          WHERE a.owner_email = ${this.owner.userId} AND a.workspace_id = ${this.owner.workspaceId}
        ), thread_windows AS (
          SELECT request_id, thread_id, owner_email, workspace_id,
            min(created_at) AS first_at, max(created_at) AS last_at, max(resolved_at) AS resolved_at
          FROM linked_runs GROUP BY request_id, thread_id, owner_email, workspace_id
        ), covered_runs AS (
          SELECT request_id, run_id, max(resolved_at) AS resolved_at, min(tokens) AS tokens, min(ms) AS ms, bool_or(shared) AS shared
          FROM (
            SELECT request_id, run_id, resolved_at, tokens, ms, shared FROM linked_runs
            UNION ALL ${intervening}
          ) coverage GROUP BY request_id, run_id
        ), agent_usage AS (
          SELECT a.request_id, count(*) AS turns, max(a.resolved_at) AS resolved_at,
            CASE WHEN bool_and(a.tokens IS NOT NULL AND NOT a.shared AND NOT EXISTS (
              SELECT 1 FROM covered_runs other WHERE other.run_id = a.run_id AND other.request_id <> a.request_id
            )) THEN sum(a.tokens) END AS tokens,
            CASE WHEN bool_and(a.ms IS NOT NULL AND NOT a.shared AND NOT EXISTS (
              SELECT 1 FROM covered_runs other WHERE other.run_id = a.run_id AND other.request_id <> a.request_id
            )) THEN sum(a.ms) END AS ms
          FROM covered_runs a GROUP BY a.request_id
        ), recent AS (
          SELECT r.id, r.category, p.request_id IS NOT NULL AS has_intake,
            p.match, p.match_duration_ms AS match_ms, x.checkpoint,
            coalesce(a.turns, 0) AS agent_turns, a.tokens AS agent_tokens, a.ms AS agent_ms,
            CASE WHEN r.status = 'resolved' AND a.resolved_at IS NOT NULL THEN 'agent'
              WHEN x.checkpoint->>'status' = 'completed' AND x.checkpoint->>'mode' = 'execute' THEN 'recipe'
              ELSE 'unattributed' END AS handler,
            CASE WHEN r.status = 'resolved' AND a.resolved_at IS NOT NULL THEN a.resolved_at
              WHEN x.checkpoint->>'status' = 'completed' AND x.checkpoint->>'mode' = 'execute'
                THEN (x.checkpoint->>'updatedAt')::double precision
              ELSE extract(epoch from r.updated_at::timestamptz) * 1000 END AS completed_at
          FROM requests r LEFT JOIN request_processing p ON p.request_id = r.id
          LEFT JOIN recipe_runs x ON x.id = p.run_id
          LEFT JOIN agent_usage a ON a.request_id = r.id
          WHERE ((r.status = 'resolved' AND a.resolved_at IS NOT NULL) OR (x.checkpoint->>'status' = 'completed' AND x.checkpoint->>'mode' = 'execute'))
            AND coalesce(x.checkpoint->>'status', '') <> 'awaiting_approval'
          ORDER BY completed_at DESC, r.id DESC LIMIT ${limit}
        ) SELECT recent.*,
          (NOT has_intake OR (match IS NOT NULL AND match->>'reason' <> 'extraction_failed'))
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(checkpoint->'steps', '[]'::jsonb)) step
              WHERE step->>'kind' = 'extract' AND step->>'status' IN ('failed', 'running')) AS intake_known,
          coalesce((match->'tokens'->>'input')::bigint, 0) + coalesce((match->'tokens'->>'output')::bigint, 0) AS intake_tokens,
          coalesce((checkpoint->'tokens'->>'input')::bigint, 0) + coalesce((checkpoint->'tokens'->>'output')::bigint, 0) AS run_tokens,
          coalesce((SELECT sum((step->>'durationMs')::double precision)
            FROM jsonb_array_elements(coalesce(checkpoint->'steps', '[]'::jsonb)) step), 0) AS run_ms
        FROM recent
      ) d`)
        .orderBy(sql`d.completed_at DESC, d.id DESC`),
      this.db
        .select({
          pendingApprovals: sql<number>`(SELECT count(*)::int FROM request_processing p JOIN recipe_runs x ON x.id = p.run_id
          WHERE x.checkpoint->>'status' = 'awaiting_approval' AND x.checkpoint->>'mode' = 'execute')`,
          activeRecipes: sql<number>`(SELECT count(*)::int FROM recipes WHERE status = 'active' AND active_version_id IS NOT NULL)`,
        })
        .from(sql`(SELECT 1) counters`),
    ]);
    return {
      samples: rows.map((r) => r.sample),
      pendingApprovals: counters[0]!.pendingApprovals,
      activeRecipes: counters[0]!.activeRecipes,
    };
  }
}
