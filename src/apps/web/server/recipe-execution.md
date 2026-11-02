# Recipe framework adapters (TASK-14 Phase 2)

`composition.ts` wires `RunRecipe` to `DrizzleRunRepository`,
`RecipeActionInvoker` over `RegistryActionInvoker`, `CompleteTextExtractor`, and
`DrizzleAgentHandoff`. `run-recipe`, `resume-recipe-run`, and `get-recipe-run`
expose the same executor to UI hooks, the agent, MCP and CLI. No UI is included.

## Persistence and locks

The named additive migration runs after the shop migration through the existing
DB plugin/release migration entry point. `recipe_versions` stores immutable
snapshots with unique identity and recipe/version number. The repository rejects
conflicting snapshots; a DB trigger also refuses updates. No activation/registry
or recipe editing API is introduced.

`recipe_runs.checkpoint` stores the complete run, including attempts, cursor,
metrics, approvals and handoff delivery status, in a single atomic row update.
Intent commits before invoking a step. Results and cursor commit together.
The engine never holds all checkpoints in a rollbackable execution transaction.

PostgreSQL uses a **dedicated postgres-js connection** with a transaction-scoped
advisory lock keyed by the run ID. This is a real database lock across workers
and also works with transaction pooling. The lock callback is invoked once;
there is no automatic callback retry. Framework DB connections perform shop
transactions and individual checkpoints independently of the lock transaction.
A failure closes/rolls back only the lock transaction. Lock acquisition times out
after 30 seconds without invoking work. Lock-connection loss stops a stale
callback at its next repository boundary. Work already sent outside the engine
still requires reconciliation; this is not an atomic transaction with a shop
mutation or provider call. PostgreSQL requires capacity for the lock connection
in addition to the framework's data connection.

PGlite supports one database-owning process, enforced by core 0.222.2's exclusive
directory process lock and stale-PID recovery. A global per-database/per-run queue
serializes concurrent executor/repository instances in that process. It does not
pretend that PGlite supports multiple independent workers. Hosted multi-worker
execution must use PostgreSQL. Protocol unit tests exercise SQL lock ownership,
cleanup and no callback retries; PGlite integration covers checkpoint durability
and concurrent resumes. Live multi-connection PostgreSQL verification is separate.

## Invocation and extraction

Metadata `readOnly` takes precedence; otherwise HTTP GET classifies a read.
Known actions without read metadata are mutations. Unknown/inherited names fail
closed. The invoked action receives a fresh `actionName`, `runId`, and the stable
`runId:stepId` key as `toolCallId`; an enclosing agent approval key is removed.
Unsuccessful result envelopes, contract exceptions, and unsafe/non-finite JSON
become execution failures. Internal exception/provider details are sanitized.
Registry definitions are deployment-static; discovery and invocation use the
same installed action modules. Direct `.run()` uses recipe gates, not framework
`needsApproval`.

Extract steps declare their own strict JSON output schema in the completion
prompt. The narrow `completeText` boundary reads `EXTRACT_MODEL` via the supported
deployment configuration reader, never the chat model. `completeText` resolves
scoped provider credentials and the app-owned `OPENAI_API_KEY` deployment fallback
with the configured OpenAI-compatible endpoint. Primitive/required/extra-field validation occurs in the engine **after**
it records returned usage, so parsed but schema-invalid results count tokens.
Missing/invalid usage fails closed. Malformed JSON/provider failures cannot
return usage through the current port; their consumed tokens cannot be recovered
by the engine. Tests use fake extractors/completions, with no live LLM calls.

## Durable handoff fallback

Research on installed 0.222.2 used `pnpm action docs-search` for
`client-agent-chat`/server handoff and `pnpm action source-search` for
`sendToAgentChat`/`enqueueAgent`, plus the public server exports. The supported
in-app helper is client `postMessage`; the enqueue matches are internal agent-team
sub-agent machinery. No documented server-side in-app chat enqueue API was found.
No raw chat endpoint, internal queue, hidden model loop or automation is used.

The authorized fallback inserts `recipe_handoffs` with the engine's stable
idempotency key, full context, request ID and `with_agent`/`with_human` disposition.
In the **same transaction**, the existing shop `Escalate` use-case updates the
request with the handoff reason, using a transaction-bound shop repository wired
in composition. Retries do not repeat escalation. Failure rolls back both writes;
the engine retains pending delivery for a later resume. Triggers with `requestId`
or a request-shaped `id` identify the request; non-request recipes retain a queued
context without a request association. Human targets remain explicit.

