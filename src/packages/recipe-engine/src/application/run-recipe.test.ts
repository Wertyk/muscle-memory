/* oxlint-disable unicorn/no-thenable -- Recipe branches have a non-callable `then` step array. */
import { describe, expect, it } from "vitest";

import { clone, setup } from "../../test/fakes.js";
import {
  parseRecipeVersion,
  RunRecipe,
  type ActionStep,
  type Binding,
  type ExtractStep,
  type JsonObject,
  type JsonValue,
  type Run,
  type Step,
} from "../index.js";

const fixed = (value: JsonValue): Binding => ({ mode: "fixed", value });
const path = (value: string): Binding => ({ mode: "path", path: value });
const action = (
  id: string,
  name: string,
  args: ActionStep["args"] = {},
): ActionStep => ({ id, kind: "action", action: name, args });
const order = action("order", "get-order", {
  orderId: path("trigger.orderId"),
});
const refund = action("refund", "issue-refund", {
  amount: {
    mode: "expr",
    expr: { round: [{ "*": [{ var: "steps.order.output.price" }, 0.5] }] },
  },
});
const reply = action("reply", "send-reply", {
  text: {
    mode: "template",
    template: "Refunded {{steps.refund.output.amount}} on {{trigger.orderId}}",
  },
});
const extract: ExtractStep = {
  id: "extract",
  kind: "extract",
  text: path("trigger.text"),
  fields: {
    reason: { type: "string", required: true, description: "Request category" },
  },
};
const trigger = {
  requestId: "req_0007",
  orderId: "ord_1042",
  text: "My mug arrived broken",
};
const version = (steps: readonly Step[]) =>
  parseRecipeVersion({
    id: "ver_0001",
    recipeId: "recipe_partial",
    version: 1,
    name: "Partial refund",
    trigger: { event: "request.created", match: true },
    steps,
  });
const start = (
  deps: ReturnType<typeof setup>,
  steps: readonly Step[],
  mode: Run["mode"] = "execute",
) => new RunRecipe(deps).execute({ recipe: version(steps), trigger, mode });
const count = (deps: ReturnType<typeof setup>, name: string) =>
  deps.actions.calls.filter((call) => call.action === name).length;

