# Recipe engine

Pure, domain-agnostic recipe DSL, evaluation, demonstration provenance inference, and execution.
Import the public API from `@muscle-memory/recipe-engine`.
The domain has no external dependencies; application validation depends only on Zod.
Execution uses injected ports; this package contains no framework, DB, or LLM adapters.
Drafting proposes a request-type trigger; resolving its doubts and activating it remain subsequent workflows.

## Drafting a stored demonstration (TASK-11)

`DraftRecipeFromDemonstration` takes `traces` (`TraceStore`), `recipes`
(`RecipeRepository`), action-effect metadata (`Pick<ActionInvoker, "describe">`),
and a `nextId("recipe" | "version")` function. It has no extractor, invocation or
LLM capability. `execute({demonstrationId, owner})` returns
`{demonstrationId, recipe, draft, ambiguities}`; `get(owner, versionId)` retrieves it.

Only an owned, completed, nonempty trace with no pending/failed captures and a
recorded `trigger.type` can be drafted. Sequence order is validated and preserved.
Inference uses the recorded trigger verbatim, which Teach builds with
`buildRequestTrigger` using the same fields/context as intake. Free text must
already have confirmed or saved extracted fields; drafting does not read or
extract the original message. The proposed trigger is
`{event:"request.created", match:{"===":[{var:"trigger.type"}, recordedType]}}`.
Customer/order/request IDs, subject and description never narrow that match.

The use-case runs `inferBindings` on the full ordered input/output projection,
then prunes reads by walking backwards from mutations. A retained step keeps all
reads referenced by its bindings, including transitive lookup dependencies. An
unused lookup chain disappears together. Ambiguities for deleted steps and
candidates requiring deleted reads are omitted; inference's fixed alternatives
and applicable ambiguity kinds remain available.

When a proposed source points to a mutation result value equal to one of that
mutation's recorded input values, drafting proposes the input's inferred binding
instead. For example, a reply variable copied from `refund.output.amount.amountMinor`
can reuse the refund input's price formula. This remains a hypothesis: original
result/fixed candidates are retained and the substitution adds an ambiguity for
review. Every rewritten argument must reproduce the demonstration exactly.
Generated result IDs remain result dependencies; dry-run still blocks on them.
Native reply templates keep their literal placeholders and bind their variables.
Literal text inferred as a template keeps path placeholders when possible; a
derived placeholder uses the existing `cat` expression with path/formula operands.
No mutation output is simulated and executor semantics are unchanged.

`RecipeRepository.createDraft` must insert a fresh immutable version, catalog
metadata (`status:"draft", activeVersionId:null`) and review evidence atomically,
rejecting collisions rather than overwriting or deactivating an existing recipe.
Draft retrieval is owner/workspace scoped. Each execution creates a new draft;
it never activates one or resolves the ambiguities. Single-example proposals
(including money rounding and literal request-specific text) require review before use.

The reference fixture is the unmodified browser recording
`demo_de81093c7e515f12`: refund 14000 for a 28000-unit-price platter, a plain-text
"Hi Maya ... $140.00" reply, and tag `damaged`. Its draft uses a product-keyed
half-price formula and matching currency, plus `cat`/`firstWord`/`money` for the
reply. Inference first identifies the formatted amount in the prior refund
output; the existing copied-input rebasing replaces that result dependency with
the same inferred input formula for dry-run. The output/fixed alternatives remain
in the review evidence. "Ember serving platter" stays literal and is flagged.
The app regression dry-runs another seeded request after moving its selected
product behind a decoy line in the isolated test database. It verifies the selected
price, currency, first name, formatted refund, zero tokens and unchanged shop effects.

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

## Request matching (TASK-15 Phase 1)

`MatchRequest` takes an `ActiveRecipeSource` and a `RequestExtractor`. Call
`execute({event, context, content})` with either `{source: "structured", fields}`
or `{source: "free_text", text}` as content. Structured fields bypass extraction
entirely. Free text gets exactly one extraction attempt, before evaluating all
active versions' trigger conditions. The app's extractor adapter validates its
own categories, required fields and record ownership; the engine has no shop imports.

The result is a detached frozen `{recipe, trigger, tokens, reason}` snapshot.
Fields are flattened into the trigger alongside trusted application `context`;
context wins on key collisions. Only one matching version produces `matched`.
The public `buildRequestTrigger(fields, context)` helper performs this same merge;
demonstration capture/drafting should reuse it with the intake context
`{requestId: request.id, customerId: request.customerId, subject: request.subject}`.
`no_match`, `extraction_failed`, `ambiguous`, and `matching_failed` return a null
recipe so the caller can hand off. Trigger event names must match exactly.
Known usage survives invalid extracted fields (`fields: null`); thrown provider
failures cannot report usage through this port. Matching never retries extraction,
executes actions, approves gates or silently selects one of overlapping triggers.

