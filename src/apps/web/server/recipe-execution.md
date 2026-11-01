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