describe("RunRecipe deterministic execution and checkpoints", () => {
  it("resolves all binding modes and nested arguments, logs metrics, and persists detached snapshots (AC 1/5)", async () => {
    const deps = setup();
    const run = await start(deps, [
      order,
      refund,
      {
        ...reply,
        args: {
          ...reply.args,
          nested: {
            constant: fixed({ synthetic: true }),
            list: [path("trigger.requestId"), fixed(null)],
          },
        },
      },
    ]);
    expect(run.status).toBe("completed");
    expect(deps.actions.calls.map((call) => call.input)).toEqual([
      { orderId: "ord_1042" },
      { amount: 1250 },
      {
        text: "Refunded 1250 on ord_1042",
        nested: { constant: { synthetic: true }, list: ["req_0007", null] },
      },
    ]);
    expect(
      run.steps.map(
        ({ stepId, status, input, output, durationMs, tokens }) => ({
          stepId,
          status,
          input,
          output,
          durationMs,
          tokens,
        }),
      ),
    ).toEqual([
      {
        stepId: "order",
        status: "completed",
        input: { orderId: "ord_1042" },
        output: { id: "ord_1042", price: 2499 },
        durationMs: 5,
        tokens: { input: 0, output: 0 },
      },
      {
        stepId: "refund",
        status: "completed",
        input: { amount: 1250 },
        output: { id: "ref_0001", amount: 1250 },
        durationMs: 7,
        tokens: { input: 0, output: 0 },
      },
      {
        stepId: "reply",
        status: "completed",
        input: deps.actions.calls[2]!.input,
        output: { id: "reply_0001" },
        durationMs: 3,
        tokens: { input: 0, output: 0 },
      },
    ]);
    expect(run.tokens).toEqual({ input: 0, output: 0 });
    expect(run.pendingStepIds).toEqual([]);
    expect(deps.extractor.calls).toEqual([]);
    expect(deps.handoff.attempts).toEqual([]);
    expect(deps.actions.calls[1]!.context).toEqual({
      runId: run.id,
      stepId: "refund",
      idempotencyKey: `${run.id}:refund`,
    });
    expect(await deps.runs.get(run.id)).toEqual(run);
    expect(Object.isFrozen(run.recipe.steps)).toBe(true);
    const copy = await deps.runs.get(run.id);
    (copy!.trigger as Record<string, unknown>).orderId = "changed";
    expect((await deps.runs.get(run.id))!.trigger).toEqual(trigger);
    expect(
      deps.runs.history.some(
        (snapshot) =>
          snapshot.steps.at(-1)?.stepId === "refund" &&
          snapshot.steps.at(-1)?.status === "running",
      ),
    ).toBe(true);
  });

  it.each([true, false, []])(
    "follows nested branches with JSONLogic truthiness: %j (AC 2)",
    async (condition) => {
      const deps = setup();
      const run = await start(deps, [
        order,
        {
          id: "branch",
          kind: "branch",
          condition,
          then: [
            {
              id: "nested",
              kind: "branch",
              condition: { ">": [{ var: "steps.order.output.price" }, 2000] },
              then: [refund],
              else: [],
            },
          ],
          else: [action("other", "send-reply")],
        },
        action("after", "create-order"),
      ]);
      expect(run.status).toBe("completed");
      expect(run.steps.map((log) => log.stepId)).toEqual(
        condition === true
          ? ["order", "branch", "nested", "refund", "after"]
          : ["order", "branch", "other", "after"],
      );
      expect(run.steps[1]!.output).toEqual({
        branch: condition === true ? "then" : "else",
      });
    },
  );

  it("retains the caller's original version/trigger when paused and resumed by a new executor", async () => {
    const deps = setup();
    const recipe = clone(version([{ ...order, approval: true }]));
    const payload = clone(trigger);
    const run = await new RunRecipe(deps).execute({ recipe, trigger: payload });
    payload.orderId = "ord_changed";
    (recipe.steps as Step[])[0] = action("different", "send-reply");
    await new RunRecipe(deps).resume({
      runId: run.id,
      approval: { stepId: "order", decision: "approve" },
    });
    expect(deps.actions.calls[0]!.input).toEqual({ orderId: "ord_1042" });
  });

  it("prevents an invoker from rewriting the checkpointed input", async () => {
    const deps = setup();
    deps.actions.define("get-order", "read", (input) => {
      (input as Record<string, JsonValue>).orderId = "rewritten";
      return {};
    });
    const run = await start(deps, [order]);
    expect(run.status).toBe("handed_off");
    expect(run.steps[0]!.input).toEqual({ orderId: "ord_1042" });
    expect((await deps.runs.get(run.id))!.steps[0]!.input).toEqual({
      orderId: "ord_1042",
    });
  });
});