The web composition passes matches to `RunRecipe`, and unmatched requests to a
small internal handoff recipe using the existing `AgentHandoff` port. The catalog
stores mutable `Recipe` metadata (`id`, `name`, `draft|active`, `activeVersionId`)
separately from immutable `RecipeVersion` snapshots.

## Backtesting (TASK-18 Phase 1)

`BacktestRecipe` takes `cases` (`HistoricalCaseSource`), `actions` (`ActionInvoker`),
`extractor` (`TextExtractor`), `clock`, `ids`, and an optional `normalizer`
(`MutationNormalizer`). It evaluates trigger matches and reuses `RunRecipe` with
`mode: "dry-run"`; it never invokes mutation actions or delivers handoff. Executor
checkpoints are private in-memory state per case, so no production `RunRepository`
is accepted or written. Fresh short run IDs come from `ids`, including for reads'
idempotency keys. Returned runs retain dry-run logs, approval requirements and tokens.

```ts
const backtester = new BacktestRecipe({ cases, actions, extractor, clock, ids });
const report = await backtester.execute({ recipe: version, selection: {
  event: "request.created", category: "damaged", handled: true,
} });
// report.summary: { total, identical, different, notHandled }
// report.cases: original mutation lists, status, reasons, diff, dry-run evidence
const comparison = await backtester.compare({ baseline: v1, candidate: v2,
  selection: { event: "request.created", category: "damaged", handled: true },
});
// comparison.baseline / .candidate: complete reports
// comparison.cases: paired statuses, changed flag, intended-mutation diff
```

The source's `listCases(selection)` is read-only; selection is opaque JSON understood
by the adapter. Each `HistoricalCase` is `{ id, trigger, outcome }`, where `outcome`
is an ordered list of `{ action, input }` mutations. The source selects the appropriate
event population (events are not inferred from payloads). Two compared versions must
use the same trigger event. One validated, detached case set is loaded once and reused
for both versions, preserving case order. Bad versions, malformed cases/normaliser
outputs, duplicate case IDs, and source/normaliser errors reject the operation rather
than presenting misleading results.

`identical` and `different` require a complete simulation with at least one intended
mutation. Unmatched triggers, trigger errors, failed steps, blocked dependencies,
explicit handoff, and paths planning no mutations are `not_handled`, with reasons.
Even when a partial mutation list matches history, blocked/failed/handoff paths never
count as identical. Partial intended mutations and their diffs remain available.
Approval gates are reported without pausing, following `RunRecipe` dry-run semantics.

Comparison is generic JSON: object key order is irrelevant; mutation and array order,
primitive types, exact strings and missing versus null matter. `diffJson` returns
detached field differences with JSON Pointer paths, e.g. `/0/input/amount/amountMinor`.
`added` means only intended has the value; `removed` means only history has it;
`changed` includes both values. For version comparisons, historical/intended mean
baseline/candidate intended mutations. The `changed` flag compares statuses and
normalised intended mutations; detailed failure reasons remain in the paired reports.

An optional pure, deterministic `normalizer.normalize(mutations)` canonicalises both
lists symmetrically before comparison. It can reconcile app-specific reply formats or
equivalent action inputs without adding shop knowledge to the engine. Original lists
and run evidence remain intact; diff values reflect normalised data. Default comparison
does not infer semantic equivalence or ignore fields.

Reads and extraction still execute through their ports. Adapters must use stable
historical read snapshots for both versions, classify action effects correctly, and
supply a fake extractor in tests. Real extraction can consume tokens and vary between
simulations; backtesting does not cache or invent outputs or prove mutation policy
success. Case-local checkpoints are discarded after execution; no resume is exposed.

TASK-18 **Phase 2** supplies the shop historical-case/read adapters (including mapping
stored refunds, replies and replacement orders into comparable mutations), framework
actions/composition and Recipe Studio UI before activation. These are intentionally
deferred. Phase 1 covers AC #1/#2/#4 and the comparison engine portion of AC #3.

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
`*`, `/`, `%`, `min`, `max`, `round`, `floor`, `ceil`, `and`, `or`, `!`, `!!`, `if`, `cat`, `in`,
`find`, `firstWord`, `money`.
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

`find` takes `[arrayExpression, "keyField", valueExpression, "relative.returnPath"]`.
It reads only own properties, compares scalar keys strictly, and returns the
selected JSON value or null for no match, duplicate keys, a missing property or
a null array. Empty return path returns the selected element. Key field and return
path must be static safe strings, never expressions; prototype keys, methods and
arbitrary code are rejected. Array scans are limited to 1,024 elements; non-arrays,
oversized arrays and non-scalar keys throw. Array and key-value expression dependencies
participate in the usual schema/scope validation and dry-run blocking.

```ts
{ find: [{var:"steps.order.output.items"}, "productId",
         {var:"trigger.productId"}, "unitPrice.amountMinor"] }
```

