import type { ActionRunContext } from "@agent-native/core/action";
import type { RequestId } from "@muscle-memory/shop-domain";
import { and, eq, sql } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";
import { requestAgentRuns, requests } from "../db/schema.js";
import { demonstrationOwner, isAgentTool } from "./teach-session.js";

/** Supported action context supplies the exact framework run, without prompt parsing. */
export class AgentRequestUsage {
  constructor(private readonly db: ShopDb) {}
  async succeeded(
    action: { actionName: string; input: unknown; output: unknown },
    context?: ActionRunContext,
  ) {
    const input = action.input as Record<string, unknown> | null;
    if (
      typeof input?.requestId !== "string" ||
      !/^req_[a-z0-9]+$/.test(input.requestId)
    )
      return;
    const requestId = input.requestId as RequestId;
    const [request] = await this.db
      .select({ status: requests.status, updatedAt: requests.updatedAt })
      .from(requests)
      .where(eq(requests.id, requestId));
    if (!request) return;
    const resolving =
      action.actionName === "set-request-status" && input.status === "resolved";
    const owner = demonstrationOwner(context);
    const agent = isAgentTool(context) && owner;
    if (action.actionName === "set-request-status") {
      // Reopening or a human resolution supersedes a prior attribution.
      await this.db
        .update(requestAgentRuns)
        .set({ resolvedAt: null })
        .where(eq(requestAgentRuns.requestId, requestId));
    }
    if (
      !agent ||
      !owner ||
      !context?.runId ||
      !context.threadId ||
      (request.status === "resolved" && !resolving)
    )
      return;
    const resolvedAt = resolving ? Date.parse(request.updatedAt) : null;
    await this.db
      .insert(requestAgentRuns)
      .values({
        requestId,
        runId: context.runId,
        threadId: context.threadId,
        userEmail: owner.userId,
        workspaceId: owner.workspaceId,
        observedAt: Date.now(),
        resolvedAt,
      })
      .onConflictDoUpdate({
        target: [requestAgentRuns.requestId, requestAgentRuns.runId],
        set: {
          resolvedAt: sql`coalesce(excluded.resolved_at, ${requestAgentRuns.resolvedAt})`,
        },
        setWhere: and(
          eq(requestAgentRuns.userEmail, owner.userId),
          eq(requestAgentRuns.workspaceId, owner.workspaceId),
        )!,
      });
  }
}