describe("recipe approval gates (AC 2/8)", () => {
  it.each([9999, 10000, 10001])(
    "gates the exact resolved money input at the 100-dollar boundary: %i",
    async (amountMinor) => {
      const deps = setup();
      const step = {
        ...action("refund", "issue-refund", {
          amount: { amountMinor: fixed(amountMinor), currency: fixed("USD") },
        }),
        approval: { ">": [{ var: "input.amount.amountMinor" }, 10000] },
      };
      const run = await start(deps, [step]);
      expect(run.status).toBe(
        amountMinor > 10000 ? "awaiting_approval" : "completed",
      );
      expect(run.steps[0]!.approvalRequired).toBe(amountMinor > 10000);
      expect(run.steps[0]!.input).toEqual({
        amount: { amountMinor, currency: "USD" },
      });
      if (amountMinor > 10000) {
        expect(count(deps, "issue-refund")).toBe(0);
        const approved = await new RunRecipe(deps).resume({
          runId: run.id,
          approval: { stepId: "refund", decision: "approve" },
        });
        expect(approved.status).toBe("completed");
        await new RunRecipe(deps).resume({
          runId: run.id,
          approval: { stepId: "refund", decision: "approve" },
        });
      }
      expect(count(deps, "issue-refund")).toBe(1);
      expect(deps.extractor.calls).toEqual([]);
    },
  );
  it("uses the derived input after argument resolution and reports its gate in dry-run", async () => {
    const step = {
      ...refund,
      approval: { ">": [{ var: "input.amount" }, 1000] },
    };
    const deps = setup();
    const run = await start(deps, [order, step], "dry-run");
    expect(run.status).toBe("completed");
    expect(run.steps[1]).toMatchObject({
      status: "planned",
      input: { amount: 1250 },
      approvalRequired: true,
    });
    expect(count(deps, "issue-refund")).toBe(0);
  });
  it("keeps unresolved dry-run inputs blocked before evaluating an input approval", async () => {
    const deps = setup();
    const run = await start(
      deps,
      [
        order,
        refund,
        {
          ...action("next", "issue-refund", {
            amount: path("steps.refund.output.amount"),
          }),
          approval: { var: ["input.amount", false] },
        },
      ],
      "dry-run",
    );
    expect(run.steps[2]).toMatchObject({
      status: "blocked",
      input: null,
      blockedBy: ["steps.refund.output.amount"],
    });
    expect(count(deps, "issue-refund")).toBe(0);
  });
  it.each<Step>([
    { ...order, approval: true },
    { ...extract, approval: true },
    {
      id: "branch",
      kind: "branch",
      condition: true,
      approval: true,
      then: [action("child", "send-reply")],
      else: [],
    },
    {
      id: "handoff",
      kind: "handoff",
      to: "agent",
      note: fixed("Review"),
      approval: true,
    },
  ])(
    "pauses before $kind, then approves once across repeated resume calls",
    async (step) => {
      const deps = setup();
      const paused = await start(deps, [step]);
      expect(paused.status).toBe("awaiting_approval");
      expect(paused.awaitingApprovalStepId).toBe(step.id);
      expect(paused.steps[0]).toMatchObject({
        stepId: step.id,
        status: "awaiting_approval",
        approvalRequired: true,
        tokens: { input: 0, output: 0 },
      });
      expect(deps.actions.calls).toEqual([]);
      expect(deps.extractor.calls).toEqual([]);
      expect(deps.handoff.attempts).toEqual([]);
      expect(await new RunRecipe(deps).resume({ runId: paused.id })).toEqual(
        paused,
      );
      const decision = {
        runId: paused.id,
        approval: { stepId: step.id, decision: "approve" as const },
      };
      const resumed = await new RunRecipe(deps).resume(decision);
      expect(resumed.status).toBe(
        step.kind === "handoff" ? "handed_off" : "completed",
      );
      expect(resumed.steps[0]!.attempt).toBe(1);
      expect(await new RunRecipe(deps).resume(decision)).toEqual(resumed);
      expect(
        deps.actions.calls.length +
          deps.extractor.calls.length +
          deps.handoff.attempts.length,
      ).toBe(1);
    },
  );

  it("evaluates gates against preceding outputs and excludes waiting time from duration", async () => {
    const deps = setup();
    const paused = await start(deps, [
      order,
      {
        ...refund,
        approval: { ">": [{ var: "steps.order.output.price" }, 1000] },
      },
      reply,
    ]);
    expect(paused.status).toBe("awaiting_approval");
    expect(paused.steps[1]!.input).toEqual({ amount: 1250 });
    deps.clock.advance(60_000);
    const run = await new RunRecipe(deps).resume({
      runId: paused.id,
      approval: { stepId: "refund", decision: "approve" },
    });
    expect(run.status).toBe("completed");
    expect(run.steps[1]!.durationMs).toBe(7);
    expect(count(deps, "get-order")).toBe(1);
  });

  it("rejects and permanently aborts before the gated side effect", async () => {
    const deps = setup();
    const paused = await start(deps, [
      order,
      { ...refund, approval: true },
      reply,
    ]);
    const rejected = await new RunRecipe(deps).resume({
      runId: paused.id,
      approval: { stepId: "refund", decision: "reject" },
    });
    expect(rejected.status).toBe("aborted");
    expect(rejected.steps[1]!.status).toBe("rejected");
    expect(rejected.awaitingApprovalStepId).toBeNull();
    expect(
      await new RunRecipe(deps).resume({
        runId: paused.id,
        approval: { stepId: "refund", decision: "approve" },
        retry: true,
      }),
    ).toEqual(rejected);
    expect(count(deps, "issue-refund")).toBe(0);
    expect(count(deps, "send-reply")).toBe(0);
  });

  it("does not apply stale/foreign approvals to a later gate inside a branch", async () => {
    const deps = setup();
    const run = await start(deps, [
      {
        id: "branch",
        kind: "branch",
        condition: true,
        then: [
          { ...order, approval: true },
          { ...refund, approval: true },
        ],
        else: [],
      },
    ]);
    await expect(
      new RunRecipe(deps).resume({
        runId: run.id,
        approval: { stepId: "foreign", decision: "approve" },
      }),
    ).rejects.toThrow(/pending step/);
    const decision = {
      runId: run.id,
      approval: { stepId: "order", decision: "approve" as const },
    };
    const next = await new RunRecipe(deps).resume(decision);
    expect(next.awaitingApprovalStepId).toBe("refund");
    expect(await new RunRecipe(deps).resume(decision)).toEqual(next);
    expect(count(deps, "issue-refund")).toBe(0);
    expect(
      (
        await new RunRecipe(deps).resume({
          runId: run.id,
          approval: { stepId: "refund", decision: "approve" },
        })
      ).status,
    ).toBe("completed");
  });

  it("continues when a gate condition is false", async () => {
    const deps = setup();
    const run = await start(deps, [{ ...order, approval: [] }]);
    expect(run.status).toBe("completed");
    expect(run.steps[0]!.approvalRequired).toBe(false);
  });
});

