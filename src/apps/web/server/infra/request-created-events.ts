import { AsyncLocalStorage } from "node:async_hooks";
import { emitAsync, listSubscriptions, registerEvent, subscribe } from "@agent-native/core/event-bus";
import { z } from "zod";
import type { RequestId } from "@muscle-memory/shop-domain";
import { shopId } from "../shop-action-contracts.js";

type ProcessRequest = (id: RequestId) => Promise<void>;
const payload = z.object({ requestId: shopId("request") }).strict();
const globals = globalThis as typeof globalThis & {
  muscleMemoryIntakeEvents?: { scope: AsyncLocalStorage<ProcessRequest>; subscription?: string };
};
const state = globals.muscleMemoryIntakeEvents ??= { scope: new AsyncLocalStorage<ProcessRequest>() };

/** Install before each emission (also on a cold serverless request). A single
 * subscriber uses request-local dependencies, never another caller's context. */
export class RequestCreatedEvents {
  constructor(private readonly process: ProcessRequest) {}
  async emit(requestId: RequestId): Promise<void> {
    registerEvent({ name: "request.created", description: "New shop request ready for deterministic recipe matching", payloadSchema: payload });
    if (!listSubscriptions("request.created").some((sub) => sub.id === state.subscription)) {
      state.subscription = subscribe("request.created", async (event) => {
        const handler = state.scope.getStore();
        if (!handler) throw new Error("request.created must be emitted through the intake event adapter.");
        await handler(payload.parse(event).requestId);
      });
    }
    await state.scope.run(this.process, () => emitAsync("request.created", { requestId }));
  }
}
