# Recipe engine

Pure, domain-agnostic recipe DSL, evaluation, and demonstration provenance inference.
Import the public API from `@muscle-memory/recipe-engine`.
The domain has no external dependencies; application validation depends only on Zod.
Persistence, execution, LLM extraction, and selecting/resolving a draft's trigger and doubts
are subsequent use-cases, outside this module's current scope.

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
