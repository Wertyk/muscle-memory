import type {
  CaptureTicket,
  Demonstration,
  DemonstrationOwner,
  DemonstrationScope,
  DemonstrationStep,
} from "../domain/demonstration.js";
import { jsonEqual } from "../domain/json.js";
import type { JsonObject } from "../domain/model.js";
import type { ActionEffect } from "../domain/run.js";
import type { Clock, TraceStore } from "./ports.js";

type ReadIdentity = Pick<DemonstrationStep, "action" | "input">;
const sameRead = (step: ReadIdentity, read: ReadIdentity) =>
  step.action === read.action && jsonEqual(step.input, read.input);

export class DemonstrationError extends Error {
  constructor(
    readonly code: "OVERLAP" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

/** Short store transactions only; no shop action executes inside these callbacks. */
export class Demonstrations {
  constructor(
    private readonly store: TraceStore,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  start(input: {
    source?: Demonstration["source"];
    scope: DemonstrationScope;
    subjectId: string;
    references: Readonly<Record<string, string>>;
    trigger: JsonObject;
  }): Promise<Demonstration> {
    return this.store.transaction(async (records) => {
      if (await records.active(input.scope))
        throw new DemonstrationError(
          "OVERLAP",
          "A demonstration is already recording in this session. Stop it before teaching another request.",
        );
      const previous = await records.latest(input.scope, input.subjectId);
      const demonstration: Demonstration = {
        ...input,
        source: input.source ?? { kind: "teach" },
        id: this.nextId(),
        status: "recording",
        startedAt: Math.max(this.clock.now(), (previous?.startedAt ?? -1) + 1),
        stoppedAt: null,
        incompleteReason: null,
        nextSequence: 1,
        pending: [],
        steps: [],
      };
      await records.save(demonstration);
      return demonstration;
    });
  }

  get(owner: DemonstrationOwner, id: string): Promise<Demonstration | null> {
    return this.store.transaction((records) => records.get(owner, id));
  }
  active(scope: DemonstrationScope): Promise<Demonstration | null> {
    return this.store.transaction((records) => records.active(scope));
  }
  current(
    scope: DemonstrationScope,
    subjectId: string,
  ): Promise<Demonstration | null> {
    return this.store.transaction((records) =>
      records.latest(scope, subjectId),
    );
  }
  finish(
    scope: DemonstrationScope,
    id: string,
    cancel = false,
  ): Promise<Demonstration> {
    return this.store.transaction(async (records) => {
      const demo = await records.get(scope, id);
      if (!demo || demo.scope.sessionId !== scope.sessionId)
        throw new DemonstrationError(
          "NOT_FOUND",
          "Demonstration not found in this session.",
        );
      if (demo.status !== "recording") return demo;
      const result: Demonstration = {
        ...demo,
        stoppedAt: this.clock.now(),
        status: cancel
          ? "cancelled"
          : demo.pending.length
            ? "incomplete"
            : "completed",
        incompleteReason:
          !cancel && demo.pending.length
            ? "Recording stopped with actions still in flight. Their capture may be incomplete."
            : null,
      };
      await records.save(result);
      return result;
    });
  }

  begin(input: {
    scope: DemonstrationScope;
    subjectId: string;
    references: Readonly<Record<string, string>>;
    read?: ReadIdentity;
  }): Promise<CaptureTicket | null> {
    return this.store.transaction(async (records) => {
      const demo = await records.active(input.scope);
      if (
        !demo ||
        demo.subjectId !== input.subjectId ||
        Object.entries(input.references).some(
          ([key, id]) => demo.references[key] !== id,
        )
      )
        return null;
      // Structural JSON equality canonicalizes object key order while retaining
      // array order and value types. A refetch still runs, but is not captured again.
      if (input.read && demo.steps.some((step) => sameRead(step, input.read!)))
        return null;
      const sequence = demo.nextSequence;
      await records.save({
        ...demo,
        nextSequence: sequence + 1,
        pending: [...demo.pending, sequence],
      });
      return { demonstrationId: demo.id, sequence };
    });
  }

  complete(
    scope: DemonstrationScope,
    ticket: CaptureTicket,
    step: Omit<DemonstrationStep, "id" | "sequence"> | null,
    effect: ActionEffect = "mutation",
  ): Promise<void> {
    return this.store.transaction(async (records) => {
      const demo = await records.get(scope, ticket.demonstrationId);
      if (
        !demo ||
        demo.scope.sessionId !== scope.sessionId ||
        !demo.pending.includes(ticket.sequence)
      )
        return;
      const duplicate =
        effect === "read" && step
          ? demo.steps.find((saved) => sameRead(saved, step))
          : undefined;
      // Concurrent identical reads can finish backwards. Retain the earliest
      // invocation's complete snapshot, including output/navigation/timing.
      const retain =
        step &&
        demo.status !== "cancelled" &&
        (!duplicate || ticket.sequence < duplicate.sequence);
      const steps = retain
        ? [
            ...demo.steps.filter((saved) => saved !== duplicate),
            {
              ...step,
              id: `step_${ticket.sequence}`,
              sequence: ticket.sequence,
            },
          ].sort((a, b) => a.sequence - b.sequence)
        : demo.steps;
      await records.save({
        ...demo,
        pending: demo.pending.filter((n) => n !== ticket.sequence),
        ...(step?.runId && demo.source?.kind === "agent_run" ? {
          source: { ...demo.source, runIds: [...new Set([...demo.source.runIds, step.runId])] },
        } : {}),
        steps,
      });
    });
  }

  incomplete(
    scope: DemonstrationScope,
    id: string,
    reason: string,
  ): Promise<void> {
    return this.store.transaction(async (records) => {
      const demo = await records.get(scope, id);
      if (
        !demo ||
        demo.scope.sessionId !== scope.sessionId ||
        demo.status === "cancelled"
      )
        return;
      await records.save({
        ...demo,
        status: "incomplete",
        stoppedAt: demo.stoppedAt ?? this.clock.now(),
        incompleteReason: demo.incompleteReason ?? reason,
      });
    });
  }
}