describe("handoff and failure context (AC 3)", () => {
  it.each(["agent", "human"] as const)(
    "hands explicit %s steps to the port and stops the recipe",
    async (to) => {
      const deps = setup();
      const run = await start(deps, [
        order,
        {
          id: "help",
          kind: "handoff",
          to,
          note: { mode: "template", template: "Review {{trigger.requestId}}" },
        },
        refund,
      ]);
      expect(run.status).toBe("handed_off");
      expect(deps.handoff.attempts).toHaveLength(1);
      expect(deps.handoff.attempts[0]).toMatchObject({
        runId: run.id,
        recipeVersionId: "ver_0001",
        trigger,
        stepId: "help",
        to,
        reason: "step",
        note: "Review req_0007",
        outputs: { order: { output: { id: "ord_1042", price: 2499 } } },
      });
      expect(deps.handoff.attempts[0]!.steps.map((log) => log.stepId)).toEqual([
        "order",
        "help",
      ]);
      expect(run.steps[1]).toMatchObject({
        status: "completed",
        input: { to, note: "Review req_0007" },
        output: { to, note: "Review req_0007" },
        durationMs: 0,
      });
      expect(count(deps, "issue-refund")).toBe(0);
      expect(
        await new RunRecipe(deps).resume({ runId: run.id, retry: true }),
      ).toEqual(run);
    },
  );

  it("hands unexpected action failures to the agent with resolved input and completed outputs", async () => {
    const deps = setup();
    deps.actions.define("issue-refund", "mutation", () => {
      deps.clock.advance(9);
      throw new Error("Refund policy changed");
    });
    const run = await start(deps, [order, refund, reply]);
    expect(run.status).toBe("handed_off");
    expect(run.failure).toEqual({
      stepId: "refund",
      message: "Refund policy changed",
      retryable: false,
    });
    expect(run.steps[1]).toMatchObject({
      status: "failed",
      input: { amount: 1250 },
      output: null,
      durationMs: 9,
      error: "Refund policy changed",
    });
    expect(deps.handoff.attempts[0]).toMatchObject({
      reason: "failure",
      note: "Refund policy changed",
      stepId: "refund",
      outputs: { order: { output: { id: "ord_1042", price: 2499 } } },
    });
    expect(count(deps, "send-reply")).toBe(0);
    await new RunRecipe(deps).resume({ runId: run.id, retry: true });
    expect(count(deps, "issue-refund")).toBe(1);
  });

  it.each([
    action("bad", "not-registered"),
    action("bad", "send-reply", { value: path("trigger.missing") }),
    {
      id: "bad",
      kind: "branch",
      condition: { "/": [1, 0] },
      then: [],
      else: [],
    } as Step,
  ])(
    "hands metadata/evaluation failures off instead of continuing",
    async (step) => {
      const deps = setup();
      const run = await start(deps, [step, action("after", "send-reply")]);
      expect(run.status).toBe("handed_off");
      expect(run.steps[0]!.status).toBe("failed");
      expect(deps.handoff.attempts[0]!.reason).toBe("failure");
      expect(deps.actions.calls).toEqual([]);
    },
  );

  it("rejects malformed external action output and fails closed on invalid effect metadata", async () => {
    const deps = setup();
    deps.actions.define("get-order", "read", () => ({ price: Infinity }));
    const invalidOutput = await start(deps, [order, refund]);
    expect(invalidOutput.failure!.message).toMatch(/finite JSON/);
    deps.actions.describe = async () => ({ effect: "unknown" as "read" });
    const invalidEffect = await start(deps, [order]);
    expect(invalidEffect.failure!.message).toMatch(/effect/);
    expect(deps.actions.calls).toHaveLength(1);
  });

  it.each([false, true])(
    "retries a failed handoff delivery only, explicit=%s",
    async (explicit) => {
      const deps = setup();
      deps.handoff.fail = true;
      if (!explicit)
        deps.actions.define("get-order", "read", () => {
          throw new Error("Read failed");
        });
      const run = await start(
        deps,
        explicit
          ? [
              order,
              { id: "help", kind: "handoff", to: "agent", note: fixed("Help") },
            ]
          : [order],
      );
      expect(run.status).toBe("failed");
      expect(run.handoff).toMatchObject({
        status: "pending",
        error: "Handoff unavailable",
      });
      deps.handoff.fail = false;
      const resumed = await new RunRecipe(deps).resume({ runId: run.id });
      expect(resumed.status).toBe("handed_off");
      expect(deps.handoff.attempts).toHaveLength(2);
      expect(deps.handoff.attempts[0]!.idempotencyKey).toBe(
        deps.handoff.attempts[1]!.idempotencyKey,
      );
      expect(deps.handoff.deliveries.size).toBe(1);
      expect(count(deps, "get-order")).toBe(1);
      if (explicit) expect(resumed.steps.at(-1)!.status).toBe("completed");
    },
  );
});

