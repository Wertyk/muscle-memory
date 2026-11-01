# Recipe engine

Pure, domain-agnostic recipe DSL, evaluation, demonstration provenance inference, and execution.
Import the public API from `@muscle-memory/recipe-engine`.
The domain has no external dependencies; application validation depends only on Zod.
Execution uses injected ports; this package contains no framework, DB, or LLM adapters.
Selecting/resolving a draft's trigger and doubts remains a subsequent use-case.

## Execution (TASK-14 Phase 1)

`RunRecipe` takes `RunRecipeDependencies`: `actions` (`ActionInvoker`), `extractor`
(`TextExtractor`), `handoff` (`AgentHandoff`), `runs` (`RunRepository`), `clock` (`Clock`),
and `ids` (`IdGenerator`). All interfaces and run models are exported from the public API.
`test/fakes.ts` supplies detached in-memory adapters for unit tests, without network calls.

```ts
const executor = new RunRecipe({ actions, extractor, handoff, runs, clock, ids });
const run = await executor.execute({ recipe: version, trigger: payload });
// Gates apply to every step kind, independently of framework action approvals.
if (run.status === "awaiting_approval") {
  await executor.resume({
    runId: run.id,
    approval: { stepId: run.awaitingApprovalStepId!, decision: "approve" },
  });
  // decision: "reject" permanently aborts the run before this step executes.
}
```

Start validates and snapshots the version and trigger. Matching the trigger event/condition
is the caller's responsibility. The run stores its immutable version, mode, trigger, pending
step IDs, approval decisions, logs, and token totals. Resume takes only a run ID and optional
decision/retry; it cannot substitute a different version, payload, or mode. The pending queue
preserves the selected branch and the continuation after nested branches across pauses.
Approvals are scoped to a step; replaying an earlier approval cannot approve a later gate.

Each visited step has an attempt log with status, resolved input, output, active duration in
milliseconds, input/output tokens, timestamps, and any error. Unselected branch children are
not visited/logged. Branch output records `{branch: "then" | "else"}` as control-flow metadata;
as required by the DSL, branch/handoff outputs are not binding sources. A rejected gate has
`rejected` status; the run becomes `aborted`. Approval waiting is excluded from step duration.
Retries append attempts, retaining failures and their consumed extraction tokens. The run's
`tokens` sums all attempts; total tokens are `tokens.input + tokens.output`.

Extraction resolves text to a string, calls the port with the typed fields, validates required
fields and primitive types, rejects undeclared fields, and counts the returned token usage
even if output validation fails. Adapters must return nonnegative safe integer usage and
bounded finite JSON. Action adapters must turn unsuccessful action results into exceptions.
No model is involved in an action/branch-only happy path.

Explicit handoff terminates recipe execution and sends the requested `agent`/`human` target,
resolved note, trigger, version/run/step IDs, prior outputs, and logs to `AgentHandoff`.
Unexpected failures go to the same port with reason `failure`; interrupted attempts use
`interrupted`. Handoff delivery is checkpointed and retryable independently of shop actions.
A failed delivery leaves `status: "failed"`, `handoff.status: "pending"`; plain `resume`
retries only delivery. Successful delivery gives `handed_off` and stops the recipe.
After a failure, `resume({runId, retry: true})` can explicitly retry a safe read, extraction,
or evaluation; failed/interrupted mutations require reconciliation by the agent instead.

### Checkpoints and adapter obligations

The repository must durably save the running intent before an external call, then its result
and cursor together. It must serialize the entire start/resume operation per run **across
workers**, including loading, external calls, and individual checkpoint writes. Locking is
not a transaction that can roll back prior checkpoints, and callbacks must never be retried
automatically. `create` rejects ID collisions; `save` rejects missing records. Run IDs are
short strings such as `run_0001`. The clock returns finite epoch milliseconds.

Resume reuses completed results and never repeats completed mutations. If a worker loses the
result checkpoint after an action may have run, the persisted `running` attempt is handed off
instead of replayed. Action calls also receive a stable `runId:stepId` idempotency key, which
adapters can propagate. Handoff delivery retries use their own stable key; the handoff adapter
must deduplicate it. This avoids blind replay without claiming atomicity between the engine
repository and an external side effect. Usage lost in a process crash cannot be reconstructed
by the engine.

### Dry-run