Later UI can use `get-recipe-run` and send a bounded message with run/request IDs
to `sendToAgentChat`, letting the agent read the saved context via actions.
`handed_off` acknowledges durable queueing, not an executing chat turn.

Dry-run writes only its immutable recipe snapshot and run checkpoints. Integration
tests compare every shop table and handoff records before/after simulation.

## Historical backtesting (TASK-18 Phase 2 backend)

`createRecipeBacktests` is additive to executor composition. It wires the engine's
`BacktestRecipe` to `ShopHistoricalCaseSource`, `ShopMutationNormalizer`, and the
same registry invoker and configured `TextExtractor` used for execution/intake.
The two thin, read-only GET actions are:

| Action | Input |
| --- | --- |
| `backtest-recipe` | `{recipe: versionIdOrSnapshot, requestType}` |
| `compare-recipe-versions` | `{baseline: versionIdOrSnapshot, candidate: versionIdOrSnapshot, requestType}` |

For example, after saving a version, call
`backtest-recipe({recipe:"ver_damaged_v1",requestType:"damaged_item"})` through the
normal action transport. CLI accepts a positional JSON object for nested snapshots.
Unsaved snapshots are validated and never persisted. Missing IDs and non
`request.created` recipes fail with typed errors before extraction. The explicit
`requestType` selects the recipe's historical cohort; arbitrary JSONLogic trigger
conditions cannot in general be inverted into a SQL type selector. The engine
still evaluates the complete trigger condition for every selected request.
These actions remain discoverable through tool search. Recipe Studio is TASK-13;
there is no UI or activation change in this phase.

### Historical inputs and outcomes

The source selects only `status = resolved` and the requested generated category.
A repeatable-read, read-only transaction loads requests and batches related
orders, refunds and replies. It closes before any extraction. Structured fields
are passed through the exact intake `MatchRequest` path; free text uses
`ShopRequestExtractor` with `ValidateRequestFields`, then the same public
`buildRequestTrigger(fields,{requestId,customerId,subject})` inside `MatchRequest`.
There is no extra source/envelope field, classification write, synthetic field
default, or seed-specific extraction oracle. The original customer text is used.
If extraction cannot produce complete validated fields, the operation rejects
instead of silently dropping that case or presenting an incomplete cohort.
Provider details are sanitized at the action boundary; failed operations may
still have spent tokens without producing a report.

Outcomes reconstruct **action inputs**, excluding generated record metadata:

- Refund → `issue-refund({orderId,amount,reason})`.
- Replacement order → `create-replacement-order({orderId:replacementForOrderId,
  items:[{productId,quantity}]})`.
- Reply → `send-reply({requestId,template,variables})`.
- Each recorded tag → `tag-request({requestId,tag})`.
- Return cohort's stored return label → `generate-return-label({orderId})`;
  address-change cohort's stored shipping address →
  `update-shipping-address({orderId,address})`.

Refunds/replacements are linked by order, not request: only records between the
request's creation and last update (inclusive) are attributed to it. Return
labels use the same time window. Replies have a direct request link. Events sort
by timestamp, then refund/replacement/return-label-or-address/reply, then record
ID for ties. Tags follow as recorded final state. Resolution selects the cohort;
no `set-request-status` invocation is inferred solely from that selection.
Tags have no per-tag history, addresses have no pre-change snapshot/timestamp,
and overlapping request windows on one order can make attribution ambiguous.
This reconstruction is suitable for the authored seed; it is not an audit trace.

### Comparison equivalences

`ShopMutationNormalizer` is pure and applied symmetrically. Original action input
lists and dry-run logs remain intact. For known shop mutation actions it drops
only top-level `id`, `createdAt`, `updatedAt` record metadata. It always retains
semantic `requestId`, `orderId`, `productId`, amounts/currencies, quantities,
meaningful reason/reply text, unknown fields and nested fields. Unknown actions
are compared exactly. It never removes IDs embedded in prose.