describe("extraction metrics and typed output (AC 4)", () => {
  it("extracts typed fields, resolves downstream bindings, and totals tokens across steps", async () => {
    const deps = setup();
    const run = await start(deps, [
      extract,
      {
        ...extract,
        id: "again",
        text: path("steps.extract.output.reason"),
      },
      action("reply", "send-reply", {
        category: path("steps.again.output.reason"),
      }),
    ]);
    expect(run.status).toBe("completed");
    expect(deps.extractor.calls).toEqual([
      { text: trigger.text, fields: extract.fields },
      { text: "damaged", fields: extract.fields },
    ]);
    expect(run.steps[0]).toMatchObject({
      input: { text: trigger.text, fields: extract.fields },
      output: { reason: "damaged" },
      tokens: { input: 11, output: 3 },
    });
    expect(run.tokens).toEqual({ input: 22, output: 6 });
    expect(deps.actions.calls[0]!.input).toEqual({ category: "damaged" });
  });

  it.each<JsonObject>([
    {},
    { reason: 7 },
    { reason: null },
    { reason: "damaged", extra: true },
    { reason: Infinity },
  ])(
    "counts consumed tokens even when extracted output %j is invalid",
    async (output) => {
      const deps = setup();
      deps.extractor.output = output;
      const run = await start(deps, [extract, action("after", "send-reply")]);
      expect(run.status).toBe("handed_off");
      expect(run.steps[0]!.status).toBe("failed");
      expect(run.tokens).toEqual({ input: 11, output: 3 });
      expect(deps.actions.calls).toHaveLength(0);
    },
  );

  it("supports omitted optional fields and validates all declared primitive types", async () => {
    const deps = setup();
    deps.extractor.output = { number: 2, boolean: false };
    const run = await start(deps, [
      {
        ...extract,
        fields: {
          reason: { type: "string", required: false },
          number: { type: "number", required: true },
          boolean: { type: "boolean", required: true },
        },
      },
    ]);
    expect(run.status).toBe("completed");
    expect(run.steps[0]!.output).toEqual(deps.extractor.output);
  });

  it("retains failed extraction usage when safely retrying", async () => {
    const deps = setup();
    deps.extractor.output = {};
    const failed = await start(deps, [extract]);
    deps.extractor.output = { reason: "damaged" };
    const run = await new RunRecipe(deps).resume({
      runId: failed.id,
      retry: true,
    });
    expect(run.status).toBe("completed");
    expect(run.steps.map((log) => log.status)).toEqual(["failed", "completed"]);
    expect(run.tokens).toEqual({ input: 22, output: 6 });
  });

  it.each([
    { input: -1, output: 1 },
    { input: 2.5, output: 1 },
    { input: Infinity, output: 1 },
  ])("rejects invalid token usage %j", async (tokens) => {
    const deps = setup();
    deps.extractor.tokens = tokens;
    const run = await start(deps, [extract]);
    expect(run.failure!.message).toMatch(/token usage/);
    expect(run.tokens).toEqual({ input: 0, output: 0 });
  });

  it("hands extractor exceptions off, and never calls it for non-text input", async () => {
    const deps = setup();
    deps.extractor.extract = async () => {
      throw new Error("Extractor offline");
    };
    expect((await start(deps, [extract])).failure!.message).toBe(
      "Extractor offline",
    );
    const badInput = await start(deps, [{ ...extract, text: fixed(12) }]);
    expect(badInput.failure!.message).toMatch(/string/);
    expect(badInput.tokens).toEqual({ input: 0, output: 0 });
  });
});

