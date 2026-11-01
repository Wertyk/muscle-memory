import type {
  ActionEffect, ActionInvoker, AgentHandoff, Clock, HandoffContext, IdGenerator,
  JsonObject, JsonValue, Run, RunRepository, TextExtractor, TokenUsage,
} from "../src/index.js";

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeClock implements Clock {
  timestamp = 1_793_620_800_000;
  now(): number { return this.timestamp; }
  advance(ms: number): void { this.timestamp += ms; }
}
export class SequentialIds implements IdGenerator {
  private sequence = 0;
  next(_kind: "run"): string { return `run_${String(++this.sequence).padStart(4, "0")}`; }
}

/** Serialized per run, detached checkpoints, and injected failures BEFORE writes. */
export class InMemoryRuns implements RunRepository {
  readonly records = new Map<string, Run>();
  readonly history: Run[] = [];
  beforeSave: ((run: Run) => void) | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();
  async create(run: Run): Promise<void> {
    if (this.records.has(run.id)) throw new Error("Duplicate run ID");
    this.records.set(run.id, clone(run));
    this.history.push(clone(run));
  }
  async get(id: string): Promise<Run | null> { return clone(this.records.get(id) ?? null); }
  async save(run: Run): Promise<void> {
    this.beforeSave?.(run);
    if (!this.records.has(run.id)) throw new Error("Unknown run ID");
    this.records.set(run.id, clone(run));
    this.history.push(clone(run));
  }
  withRunLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).then(work);
    this.locks.set(id, next.catch(() => undefined));
    return next;
  }
}

export class FakeActions implements ActionInvoker {
  readonly definitions = new Map<string, { effect: ActionEffect; run: (input: JsonObject) => JsonValue | Promise<JsonValue> }>();
  readonly calls: { action: string; input: JsonObject; context: Parameters<ActionInvoker["invoke"]>[2] }[] = [];
  define(action: string, effect: ActionEffect, run: (input: JsonObject) => JsonValue | Promise<JsonValue>): this {
    this.definitions.set(action, { effect, run });
    return this;
  }
  async describe(action: string): Promise<{ effect: ActionEffect }> {
    const definition = this.definitions.get(action);
    if (!definition) throw new Error(`Unknown action: ${action}`);
    return { effect: definition.effect };
  }
  async invoke(action: string, input: JsonObject, context: Parameters<ActionInvoker["invoke"]>[2]): Promise<JsonValue> {
    const definition = this.definitions.get(action);
    if (!definition) throw new Error(`Unknown action: ${action}`);
    this.calls.push(clone({ action, input, context }));
    return definition.run(input);
  }
}

export class FakeExtractor implements TextExtractor {
  readonly calls: Parameters<TextExtractor["extract"]>[0][] = [];
  output: JsonObject = { reason: "damaged" };
  tokens: TokenUsage = { input: 11, output: 3 };
  async extract(input: Parameters<TextExtractor["extract"]>[0]): Promise<{ output: JsonObject; tokens: TokenUsage }> {
    this.calls.push(clone(input));
    return clone({ output: this.output, tokens: this.tokens });
  }
}

export class FakeHandoff implements AgentHandoff {
  readonly attempts: HandoffContext[] = [];
  readonly deliveries = new Map<string, HandoffContext>();
  fail = false;
  async handoff(context: HandoffContext): Promise<void> {
    this.attempts.push(clone(context));
    if (this.fail) throw new Error("Handoff unavailable");
    this.deliveries.set(context.idempotencyKey, clone(context));
  }
}

export function setup() {
  const clock = new FakeClock();
  const actions = new FakeActions()
    .define("get-order", "read", () => { clock.advance(5); return { id: "ord_1042", price: 2499 }; })
    .define("issue-refund", "mutation", (input) => { clock.advance(7); return { id: "ref_0001", amount: input.amount! }; })
    .define("send-reply", "mutation", () => { clock.advance(3); return { id: "reply_0001" }; })
    .define("create-order", "mutation", () => ({ id: "ord_1043" }));
  return { actions, extractor: new FakeExtractor(), handoff: new FakeHandoff(), runs: new InMemoryRuns(), clock, ids: new SequentialIds() };
}