Valid `send-reply` templates are reduced to the literal rendered body using the
shop's one-pass `{{variable}}` substitution semantics. Equivalent template/variable
layouts and unused variables compare equally; punctuation, spacing and line
breaks stay significant. Invalid placeholders, missing variables and conflicting
extra `body` fields retain their exact input. Refund/escalation reasons and tags
are trimmed as their use-cases trim them. Contiguous exact `tag-request` operations
are sorted/deduplicated as an idempotent set; tags are never moved past another
action. All other mutation/array order remains significant. Omitted refund amounts
or replacement selections are **not** expanded: their defaults depend on data
unavailable to a pure normalizer. No semantic similarity or reason-text synonym
matching is performed.

### Read and token semantics

Dry-run shop reads use **current data, not historical snapshots**. This is the
reviewer-authorized limitation for seeded history; the report exposes
`readData:"current"` and limitations. Both versions share a detached historical
case set, but their read actions still execute separately against current data.
Concurrent edits can change what the two simulations see. The simulation also
cannot prove that live mutations would pass policy checks.

Free-text preparation calls the real configured extractor, as do any recipe
`extract` steps. `summary.requestExtractionTokens` reports cohort preparation;
`summary.recipeExtractionTokens` sums actual case-local run usage, including
schema-invalid extract output. `summary.tokens` adds input/output tokens from
both sources and `summary.totalTokens` adds those two totals. Structured cases
with action/branch-only recipes consume zero tokens. Known provider usage is
counted; usage unavailable after provider failures/process death is not invented.

Version comparison loads/extracts the cohort once, using the engine's detached
case set as a per-operation cache. Each version's report attributes that shared
request usage to its own scenario. The **combined** `summary.tokens` and
`summary.totalTokens` count `sharedRequestExtractionTokens` once plus both versions'
recipe extract-step usage. Use this combined summary for actual comparison cost;
do not add the two scenario totals. Repeat action calls prepare/extract again.
No persistent extraction cache, run checkpoint, recipe snapshot or handoff is
written by these backtest actions.

PGlite tests seed the real 30 handled requests. The hand-written
`fixtures/backtest-recipes.ts` damage fixture uses read/formula bindings and the
seed's whole-dollar half-prices, avoiding invented mutation outputs. Ten damage
cases yield seven identical and three different (replacement/no refund, full
high-value refund, and distinct reply). Readable field reasons accompany exact
JSON Pointer diffs. Tests assert every shop row and table count remains unchanged,
including engine/teaching table counts; existing mutation-output-dependent intake
fixtures remain conservatively `not_handled`.

## Request intake (TASK-15 Phase 1)

`create-request` accepts `customerId`, `subject`, and `content` with either
`{source:"structured", fields: StructuredRequestFields}` or
`{source:"free_text", text}`. The shop `CreateRequest` use-case validates the
customer, order ownership and damaged-product/quantity association, inserts an open
request, then the intake adapter emits `request.created` with `{requestId}` and
**awaits `emitAsync`**. `RequestCreatedEvents` installs a single subscriber before
emission on every cold process, checks its registration on reuse/hot reload, and
uses request-local dependencies so concurrent callers do not share context. All
app producers must emit through `RequestIntake.events.emit(id)`; raw framework
emissions without the intake scope are rejected. There is no queued automation,
cron dependency, background model loop or timer to wait for on serverless.

The recipe-engine `MatchRequest` evaluates active immutable version triggers with
zero model calls for structured content.
The public `buildRequestTrigger(fields, context)` from `@muscle-memory/recipe-engine`
is shared by matching and intake context construction. TASK-9/TASK-11 should use
it with `{requestId: request.id, customerId: request.customerId, subject: request.subject}`
to produce the identical flattened trigger; trusted context wins over fields.
`ShopRequestExtractor` makes one call to
the existing `TextExtractor` for free text, using `EXTRACT_MODEL`. `type` uses
exactly `damaged_item`, `where_is_my_order`, `return`, `address_change`, or
`wholesale_inquiry`. The result must contain the same required fields as the
structured variant (including product/quantity/description for damage and complete
new address for address changes). Primitive `addressName`, `addressLine1`, etc.
are reassembled into `address` at this boundary. Unknown/incomplete fields or an
order owned by another customer fail closed; no missing field is defaulted.

