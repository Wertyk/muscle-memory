import type { Correction, CorrectionOwner, CorrectionVersion } from "../domain/correction.js";

export const CORRECTION_WINDOW_MS = 30 * 60 * 1000;
export interface CorrectionRun {
  readonly id: string;
  readonly requestId: string;
  readonly orderId: string | null;
  readonly currentTags: readonly string[];
  readonly recipe: CorrectionVersion;
  readonly status: string;
  readonly mode: string;
  readonly automatic: boolean;
  readonly completedAt: number;
  readonly approvedStepIds: readonly string[];
  readonly steps: readonly {
    readonly stepId: string;
    readonly action: string | null;
    readonly status: string;
    readonly input: unknown;
    readonly output: unknown;
  }[];
}
export interface CorrectionRecords {
  latestRun(requestId: string): Promise<CorrectionRun | null>;
  list(filter: { requestId?: string; runId?: string; recipeId?: string; versionId?: string }): Promise<readonly Correction[]>;
  get(id: string): Promise<Correction | null>;
  save(correction: Correction): Promise<void>;
}
/** Transactions run once; proposal/activation ports must use the same transaction. */
export interface CorrectionStore extends CorrectionRecords {
  transaction<T>(work: (records: CorrectionRecords) => Promise<T>): Promise<T>;
}
export interface CorrectionCall {
  readonly caller?: string | undefined;
  readonly runId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly owner: CorrectionOwner | null;
  readonly requestId: string | null;
  readonly action: string;
  readonly input: unknown;
}
export class CorrectionError extends Error {}
function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function isCorrectionCall(call: CorrectionCall): boolean {
  return call.caller === "frontend" && !call.runId && !call.toolCallId && !call.threadId &&
    !!call.owner && !!call.requestId && ["send-reply", "issue-refund", "tag-request"].includes(call.action);
}
function owns(owner: CorrectionOwner, correction: Correction) {
  return owner.userId === correction.owner.userId && owner.workspaceId === correction.owner.workspaceId;
}
function required(value: Correction | null, owner: CorrectionOwner): Correction {
  if (!value || !owns(owner, value)) throw new CorrectionError("Correction not found.");
  return value;
}

/** Captures typed effects only. No text inference and no model calls. */
export class Corrections {
  constructor(private readonly store: CorrectionStore, private readonly now: () => number, private readonly nextId: () => string) {}
  list(owner: CorrectionOwner, filter: Parameters<CorrectionRecords["list"]>[0]) {
    return this.store.list(filter).then(rows => rows.filter(row => owns(owner, row)));
  }
  async begin(call: CorrectionCall): Promise<((output: unknown) => Promise<void>) | null> {
    if (!isCorrectionCall(call)) return null;
    const startedAt = this.now();
    const run = await this.store.latestRun(call.requestId!);
    if (!run || run.requestId !== call.requestId || run.mode !== "execute" || !run.automatic || run.status !== "completed" ||
      run.approvedStepIds.length || startedAt < run.completedAt || startedAt - run.completedAt > CORRECTION_WINDOW_MS) return null;
    const input = object(call.input);
    const key = call.action === "issue-refund" ? "orderId" : "requestId";
    const target = key === "orderId" ? run.orderId : run.requestId;
    if (!target || input[key] !== target) return null;
    if (call.action === "tag-request" && typeof input.tag === "string" && run.currentTags.includes(input.tag.trim())) return null;
    const step = [...run.steps].reverse().find(step => step.status === "completed" && step.action === call.action && object(step.input)[key] === target);
    if (!step) return null;
    const evidence = snapshot({ call, run, step });
    return async (output) => {
      // A redundant tag/refetch or identical reply is not a correction.
      const before = object(evidence.step.output);
      const after = object(output);
      if (evidence.call.action === "send-reply" && before.body === after.body) return;
      if (evidence.call.action === "tag-request" && Array.isArray(before.tags) && before.tags.includes(object(evidence.call.input).tag)) return;
      await this.store.save({
        id: this.nextId(), owner: evidence.call.owner!, requestId: evidence.run.requestId,
        runId: evidence.run.id, recipe: evidence.run.recipe, stepId: evidence.step.stepId,
        action: evidence.call.action as Correction["action"], originalInput: evidence.step.input,
        originalOutput: evidence.step.output, input: evidence.call.input, output: snapshot(output),
        createdAt: startedAt, status: "recorded", proposal: null, decision: null,
      });
    };
  }
  propose<T extends CorrectionVersion>(owner: CorrectionOwner, id: string, notes: unknown, saveVersion: () => Promise<T>): Promise<T> {
    return this.store.transaction(async records => {
      const correction = required(await records.get(id), owner);
      if (correction.status !== "recorded") throw new CorrectionError("Correction already has a proposal or decision. Read it before retrying.");
      const version = await saveVersion();
      if (version.recipeId !== correction.recipe.recipeId || version.version <= correction.recipe.version || version.id === correction.recipe.id)
        throw new CorrectionError("Proposal must be a new version of the corrected recipe.");
      await records.save({ ...correction, status: "proposed", proposal: { version: { id: version.id, recipeId: version.recipeId, version: version.version }, notes: snapshot(notes) } });
      return version;
    });
  }
  activate<T>(owner: CorrectionOwner, recipeId: string, versionId: string, activateVersion: () => Promise<T>): Promise<T> {
    return this.store.transaction(async records => {
      const corrections = await records.list({ versionId });
      if (corrections.some(c => c.status === "rejected")) throw new CorrectionError("This correction proposal was rejected and cannot be activated.");
      for (const correction of corrections) {
        required(correction, owner);
        if (correction.proposal?.version.recipeId !== recipeId) throw new CorrectionError("Proposal recipe does not match.");
      }
      const result = await activateVersion();
      for (const correction of corrections) {
        if (correction.status !== "proposed") continue;
        await records.save({ ...correction, status: "accepted", decision: { at: this.now(), by: owner, reason: null } });
      }
      return result;
    });
  }
  async reject(owner: CorrectionOwner, id: string, reason: string): Promise<Correction> {
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 1000) throw new CorrectionError("Give a rejection reason (1–1000 characters).");
    return this.store.transaction(async records => {
      const correction = required(await records.get(id), owner);
      if (correction.status === "rejected" && correction.decision?.reason === trimmed) return correction;
      if (correction.status !== "proposed") throw new CorrectionError("Only a pending proposal can be rejected.");
      const next: Correction = { ...correction, status: "rejected", decision: { at: this.now(), by: owner, reason: trimmed } };
      await records.save(next);
      return next;
    });
  }
}
