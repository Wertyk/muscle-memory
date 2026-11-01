import type { AgentHandoff, HandoffContext } from "@muscle-memory/recipe-engine";
import { parseShopId, type RequestId } from "@muscle-memory/shop-domain";
import { and, eq } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { recipeHandoffs } from "../db/schema.js";

export type HandoffTransaction = Parameters<Parameters<ShopDb["transaction"]>[0]>[0];
type EscalateRequest = (tx: HandoffTransaction, input: { requestId: RequestId; reason: string }) => Promise<unknown>;

/** Durable fallback, not a claim that an agent turn has started. Installed
 * 0.222.2 sendToAgentChat is client-only; later UI opens this queued context. */
export class DrizzleAgentHandoff implements AgentHandoff {
  constructor(private readonly db: ShopDb, private readonly escalate: EscalateRequest) {}

  async handoff(context: HandoffContext): Promise<void> {
    const trigger = context.trigger;
    let requestId: RequestId | null = null;
    if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
      const fields = trigger as Record<string, unknown>;
      const candidate = fields.requestId ?? (typeof fields.id === "string" && fields.id.startsWith("req_") ? fields.id : undefined);
      if (candidate !== undefined) {
        if (typeof candidate !== "string") throw new Error("Handoff trigger has an invalid request ID.");
        const parsed = parseShopId("request", candidate);
        if (!parsed.ok) throw new Error("Handoff trigger has an invalid request ID.");
        requestId = parsed.value;
      }
    }
    await this.db.transaction(async (tx) => {
      const inserted = await tx.insert(recipeHandoffs).values({
        idempotencyKey: context.idempotencyKey, runId: context.runId, requestId,
        context: structuredClone(context), disposition: context.to === "agent" ? "with_agent" : "with_human",
      }).onConflictDoNothing().returning({ key: recipeHandoffs.idempotencyKey });
      if (!inserted.length) {
        const [existing] = await tx.select({ key: recipeHandoffs.idempotencyKey }).from(recipeHandoffs).where(and(
          eq(recipeHandoffs.idempotencyKey, context.idempotencyKey), eq(recipeHandoffs.context, context),
        ));
        if (!existing) throw new Error("Handoff key already has different context.");
        return;
      }
      if (requestId) {
        const note = typeof context.note === "string" ? context.note : JSON.stringify(context.note);
        await this.escalate(tx, { requestId, reason: `Recipe ${context.runId}/${context.stepId} ${context.reason}; with ${context.to}: ${note}` });
      }
    }).catch(() => { throw new Error("Handoff could not be persisted or the request could not be escalated."); });
  }
}