describe("dry-run safety and intended mutations (AC 6)", () => {
  it("executes reads/extraction but only reports mutations and handoff, without waiting for approval", async () => {
    const deps = setup();
    const run = await start(
      deps,
      [
        order,
        extract,
        { ...refund, approval: true },
        action("reply", "send-reply", {
          text: path("steps.extract.output.reason"),
        }),
        { id: "handoff", kind: "handoff", to: "agent", note: fixed("Help") },
        action("after", "create-order"),
      ],
      "dry-run",
    );
    expect(run.status).toBe("completed");
    expect(deps.actions.calls.map((call) => call.action)).toEqual([
      "get-order",
    ]);
    expect(deps.extractor.calls).toHaveLength(1);
    expect(deps.handoff.attempts).toEqual([]);
    expect(run.steps.map((log) => [log.stepId, log.status])).toEqual([
      ["order", "completed"],
      ["extract", "completed"],
      ["refund", "planned"],
      ["reply", "planned"],
      ["handoff", "planned"],
    ]);
    expect(run.steps[2]).toMatchObject({
      action: "issue-refund",
      effect: "mutation",
      approvalRequired: true,
      input: { amount: 1250 },
      output: null,
    });
    expect(run.steps[3]!.input).toEqual({ text: "damaged" });
    expect(run.tokens).toEqual({ input: 11, output: 3 });
    expect(
      await new RunRecipe(deps).resume({ runId: run.id, retry: true }),
    ).toEqual(run);
  });

  it("marks dependencies blocked, including conditional defaults, while independent reads still execute", async () => {
    const deps = setup();
    const run = await start(
      deps,
      [
        order,
        refund,
        action("dependentRead", "get-order", {
          orderId: path("steps.refund.output.id"),
        }),
        {
          ...extract,
          id: "dependentExtract",
          text: path("steps.refund.output.id"),
        },
        {
          id: "branch",
          kind: "branch",
          condition: { var: ["steps.refund.output.id", true] },
          then: [action("unsafe", "send-reply")],
          else: [],
        },
        { ...reply, approval: { var: ["steps.refund.output.id", false] } },
        action("independentRead", "get-order"),
      ],
      "dry-run",
    );
    expect(run.status).toBe("completed");
    expect(run.steps.map((log) => [log.stepId, log.status])).toEqual([
      ["order", "completed"],
      ["refund", "planned"],
      ["dependentRead", "blocked"],
      ["dependentExtract", "blocked"],
      ["branch", "blocked"],
      ["reply", "blocked"],
      ["independentRead", "completed"],
    ]);
    expect(run.steps[2]).toMatchObject({
      input: null,
      output: null,
      blockedBy: ["steps.refund.output.id"],
    });
    expect(run.steps[5]!.effect).toBe("mutation");
    expect(deps.actions.calls.map((call) => call.action)).toEqual([
      "get-order",
      "get-order",
    ]);
    expect(deps.extractor.calls).toEqual([]);
    expect(deps.handoff.attempts).toEqual([]);
  });

  it("takes branches whose conditions can be evaluated and suppresses failure handoff delivery", async () => {
    const deps = setup();
    const run = await start(
      deps,
      [
        {
          id: "branch",
          kind: "branch",
          condition: true,
          then: [action("planned", "send-reply")],
          else: [],
        },
        action("missing", "unknown"),
      ],
      "dry-run",
    );
    expect(run.status).toBe("failed");
    expect(run.steps[1]!.status).toBe("planned");
    expect(run.steps[2]!.status).toBe("failed");
    expect(deps.actions.calls).toEqual([]);
    expect(deps.handoff.attempts).toEqual([]);
  });
});