`firstWord: [textExpression]` trims whitespace and returns the first whitespace-separated
word (empty text returns ""). Input must be a string of at most 4,096 characters.
`money: [minorUnitsExpression, currencyExpression]` formats integer minor units as
`$140.00`; optional third argument `"decimal"` yields `140.00` instead. The default
format is `"symbol"`. Supported currencies are explicitly USD (`$`), EUR (`€`),
GBP (`£`), CAD (`CA$`) and AUD (`A$`), each with two decimal places. No locale or
provider is consulted. Negative amounts use a leading minus. Safe integer minor
units are required; fractional/unsafe amounts, unknown currencies, dynamic or
unknown format options and coercions are rejected. Rounding must be explicit.

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
   Direct trigger matches take priority over read outputs. When an array element has
   a unique sibling key equal to a trigger scalar, inference also creates a `find`
   source and ranks it above positional sources. Matching field names and informative
   values outrank weak/coincidental keys. Nested keyed arrays are supported. The
   positional alternatives remain visible. A stronger keyed numeric formula can
   outrank an incidental exact positional price match.
2. Otherwise, recurse into nonempty object/array arguments to infer their leaves.
   Money objects (`amountMinor` + `currency`) always infer their leaves together:
   currency follows the proposed amount's source money object/selected element,
   retaining a fixed alternative without unrelated equal-currency candidates.
3. For numbers, exact products using bounded scale factors (`INFERENCE_SCALES`, including
   0.5), then exact differences of two source numbers. These unrounded formulas rank ahead
   of integer-rounded products within each source-priority tier. For an integer observation, when a
   product differs from the observed value, matching `round`, `floor`, and `ceil` wrappers
   are proposed with reason `rounded-scale`, in that order. Thus 2499 × 0.5 → 1250 proposes
   `round` (with `ceil` as an alternative), and → 1249 proposes `floor`; 2400 × 0.5 → 1200
   stays an exact scale without redundant rounding wrappers. Every proposed binding must
   reproduce the observation exactly. No arbitrary ratio fitting or offsets are invented.
4. For text, longest non-overlapping whole source tokens, including numeric tokens, become
   placeholders. Derived tokens include first names from person-name fields (explicit
   full/customer/shipping names, address names or customer/person/contact action results)
   and symbol/decimal money from `amountMinor`/`currency` objects, including earlier
   step outputs. Product-name first words are not person-name tokens. A recorded money
   result outranks a coincidentally equal array-item price for text interpolation.
   Derived selections/formatting use `cat` expressions with `firstWord`/`money`; plain
   path-only interpolations keep template mode. Repeated equal tokens use the same
   source within a candidate. Competing source assignments produce alternatives.
   Existing literal `{{` / `}}` syntax
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
and remain visible even for high-information values. `positional-array` flags a proposed
binding that still uses an index, including a positional relative path inside `find`.
`request-specific-text` includes the message "Text may contain request-specific details."
and bounded literal fragments: partial/case-changed source labels or unknown proper labels
after reference words stay literal for crystallization review. This is a conservative
heuristic, not complete detection of personal details. No-match constants can receive
this text warning; ordinary no-match constants have no ambiguity.
These are proposals for review, never evidence that a recipe is ready to activate.

There are at most 64 variable hypotheses per argument, plus the fixed alternative;
truncation sets `exhaustive:false` and emits `candidate-limit`. Exhaustiveness refers to
the documented heuristics, not all possible mathematical or textual interpretations.
The first candidate is a deterministic suggestion, not a confidence claim. Argument
paths identify review locations, rather than executable source paths.

Every candidate, including derived text, is re-evaluated against the demonstration.

## Recipe Studio (TASK-13)

`RecipeStudio` takes a `RecipeStudioStore` and a short version-ID generator. Its
`list`/`get` methods expose catalog summaries and history with content-only diffs.
`getDraft` returns `{recipeId,revision,baseVersionId,content,ambiguities,issues}`;
content is `{name,trigger,steps}`. `update({recipeId,expectedRevision,content})`
preserves invalid but bounded finite JSON for correction and returns field issues.
`save({recipeId,expectedRevision})` validates the DSL, allocates the next number
and NEW identity, and atomically advances the draft revision. Even identical
content creates a new version; stale edit/save retries fail with `CONFLICT`.

`activate({recipeId,versionId})` validates a stored snapshot and changes only its
catalog pointer; `deactivate(recipeId)` clears that pointer. Saving never activates.
Existing versions/runs remain unchanged. The store serializes mutation callbacks,
commits their DB writes atomically and never retries callbacks automatically.
No executor, action invoker, extractor or model is used by this editing workflow.
The web adapter uses TASK-11's canonical owner/workspace-scoped recipe_drafts
store. Editable content/revision/base identity live in an optional studio property
of its evidence JSON. Original version reads and provenance remain unchanged.
