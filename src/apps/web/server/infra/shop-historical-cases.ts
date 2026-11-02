import {
  MatchRequest, type HistoricalCase, type HistoricalCaseSource, type JsonObject,
  type JsonValue, type Mutation, type RequestExtractor, type TokenUsage,
} from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES, type Request } from "@muscle-memory/shop-domain";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import type { ShopDb } from "../db/index.js";
import { orders, refunds, replies, requests } from "../db/schema.js";
import { ExtractionError } from "./complete-text-extraction.js";

export class HistoricalReconstructionError extends Error {
  override readonly name = "HistoricalReconstructionError";
  readonly extractionError: ExtractionError | undefined;
  readonly unexpectedFailure: boolean;
  constructor(readonly requestId: string, failure: unknown) {
    const extractionError = failure instanceof ExtractionError ? failure : undefined;
    const unexpectedFailure = failure !== undefined && !extractionError;
    super(unexpectedFailure ? "Unexpected historical reconstruction failure (private details withheld)."
      : `Request ${requestId} could not be reconstructed: ${extractionError?.message ?? "free-text fields missing or invalid."}`);
    this.extractionError = extractionError;
    this.unexpectedFailure = unexpectedFailure;
  }
}

export class HistoricalDataError extends Error {
  override readonly name = "HistoricalDataError";
  constructor() { super("Couldn't read historical requests from the database."); }
}

export const historicalSelectionSchema = z.object({
  event: z.literal("request.created"), requestType: z.enum(REQUEST_TYPES),
}).strict();

/** Stored outcomes are a reconstruction, not a historical click trace. See
 * recipe-execution.md for association windows and deterministic tie ordering. */
export class ShopHistoricalCaseSource implements HistoricalCaseSource {
  private usage: TokenUsage = { input: 0, output: 0 };
  get tokens(): TokenUsage { return { ...this.usage }; }

  constructor(private readonly db: ShopDb, private readonly extractor: (request: Request) => RequestExtractor) {}

  async listCases(selection: JsonValue): Promise<readonly HistoricalCase[]> {
    const query = historicalSelectionSchema.parse(selection);
    this.usage = { input: 0, output: 0 };
    // No model call or shop operation is inside the read-only transaction.
    const snapshot = await this.db.transaction(async (tx) => {
      const selected = await tx.select().from(requests).where(and(
        eq(requests.status, "resolved"), eq(requests.category, query.requestType),
      )).orderBy(asc(requests.createdAt), asc(requests.id));
      const orderIds = [...new Set(selected.flatMap((request) => request.orderId ? [request.orderId] : []))];
      const relatedOrders = orderIds.length ? await tx.select().from(orders).where(or(
        inArray(orders.id, orderIds), inArray(orders.replacementForOrderId, orderIds),
      )) : [];
      const relatedRefunds = orderIds.length ? await tx.select().from(refunds).where(inArray(refunds.orderId, orderIds)) : [];
      const relatedReplies = selected.length ? await tx.select().from(replies).where(inArray(replies.requestId, selected.map((r) => r.id))) : [];
      return { selected, relatedOrders, relatedRefunds, relatedReplies };
    }, { isolationLevel: "repeatable read", accessMode: "read only" }).catch(() => { throw new HistoricalDataError(); });

    const cases: HistoricalCase[] = [];
    for (const { category: _category, ...request } of snapshot.selected) {
      let extractionError: unknown;
      let failureReason: string | undefined;
      // Exactly the intake pipeline: validated extraction, trusted context and
      // buildRequestTrigger inside MatchRequest; no classification/persistence.
      const match = await new MatchRequest({
        recipes: { listActive: async () => [] }, extractor: { extract: async (text) => {
          try {
            const result = await this.extractor(request).extract(text);
            failureReason = result.failureReason;
            return result;
          }
          catch (error) {
            extractionError = error ?? new Error("Unexpected extraction failure");
            throw error;
          }
        } },
      }).execute({
        event: query.event,
        context: { requestId: request.id, customerId: request.customerId, subject: request.subject },
        content: request.content.source === "structured"
          ? { source: "structured", fields: request.content.fields as unknown as JsonObject }
          : { source: "free_text", text: request.content.text },
      });
      let reconstructionFailure: string | undefined;
      if (match.reason === "extraction_failed") {
        if (extractionError && (!(extractionError instanceof ExtractionError) || extractionError.code === "not-configured"))
          throw new HistoricalReconstructionError(request.id, extractionError);
        reconstructionFailure = `Couldn't reconstruct this request from its message: ${failureReason ??
          (extractionError instanceof ExtractionError ? extractionError.message.replace(/\.$/, "") : "missing or invalid request fields")}. Extraction usage is unknown.`;
      } else this.usage = { input: this.usage.input + match.tokens.input, output: this.usage.output + match.tokens.output };

      const effects: { at: string; rank: number; id: string; mutation: Mutation }[] = [];
      const withinRequest = (at: string) => at >= request.createdAt && at <= request.updatedAt;
      for (const refund of snapshot.relatedRefunds.filter((r) => r.orderId === request.orderId && withinRequest(r.createdAt))) {
        effects.push({ at: refund.createdAt, rank: 0, id: refund.id, mutation: {
          action: "issue-refund", input: { orderId: refund.orderId, amount: { ...refund.amount }, reason: refund.reason },
        } });
      }
      for (const replacement of snapshot.relatedOrders.filter((o) => o.replacementForOrderId === request.orderId && withinRequest(o.createdAt))) {
        effects.push({ at: replacement.createdAt, rank: 1, id: replacement.id, mutation: {
          action: "create-replacement-order", input: { orderId: replacement.replacementForOrderId!,
            items: replacement.items.map(({ productId, quantity }) => ({ productId, quantity })) },
        } });
      }
      const original = snapshot.relatedOrders.find((o) => o.id === request.orderId);
      if (query.requestType === "return" && original?.returnLabel && withinRequest(original.returnLabel.createdAt)) {
        effects.push({ at: original.returnLabel.createdAt, rank: 2, id: original.returnLabel.id,
          mutation: { action: "generate-return-label", input: { orderId: original.id } } });
      }
      if (query.requestType === "address_change" && original) {
        effects.push({ at: request.updatedAt, rank: 2, id: original.id, mutation: {
          action: "update-shipping-address", input: { orderId: original.id, address: original.shippingAddress as unknown as JsonObject },
        } });
      }
      for (const reply of snapshot.relatedReplies.filter((r) => r.requestId === request.id)) {
        effects.push({ at: reply.createdAt, rank: 3, id: reply.id, mutation: {
          action: "send-reply", input: { requestId: request.id, template: reply.template, variables: reply.variables },
        } });
      }
      effects.sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank || a.id.localeCompare(b.id));
      cases.push({ id: request.id, trigger: match.trigger, ...(reconstructionFailure ? { reconstructionFailure } : {}), outcome: [
        ...effects.map((e) => e.mutation),
        ...request.tags.map((tag): Mutation => ({ action: "tag-request", input: { requestId: request.id, tag } })),
      ] });
    }
    return structuredClone(cases);
  }
}
