import {
  invalidInput, notFound, REQUEST_TYPES, success,
  type Request, type RequestId, type RequestType, type Result,
} from "../domain/index.js";
import type { ShopDependencies } from "./ports.js";

/** Persist a validated intake classification without replacing the original
 * message or interfering with an operator's other changes. Safe to redeliver. */
export class ClassifyRequest {
  constructor(private readonly deps: Pick<ShopDependencies, "shop" | "clock">) {}

  execute(input: { readonly requestId: RequestId; readonly type: RequestType }): Promise<Result<Request>> {
    if (!REQUEST_TYPES.includes(input.type)) return Promise.resolve(invalidInput("type", "Unknown request type"));
    return this.deps.shop.transaction(async (shop) => {
      const request = await shop.getRequest(input.requestId);
      if (!request) return notFound("request", input.requestId);
      if (request.content.source !== "free_text") return invalidInput("content", "Only free-text requests need classification");
      if (request.content.type === input.type) return success(request);
      if (request.content.type !== null) return invalidInput("type", "Request already has a different classification");
      const timestamp = this.deps.clock.now();
      if (!Number.isFinite(Date.parse(timestamp))) return invalidInput("clock", "Expected a valid timestamp");
      const updated: Request = {
        ...request, content: { ...request.content, type: input.type }, updatedAt: new Date(timestamp).toISOString(),
      };
      await shop.saveRequest(updated);
      return success(updated);
    });
  }
}