`execute({recipe, trigger, mode: "dry-run"})` invokes reads and extraction (counting actual
tokens), while mutations have `planned` logs containing the action name and intended input.
These logs are the intended-mutation report; filter by `effect === "mutation"`. Approval
requirements are reported but do not pause a simulation. No agent/human handoff is delivered,
including on failure; explicit handoff is logged as planned and ends the simulation.

The engine does not invent mutation outputs. Steps depending on them have `blocked` status,
`input: null`, and `blockedBy` source paths. This check includes expression defaults and
approval conditions so missing outputs cannot silently choose a branch. A blocked branch's
children are not simulated; independent later steps still run. A completed dry-run can
therefore contain blocked steps and is not evidence that those paths succeeded.

Framework invoker/extraction/handoff adapters, real actions, and DB persistence are TASK-14
**Phase 2**, after TASK-3 and TASK-6 merge. Phase 1 verifies the engine side of AC #1/#5 and
AC #2–#4/#6–#8 with fakes. No `apps/web` integration is included here.

## Validated versions

`parseRecipeVersion(unknown)` (or `recipeVersionSchema.parse` / `.safeParse`) validates a
version and returns a detached, recursively frozen snapshot. Its TypeScript type is also
readonly. Editing requires a new snapshot with a new version identity/number; a repository
must enforce that an existing stored identity cannot be overwritten.

```ts
const version = parseRecipeVersion({
  id: "ver_0001", recipeId: "recipe_partial", version: 1, name: "Partial refund",
  trigger: {
    event: "request.created",
    match: { "===": [{ var: "trigger.reason" }, "damaged"] },
  },
  steps: [
    { id: "order", kind: "action", action: "get-order",
      args: { orderId: { mode: "path", path: "trigger.orderId" } } },
    { id: "refund", kind: "action", action: "issue-refund",
      approval: { ">": [{ var: "steps.order.output.price" }, 100] },
      args: { amount: { mode: "expr", expr: {
        round: [{ "*": [{ var: "steps.order.output.price" }, 0.5] }],
      } } } },
  ],
});
```

Steps have globally unique short identifiers (at most 31 characters). All step kinds may
have an `approval` condition, evaluated before the step, when its own output is unavailable:

- `action`: `action` name and `args`, an object of binding trees. Nested objects and arrays
  retain their shape; a binding can also supply an entire object or array.
- `extract`: `text` binding and nonempty `fields` map. Each field has `type`
  (`string`, `number`, `boolean`), `required`, and optional `description`.
- `branch`: `condition` expression, `then` and `else` step arrays.
- `handoff`: `to` (`agent` or `human`) and `note` binding.

Bindings are `{mode:"fixed", value}`, `{mode:"path", path}`, `{mode:"expr", expr}`,
or `{mode:"template", template}`. Templates use `{{trigger.name}}` or
`{{steps.order.output.items[0].name}}` placeholders; surrounding placeholder whitespace
is allowed. Missing paths fail explicitly. Interpolation accepts only scalars (null becomes
an empty string), and never recursively expands a source value as another template.

All paths are rooted at `trigger` or `steps.<id>.output`; array indices accept `[0]` or `.0`.
Only own properties can be read. Prototype-related keys and arbitrary root names are rejected.
Validation checks references in expressions, templates, approvals, and nested argument trees.
A step can reference earlier unconditional action/extract outputs and ancestor outputs.
A branch child cannot reference the other branch, and its output is unavailable after the
branch because the child might not execute. Branch/handoff steps supply no data output.
Trigger matches can depend only on the trigger.

## Safe expression subset

`evaluateExpression(expr, {trigger, steps})` returns a JSON value;
`evaluateCondition` applies JSONLogic truthiness (including false for empty arrays).
`resolveBinding`, `resolveBindingTree`, and `resolveArguments` use the same evaluator.

