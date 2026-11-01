---
name: running-recipes
description: Start, inspect, approve, reject, and safely resume deterministic recipe runs, or reconcile a queued recipe handoff.
scope: runtime
metadata:
  internal: true
---

# Run a recipe

Use `run-recipe` with `recipe` (a complete immutable recipe version), `trigger`,
and optional `dryRun` (default false). For request workflows, include the short
`requestId` in the trigger so failure/explicit handoff can escalate that request.
Trigger matching is the caller's responsibility. Reusing a version identity with
different content or a recipe/version number with another identity is rejected.
For CLI calls, pass nested inputs as one positional JSON object; `--recipe`
and `--approval` flags carry strings rather than parsing nested JSON.

Keep the returned run `id`. `get-recipe-run({runId})` returns the stored recipe,
trigger, mode, attempts, resolved inputs/results, durations, tokens, and handoff.
The start action is not idempotent: a new call starts a new run. After a lost
response, inspect existing durable runs before starting again.

For `awaiting_approval`, show the intended step/input for review. Call
`resume-recipe-run({runId, approval: {stepId, decision: "approve"|"reject"}})`
using the exact `awaitingApprovalStepId`. Reject permanently aborts the run.
Recipe approvals are separate from the framework's per-action agent approvals.

Plain `resume-recipe-run({runId})` retries pending handoff delivery. `retry: true`
explicitly retries only a safe failed read/extract/evaluation. Completed mutations
are retained. Failed/interrupted mutations may already have happened: reconcile
their saved input and the actual shop records before taking further action.

Dry-run performs reads and extraction (which can consume tokens), persists a run,
and reports mutation attempts as `planned`. Mutation-dependent steps are
`blocked`; their outputs are unavailable. It never mutates shop data or delivers
a handoff. A completed simulation containing blocked steps does not prove that
those steps will succeed during execution.

`handed_off` means durable context is queued, with disposition `with_agent` or
`with_human`, and the associated request is escalated with the reason. It does
not mean an agent chat turn has started. Read the saved handoff context and real
shop state before continuing. Future inbox UI opens this work using the client
`sendToAgentChat` helper; no UI dispatch is implemented by these server actions.