describe("idempotent resume, retry and interrupted checkpoints (AC 8)", () => {
  it("never repeats completed refunds, replies or orders through pause, safe retry, and terminal resume", async () => {
    const deps = setup();
    let fail = true;
    deps.actions.define("check", "read", () => {
      if (fail) throw new Error("Temporary read failure");
      return { ready: true };
    });
    const paused = await start(deps, [
      order,
      refund,
      reply,
      action("replacement", "create-order"),
      {
        id: "branch",
        kind: "branch",
        condition: true,
        then: [{ ...action("check", "check"), approval: true }],
        else: [],
      },
    ]);
    expect(paused.status).toBe("awaiting_approval");
    const failed = await new RunRecipe(deps).resume({
      runId: paused.id,
      approval: { stepId: "check", decision: "approve" },
    });
    expect(failed.status).toBe("handed_off");
    expect(failed.failure!.retryable).toBe(true);
    fail = false;
    const run = await new RunRecipe(deps).resume({
      runId: paused.id,
      retry: true,
    });
    expect(run.status).toBe("completed");
    expect(
      run.steps
        .filter((log) => log.stepId === "check")
        .map((log) => [log.attempt, log.status]),
    ).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(
      await new RunRecipe(deps).resume({ runId: run.id, retry: true }),
    ).toEqual(run);
    for (const name of [
      "issue-refund",
      "send-reply",
      "create-order",
      "get-order",
    ])
      expect(count(deps, name)).toBe(1);
    expect(count(deps, "check")).toBe(2);
  });

  it("serializes competing approvals/resumes through the repository", async () => {
    const deps = setup();
    const paused = await start(deps, [
      order,
      { ...refund, approval: true },
      reply,
    ]);
    const input = {
      runId: paused.id,
      approval: { stepId: "refund", decision: "approve" as const },
    };
    const results = await Promise.all([
      new RunRecipe(deps).resume(input),
      new RunRecipe(deps).resume(input),
      new RunRecipe(deps).resume(input),
    ]);
    expect(results.map((run) => run.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(count(deps, "issue-refund")).toBe(1);
    expect(count(deps, "send-reply")).toBe(1);
  });

  it("does not invoke a mutation if its intent checkpoint cannot be persisted", async () => {
    const deps = setup();
    deps.runs.beforeSave = () => {
      throw new Error("Storage offline");
    };
    await expect(start(deps, [action("reply", "send-reply")])).rejects.toThrow(
      "Storage offline",
    );
    expect(deps.actions.calls).toEqual([]);
    deps.runs.beforeSave = undefined;
    expect(
      (await new RunRecipe(deps).resume({ runId: "run_0001" })).status,
    ).toBe("completed");
    expect(count(deps, "send-reply")).toBe(1);
  });

  it("hands off an uncertain mutation after losing its completion checkpoint; never replays it", async () => {
    const deps = setup();
    deps.runs.beforeSave = (run) => {
      if (
        run.steps.some(
          (log) => log.stepId === "refund" && log.status === "completed",
        )
      )
        throw new Error("Lost completion write");
    };
    await expect(start(deps, [order, refund, reply])).rejects.toThrow(
      "Lost completion write",
    );
    expect(count(deps, "issue-refund")).toBe(1);
    expect(deps.handoff.attempts).toEqual([]);
    expect((await deps.runs.get("run_0001"))!.steps.at(-1)!.status).toBe(
      "running",
    );
    deps.runs.beforeSave = undefined;
    const run = await new RunRecipe(deps).resume({ runId: "run_0001" });
    expect(run.status).toBe("handed_off");
    expect(deps.handoff.attempts[0]).toMatchObject({
      reason: "interrupted",
      stepId: "refund",
      outputs: { order: { output: { id: "ord_1042", price: 2499 } } },
    });
    await new RunRecipe(deps).resume({ runId: run.id, retry: true });
    expect(count(deps, "issue-refund")).toBe(1);
    expect(count(deps, "send-reply")).toBe(0);
  });

  it("continues after a completed mutation when the next intent checkpoint fails", async () => {
    const deps = setup();
    deps.runs.beforeSave = (run) => {
      if (run.steps.at(-1)?.stepId === "reply")
        throw new Error("Next intent write failed");
    };
    await expect(start(deps, [order, refund, reply])).rejects.toThrow(
      /intent write/,
    );
    deps.runs.beforeSave = undefined;
    const run = await new RunRecipe(deps).resume({ runId: "run_0001" });
    expect(run.status).toBe("completed");
    expect(count(deps, "issue-refund")).toBe(1);
    expect(count(deps, "send-reply")).toBe(1);
  });

  it("recovers a lagging branch cursor without repeating completed child side effects", async () => {
    const deps = setup();
    const run = await start(deps, [
      order,
      {
        id: "branch",
        kind: "branch",
        condition: true,
        then: [refund, reply],
        else: [],
      },
      action("replacement", "create-order"),
    ]);
    deps.runs.records.set(
      run.id,
      clone({
        ...run,
        status: "running",
        pendingStepIds: ["branch", "replacement"],
      }),
    );
    expect((await new RunRecipe(deps).resume({ runId: run.id })).status).toBe(
      "completed",
    );
    for (const name of ["issue-refund", "send-reply", "create-order"])
      expect(count(deps, name)).toBe(1);
  });

  it("retries handoff with a stable key after a delivered handoff's checkpoint is lost", async () => {
    const deps = setup();
    deps.runs.beforeSave = (run) => {
      if (run.handoff?.status === "delivered")
        throw new Error("Delivery checkpoint lost");
    };
    await expect(
      start(deps, [
        { id: "help", kind: "handoff", to: "agent", note: fixed("Help") },
      ]),
    ).rejects.toThrow(/checkpoint lost/);
    expect(deps.handoff.deliveries.size).toBe(1);
    deps.runs.beforeSave = undefined;
    expect(
      (await new RunRecipe(deps).resume({ runId: "run_0001" })).status,
    ).toBe("handed_off");
    expect(deps.handoff.attempts).toHaveLength(2);
    expect(deps.handoff.deliveries.size).toBe(1);
  });
});

describe("run boundary validation", () => {
  it("rejects missing runs, invalid trigger/mode/IDs, and ID collisions without invoking actions", async () => {
    const deps = setup();
    const engine = new RunRecipe(deps);
    await expect(engine.resume({ runId: "run_missing" })).rejects.toThrow(
      /not found/,
    );
    await expect(
      engine.execute({ recipe: version([order]), trigger: Infinity }),
    ).rejects.toThrow(/Trigger/);
    await expect(
      engine.execute({
        recipe: version([order]),
        trigger,
        mode: "unknown" as "execute",
      }),
    ).rejects.toThrow(/mode/);
    deps.ids.next = () => "run_0001";
    await start(deps, [{ ...order, approval: true }]);
    await expect(start(deps, [order])).rejects.toThrow(/Duplicate/);
    deps.ids.next = () => "run_123456789012345678901234567890123456789";
    await expect(start(deps, [order])).rejects.toThrow(/short run/);
    expect(deps.actions.calls).toEqual([]);
  });
});
