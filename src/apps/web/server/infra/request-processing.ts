import type { MatchReason, Run, RunStatus, TokenUsage } from "@muscle-memory/recipe-engine";
import type { RequestId } from "@muscle-memory/shop-domain";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { recipeRuns, requestProcessing, requests } from "../db/schema.js";
import type { ProcessingState, RequestProcessing } from "../../shared/request-processing.js";
export type { ProcessingState, RequestProcessing } from "../../shared/request-processing.js";

/** A projection of durable checkpoints, so approval resumes and manual resolution
 * cannot leave a duplicated status column stale. Does not execute or extract. */
export class DrizzleRequestProcessing {
  constructor(private readonly db: ShopDb) {}
  async list(ids?: readonly RequestId[]): Promise<RequestProcessing[]> {
    if (ids && !ids.length) return [];
    const rows = await this.db.select({
      requestId: requestProcessing.requestId, runId: requestProcessing.runId, shopStatus: requests.status,
      matchReason: sql<MatchReason | null>`${requestProcessing.match}->>'reason'`,
      extractedTokens: sql<TokenUsage | null>`${requestProcessing.match}->'tokens'`,
      status: sql<RunStatus | null>`${recipeRuns.checkpoint}->>'status'`,
      runTokens: sql<TokenUsage | null>`${recipeRuns.checkpoint}->'tokens'`,
      recipeName: sql<string | null>`${recipeRuns.checkpoint}->'recipe'->>'name'`,
      version: sql<number | null>`(${recipeRuns.checkpoint}->'recipe'->>'version')::int`,
      mode: sql<Run["mode"] | null>`${recipeRuns.checkpoint}->>'mode'`,
      runDurationMs: sql<number>`coalesce((SELECT sum((step->>'durationMs')::double precision)
        FROM jsonb_array_elements(${recipeRuns.checkpoint}->'steps') step), 0)`,
      unknownExtraction: sql<boolean>`EXISTS (SELECT 1 FROM jsonb_array_elements(${recipeRuns.checkpoint}->'steps') step
        WHERE step->>'kind' = 'extract' AND step->>'status' <> 'completed')`,
      matchDurationMs: requestProcessing.matchDurationMs,
      approved: sql<number | null>`jsonb_array_length(${recipeRuns.checkpoint}->'approvedStepIds')`,
    }).from(requestProcessing).innerJoin(requests, eq(requests.id, requestProcessing.requestId))
      .leftJoin(recipeRuns, eq(recipeRuns.id, requestProcessing.runId))
      .where(ids ? inArray(requestProcessing.requestId, [...ids]) : undefined)
      .orderBy(asc(requestProcessing.requestId));
    return rows.map((row) => {
      let state: ProcessingState | null = null;
      if (row.status === "awaiting_approval") state = "awaiting_approval";
      else if (row.shopStatus === "resolved" || row.status === "aborted") state = "done";
      else if (row.status === "completed") state = row.approved ? "done" : "auto_handled";
      else if (row.status === "handed_off" || row.status === "failed") state = "with_agent";
      const tokens = { input: (row.extractedTokens?.input ?? 0) + (row.runTokens?.input ?? 0), output: (row.extractedTokens?.output ?? 0) + (row.runTokens?.output ?? 0) };
      const known = row.matchReason !== null && row.matchReason !== "extraction_failed" && row.status === "completed" &&
        !row.unknownExtraction;
      return {
        requestId: row.requestId, runId: row.runId, state, matchReason: row.matchReason,
        tokens, recipe: row.recipeName && row.version ? { name: row.recipeName, version: row.version } : null,
        runStatus: row.status, mode: row.mode,
        totalTokens: known ? tokens.input + tokens.output : null,
        durationMs: row.matchDurationMs !== null && row.status === "completed"
          ? row.matchDurationMs + row.runDurationMs : null,
      };
    });
  }
}