After the validated extraction/match is durably checkpointed, intake calls the
shop `ClassifyRequest` use-case to persist the extracted type on free text before
executing a recipe or handoff. This updates the generated request category and its
existing type filter, while preserving original message/source/order link and
operator state. Valid classification is retained even without an active/matching
recipe. Failed or incomplete extraction remains unclassified. Same-type writes are
idempotent; a failed classification write can be retried from the saved checkpoint
on explicit redelivery without another extraction call.

New request/order IDs are allocated from the highest existing numeric suffix under
the shop transaction's `SHARE ROW EXCLUSIVE` lock and inserted before releasing it.
Requests continue at `req_0061`, orders/replacements at `ord_1062` after the seed.
This uses no process-local counter or new migration. Rollback releases an uncommitted
ID; seed/reset deliberately restarts from the current rows. Minimum width is four
digits, growing past 9999 without truncation; the existing 31-character validation,
primary keys and CHECK constraints remain. Legacy alphanumeric IDs are untouched.

`recipes` is a deliberately small catalog with `id`, `name`, `status` (`draft` or
`active`) and `activeVersionId`. `DrizzleRecipeCatalog.saveVersion` reuses the
executor's immutable snapshot checks. `save` writes metadata; a composite FK ensures
an active version exists and belongs to that recipe. Drafts have a null pointer.
An ad hoc run can still persist a version without adding it to the catalog.
The catalog does not yet publish skills, draft recipes, expose editing/activation
UI, or auto-install the test fixtures. Later tasks build those workflows on top.

An intake lock, separate from the run lock, serializes repeated request events.
`request_processing` reserves one run ID before matching, then checkpoints the
complete matching result before execution. Repeated delivery reuses that result
and resumes the same run; it never re-extracts, repeats completed mutations or
approves a gate. A crash during matching routes to handoff on redelivery instead
of repeating a possibly consumed extraction call. A matched version remains pinned
even if the catalog changes before redelivery. Failed/no/ambiguous matches run the
internal immutable `ver_intake_handoff` recipe through the existing executor and
`AgentHandoff`, preserving the full original request through its request ID.

Intake locks/checkpoints commit independently of executor/shop effects, following
TASK-14's uncertainty policy. On PostgreSQL a request intake lock plus an executing
run can require two lock connections in addition to data connections. This uses
the same serverless-compatible transaction-scoped advisory locks; no live hosted
PostgreSQL deployment was exercised by offline tests. Process death between request
insert and event delivery is not an atomic outbox: the saved request remains,
and explicit redelivery through the intake adapter is needed. Infrastructure
failure propagates from `emitAsync`; do not blindly recreate the request/batch.
Unknown usage from provider errors/process death cannot be recovered; known
schema-invalid extraction usage is retained in matching checkpoints.

`list-request-processing` is a read-only join of intake, run and shop checkpoints:

| State | Meaning |
| --- | --- |
| `auto_handled` | Recipe completed without a manual approval; request not manually resolved |
| `awaiting_approval` | Run is paused at its own approval gate |
| `with_agent` | Run handed off or failed; inspect handoff delivery in `get-recipe-run` |
| `done` | Request resolved, run explicitly rejected, or approved run completed |
| null | Matching/execution is in flight or interrupted before a final run state |

Seeded requests without intake have no processing row. The query accepts optional
`requestIds` (at most 1000); it includes run IDs, match reasons and measured intake
plus executor token counts. Reading never reprocesses requests. Status derives
from durable source records, so `resume-recipe-run` and `set-request-status` need
no extra synchronization write. Approval state takes precedence over resolution.

`demo-intake` injects the five entries in `infra/demo-intake.ts` through the same
`RequestIntake.create` pipeline. It requires TASK-6's seed and does not install
recipes or fabricate statuses. It returns the saved requests, whose outcomes can
be verified with `list-request-processing`. Repeated calls create more requests
and real effects; outcomes depend on current recipes and remaining refund balance.
The batch is sequential and each request is independently durable; a failure can
leave a partial batch, which the action's error explicitly reports. Offline tests
activate hand-written damage/shipment fixtures: two damage refunds (50%), one
free-text shipment reply, a damage refund above USD 100 paused for approval, and
an unmatched wholesale inquiry give the required 3/1/1 split. The fixtures' damage
recipe supports the first order line, handing off other product selections.

## Intake UI (TASK-15 Phase 2)