Supported operators: `var`, `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, `+`, `-`,
`*`, `/`, `%`, `min`, `max`, `round`, `floor`, `ceil`, `and`, `or`, `!`, `!!`, `if`, `cat`, `in`.
Expressions use single-key JSONLogic operator objects, scalars, and arrays. This is an
explicit subset, with no custom operators, JavaScript evaluation, or method calls.
Arithmetic requires finite numbers, ordered comparisons require two numbers or two strings,
and loose equality coerces only scalars. Operators have checked arities; `if` uses condition/
value pairs plus a final default. `and`, `or`, `if`, and `var` defaults short circuit.
`var` returns null when missing unless given a default (`{var:["trigger.x", 0]}`);
an existing null value stays null. No object coercion occurs.

The integer rounding extensions each accept one finite numeric argument. `round` rounds
to the nearest integer with half ties away from zero (`1249.5` → `1250`, `-1249.5` →
`-1250`); `floor` rounds toward negative infinity and `ceil` toward positive infinity.
Zero results are normalized to zero. These operators allow explicit minor-unit rules,
for example `{round:[{"*":[{var:"steps.order.output.price"}, 0.5]}]}` for a half-price
refund when money is integer cents. Strings, booleans, null, arrays, and non-finite
inputs/results are rejected rather than coerced into numbers.

Unknown operators, unsafe paths, malformed templates, non-finite values/results, cycles,
and excessive input complexity fail explicitly. Expressions allow at most 32 nested levels,
1,024 expression nodes, and 64 operands per variadic operator. All input JSON is limited
to 64 levels and 20,000 nodes before recursive validation/inference.

## Provenance proposals

`inferBindings(trace, triggerPayload)` consumes the minimal successful-trace projection:

```ts
const trace = {
  id: "demo_0001",
  steps: [{ id: "order", action: "get-order",
    input: { orderId: "ord_1042" }, output: { price: 2499 } },
    { id: "refund", action: "issue-refund",
      input: { amount: 1250 }, output: { amount: 1250 } }],
};
const draft = inferBindings(trace, { orderId: "ord_1042" });
// draft.steps can become a RecipeVersion's steps after resolving draft.ambiguities.
```

Capture adapters may retain navigation, timing, caller, and other metadata. Inference
uses only `id`, `action`, `input`, and `output`; it assumes successful steps in execution
order. It never sorts steps, invokes actions, accesses storage, or calls a model.

For each argument, inference searches the trigger and strictly earlier outputs, including
array elements and structurally equal objects. Object keys are traversed in sorted order
so property insertion order does not affect proposals. Priority is:

1. Exact structural matches (with all matching source paths as competing candidates).
2. Otherwise, recurse into nonempty object/array arguments to infer their leaves.
3. For numbers, exact products using bounded scale factors (`INFERENCE_SCALES`, including
   0.5), then exact differences of two source numbers. These unrounded formulas rank ahead
   of integer-rounded products from every source. For an integer observation, when a
   product differs from the observed value, matching `round`, `floor`, and `ceil` wrappers
   are proposed with reason `rounded-scale`, in that order. Thus 2499 × 0.5 → 1250 proposes
   `round` (with `ceil` as an alternative), and → 1249 proposes `floor`; 2400 × 0.5 → 1200
   stays an exact scale without redundant rounding wrappers. Every proposed binding must
   reproduce the observation exactly. No arbitrary ratio fitting or offsets are invented.
4. For text, longest non-overlapping whole source tokens, including numeric tokens, become
   placeholders. Repeated equal tokens use the same source within a candidate. Competing
   source assignments produce alternative templates. Existing literal `{{` / `}}` syntax
   is kept fixed. Keys outside the identifier grammar cannot be inferred as source paths.
5. Otherwise, a fixed value.

The result is a detached frozen snapshot with `steps`, `proposals`, and `ambiguities`.
Each leaf proposal records `stepId`, `argumentPath`, `proposed`, candidate bindings,
reasons, source paths, and `exhaustive`. Multiple variable candidates yield a
`multiple-candidates` ambiguity. A `constant-or-variable` ambiguity is raised only when:

- The proposed candidate is derived (`scale`, `rounded-scale`, `difference`, or `template`),
  so review can decide whether the rule is reusable or specific to this demonstration.
- The proposed candidate is an exact match of a low-information value: boolean, null,
  integer with absolute value at most 10, or string shorter than 4 characters.

High-information exact matches (for example IDs, emails, names of at least 4 characters,
or prices outside that small-integer range) do not raise a constant-or-variable question.
All proposals still retain the observed fixed value as an alternative candidate.
`multiple-candidates` and `candidate-limit` ambiguities are independent of this heuristic
and remain visible even for high-information values. No-match constants have no ambiguity.
These are proposals for review, never evidence that a recipe is ready to activate.

There are at most 64 variable hypotheses per argument, plus the fixed alternative;
truncation sets `exhaustive:false` and emits `candidate-limit`. Exhaustiveness refers to
the documented heuristics, not all possible mathematical or textual interpretations.
The first candidate is a deterministic suggestion, not a confidence claim. Argument
paths identify review locations, rather than executable source paths.
