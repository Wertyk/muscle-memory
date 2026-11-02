import type { ActionRunContext } from "@agent-native/core/action";
import type { RequestId } from "@muscle-memory/shop-domain";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";
import { recipeRuns, requestAgentRuns, requestProcessing, requests } from "../db/schema.js";
import { ShopDemonstrations, TeachInputError } from "./shop-demonstrations.js";
import { demonstrationOwner, isAgentTool, teachNavigation } from "./teach-session.js";

/** Forward-only action capture. A thread has one request in flight; unrelated
 * request calls never move its recording or donate lookup snapshots to it. */
export class AgentRunTraces {
  constructor(private readonly db: ShopDb, private readonly teach: ShopDemonstrations) {}

  async session(context: ActionRunContext, action: { input: unknown }) {
    const owner = demonstrationOwner(context);
    if (!owner || !isAgentTool(context) || !context.threadId) return null;
    const scope = { ...owner, sessionId: `agent:${context.threadId}` };
    const demos = this.teach.demonstrations;
    try {
      const input = action.input as Record<string, unknown>;
      let active = await demos.active(scope);
      if (active && typeof input.requestId === "string" && active.subjectId !== input.requestId) return null;
      if (!active) {
        // Parallel first lookups may enter before get-request has created the slot.
        // A tab's explicit selected request can bootstrap related lookups too.
        const navigation = typeof input.requestId === "string" ? null : await teachNavigation();
        const requestId = input.requestId ?? (navigation?.view === "request" ? navigation.requestId : null);
        if (typeof requestId !== "string" || !/^req_[a-z0-9]+$/.test(requestId)) return null;
        // A stopped/incomplete recording is never silently replaced with a partial history.
        if (await demos.current(scope, requestId)) return null;
        const [request] = await this.db.select().from(requests).where(eq(requests.id, requestId as RequestId));
        if (!request || request.status === "resolved") return null;
        const snapshot = await this.teach.snapshot({ requestId: request.id });
        if (Object.entries(snapshot.references).some(([key, value]) => typeof input[key] === "string" && input[key] !== value)) return null;
        try {
          active = await demos.start({ ...snapshot, scope,
            source: { kind: "agent_run", threadId: context.threadId, runIds: [] } });
        } catch (error) {
          // Concurrent first lookups share the durable slot, never a process-local map.
          active = await demos.active(scope);
          if (!active) throw error;
        }
        if (active.subjectId !== request.id) return null;
      }
      return { scope, navigation: { view: "request", requestId: active.subjectId, path: `/requests/${active.subjectId}` } };
    } catch {
      const interrupted = await demos.active(scope).catch(() => null);
      if (interrupted)
        await demos.incomplete(scope, interrupted.id, "Agent capture could not start. Subsequent shop actions were not recorded.").catch(() => undefined);
      return null;
    }
  }

  async get(requestId: RequestId, context?: ActionRunContext) {
    const owner = demonstrationOwner(context);
    if (!owner) throw new TeachInputError("Sign in to read an agent trace.");
    const [row] = await this.db.select({ link: requestAgentRuns, request: requests, processing: requestProcessing, run: recipeRuns.checkpoint })
      .from(requestAgentRuns).innerJoin(requests, eq(requests.id, requestAgentRuns.requestId))
      .leftJoin(requestProcessing, eq(requestProcessing.requestId, requests.id))
      .leftJoin(recipeRuns, eq(recipeRuns.id, requestProcessing.runId))
      .where(and(eq(requestAgentRuns.requestId, requestId), eq(requestAgentRuns.userEmail, owner.userId),
        eq(requestAgentRuns.workspaceId, owner.workspaceId), isNotNull(requestAgentRuns.resolvedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${recipeRuns} completed WHERE completed.checkpoint->>'mode' = 'execute'
          AND completed.checkpoint->>'status' = 'completed'
          AND coalesce(completed.checkpoint->'trigger'->>'requestId', completed.checkpoint->'trigger'->>'id') = ${requests.id})`))
      .orderBy(desc(requestAgentRuns.resolvedAt)).limit(1);
    if (!row || row.request.status !== "resolved" || !row.request.category || row.run?.status === "completed" ||
      (row.processing && row.processing.match?.recipe !== null && row.run?.status !== "handed_off")) return null;
    const trace = await this.teach.demonstrations.current({ ...owner, sessionId: `agent:${row.link.threadId}` }, requestId);
    if (!trace || trace.source?.kind !== "agent_run" || trace.source.threadId !== row.link.threadId ||
      trace.status !== "completed" || trace.pending.length || trace.incompleteReason || trace.stoppedAt === null ||
      !trace.steps.some(step => step.action === "set-request-status" && step.input.requestId === requestId &&
        step.input.status === "resolved" && step.runId === row.link.runId)) return null;
    return trace;
  }
}