The inbox joins `list-requests` with `list-request-processing`, displaying shop
status and processing outcome separately. URL `processing` combines with the shop
`status`/`type` filters; `view-screen` mirrors that projection for the agent. Null
state displays Processing; seed requests without a row get no invented outcome.
The Demo control calls `demo-intake`, disables overlapping submissions, and reads
the resulting inbox through normal action-query invalidation. Failed batches also
refresh the inbox because some effects may have been committed. No fixture recipe
is installed by the UI.

Only the private inbox and request routes opt into the framework's shared
`useDbSync` SSE/poll transport for remote arrivals and recipe progress. Local
mutations and agent writes use the normal action-observer invalidation path.

`RequestProcessingBanner` is an additive request component. It reads
`get-recipe-run` to show the exact awaiting step/action and resolved money input.
Approve/Reject call `resume-recipe-run` with the saved run/step IDs; neither calls
the shop mutation directly. Failed responses trigger checkpoint readback before
another decision; stale run read errors disable the controls. A with-agent banner
opens the existing sidebar via `sendToAgentChat`, supplying bounded request/run
IDs so the agent reads the saved handoff context without copying full records.
Queued handoffs are explicitly labelled as queued, rather than running turns.

## Rehearsal reset and reseed

`pnpm -C src seed:shop` and `reset:shop` clear shop-linked operational data before
deleting requests, in one transaction with the shop cleanup and optional seed
inserts. The ordered `shopResetDependents` registry in
`infra/shop-reset-dependents.ts` is the extension point for new child tables,
including the registered TASK-9 demonstration steps and demonstrations. Register
children before parents; missing tables are skipped for older/shop-only schemas. The CLI applies
the full app migration plugin first. No CASCADE/TRUNCATE or schema edits are used.

Default cleanup removes all demonstration steps and headers, request-processing
checkpoints, handoffs linked to requests or selected runs, and runs identified by those associations or by a
request-shaped `trigger.requestId`/`trigger.id` (including stale/ad hoc triggers).
Generic runs and their unrelated handoffs survive. The catalog and all immutable
versions survive, so a subsequent intake can reuse the same active recipes.

Use `pnpm -C src seed:shop --all` for a pristine seeded rehearsal, or
`pnpm -C src reset:shop --all` for an empty one. This explicitly also removes all
recipe runs/handoffs, recipes and versions, including generic runs. Framework rows
and migration bookkeeping are retained. Cleanup and new inserts roll back together
if any step fails. Use maintenance commands between executions; resetting durable
rows does not cancel an already executing worker.

## Demonstration capture (TASK-9)

Teach shares `buildRequestTrigger` with MatchRequest; no additional envelope, request
snapshot or source field is inserted. Free-text context uses saved intake fields
(with trusted requestId/customerId/subject removed before strict field validation)
or operator-confirmed fields through ValidateRequestFields. No model runs in Teach.
The generic Demonstrations use-cases and TraceStore port live in recipe-engine;
ShopDemonstrations translates shop snapshots in infrastructure and composition wires
all adapters. `demonstrations` headers and ordered `demo_steps` persist atomically in
short, non-retrying transactions under a database table lock (PGlite/PostgreSQL).
No lock/transaction surrounds a shop operation. The deliberately coarse lock suits
the demo workload; invocation slots reserve ordering before asynchronous completion.

traced() returns the successful shop result even when append or incomplete marking
fails. Append failure normally persists a sanitized incomplete reason immediately;
a total store outage can also prevent that update, but the prior durable pending
reservation ensures a later Stop is incomplete. There is no shop callback retry.
Late results remain pinned to their original demonstration; cancelled traces discard
them, and results after Stop cannot turn an incomplete trace back into completed.
Raw persistence/provider errors are never returned in capture-failure reasons.


Reviewer round 1: demonstration read identity is the action name plus structural
JSON equality (object key order ignored; arrays/types preserved). The engine skips
already-saved reads at reservation and deduplicates concurrent completions, keeping
the earliest invocation’s input/output/navigation/timing. TraceStore saves reconcile
step rows atomically so a slower first read replaces an earlier-finishing duplicate
without leaving an extra row. No schema migration is required. Mutations are never
deduplicated; refetches still execute normally and return current shop state.
The shared shop lookup classification is verified against action readOnly metadata.
The Teach bar numbers mutations and shows compact lookup chips and separate counts;
Inspect and the retrieval action retain the full ordered trace. Historical traces
are not rewritten.
