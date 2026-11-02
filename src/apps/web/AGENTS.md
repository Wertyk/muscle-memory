# Chat — Agent Guide

Muscle Memory is the Kiln & Co. ceramics shop workspace. `/` redirects through shared sign-in to `/inbox` (app.homePath). `/requests/:requestId` opens a support request. Chat lives at `/chat`; `/home` redirects to `/inbox` for old bookmarks. The persistent shell keeps domain navigation and the contextual agent sidebar beside the work surface.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- Always write English on agent-facing surfaces: replies, suggested-action labels and prompts, question options, titles and other generated UI text, regardless of the language in customer content.
- Calling `run-recipe`, `get-recipe-run` or `resume-recipe-run` automatically renders run/approval cards. Limit the entire text response to one or two sentences total, combining multiple runs into an overall status and next step. Do not add preambles, headings, lists, tables, raw IDs, step details, bindings or tool JSON. Use the recipe names when distinction is needed. Refer to the cards without spatial wording such as "above" or "below".
- Before calling `ask-question` (which ends the turn), state the actual question in one sentence and briefly list its option labels in your normal assistant message text, so the question remains readable after a reload even if its widget disappears. Never substitute a waiting placeholder for the question. Treat a later plain-text answer as settling that question and continue the blocked work without asking it again. This clarification requirement takes precedence over the run-card summary limit.
- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Shop actions

These actions are shared by frontend hooks, the chat agent, MCP and `pnpm action <name>`.
Queries use GET and are explicitly read-only. Results are structured domain snapshots;
policy failures throw typed action errors. Adapters are wired only in `server/composition.ts`.

| Action | Input | Result / use |
| --- | --- | --- |
| `list-requests` | Optional `status`, `type`, `customerId`, `tag` | Matching requests; filters combine |
| `create-request` | `customerId`, `subject`, `content` (`structured` + typed `fields`, or `free_text` + original `text`) | New request; waits for matching/execution/handoff before returning |
| `demo-intake` | Empty object | Five new scripted requests through real intake; requires seeded shop data; repeated calls create more real effects |
| `list-request-processing` | Optional `requestIds` (at most 1000) | Inbox state, run ID, match reason, extraction + execution tokens; read-only |
| `get-request` | `requestId` | Original content, related IDs, status, tags and escalation |
| `get-request-activity` | `requestId` | Persisted request/order activity, newest first: reply excerpts, refunds, replacements, return labels and recorded request state |
| `get-order` | `orderId` | Purchased items, payment, address and return label |
| `get-customer` | `customerId` | Name, email and address book entry |
| `get-shipment-status` | `orderId` | Order status and shipment (nullable), carrier, tracking and estimate |
| `issue-refund` | `orderId`, `reason`, optional `amount: { amountMinor, currency }` | Refund; omitted amount refunds remaining payment |
| `send-reply` | `requestId`, `template`, `variables` | Stored demo reply with rendered body; no external delivery |
| `tag-request` | `requestId`, `tag` | Request with trimmed, deduplicated tag |
| `set-request-status` | `requestId`, `status` | Updated request; use `escalate` for the first escalation |
| `escalate` | `requestId`, `reason` | Escalated request with reason and timestamp |
| `create-replacement-order` | `orderId`, optional `items: [{ productId, quantity }]` | Unshipped replacement; omit items for all original lines |
| `update-shipping-address` | `orderId`, complete `address` | Updated order; permitted only before dispatch |
| `generate-return-label` | `orderId` | Synthetic return label; repeats return the existing label |

The chat plugin eagerly loads the five queries plus `send-reply`, `tag-request`
and `set-request-status`; other operations remain discoverable with `tool-search`. For shipment requests,
read the request/order/shipment, store an accurate reply, then resolve when handled.
Money is in minor units. `issue-refund` uses the shop-domain auto-refund policy
for agent approval; omitted amounts conservatively require approval too. Frontend
calls use the framework's UI capability and are not blocked by this agent gate.
Every request-handling shop mutation and query uses `traced()`; capture is active only for the teaching operator’s tab and request.

Intake uses active catalog version pointers, not arbitrary saved versions. Structured
fields match without extraction; free text gets one cheap extraction attempt and must
supply complete shop fields. No match, incomplete extraction or overlapping triggers
queue the existing durable AgentHandoff and escalate the request. `with_agent` means
queued context, not a running chat turn. Use `get-recipe-run` to inspect the saved run
and `resume-recipe-run` to approve/reject its exact awaiting step; intake never approves.
`list-request-processing` derives `auto_handled`, `awaiting_approval`, `with_agent`,
and `done` from durable run/shop records, including later approval/resolution changes.
Null state means intake is still in flight or was interrupted before run creation.
After creating/injecting requests, verify their IDs in both `list-requests` and
`list-request-processing`; do not infer the outcome from the demo script. The
inbox Demo control calls `demo-intake`; it does not install fixture recipes.
Repeated batches create real requests/effects; a failed batch can be partly saved.
Processing chips are additive to shop status; the `processing` URL filter combines
with `status`/`type`. Seeded requests have no processing chip. `view-screen` includes
the filtered records and processing projection. The request banner reads
`get-recipe-run` for the exact awaiting step and resolved amount; Approve/Reject
call `resume-recipe-run`. Open handoff in agent submits a request/run-ID prompt to
the shared sidebar; read saved context before continuing, preserving completed effects.

New request/order IDs continue the seed's numeric series (`req_0061`, `ord_1062`),
including replacement orders. Allocation and insertion use the same serialized shop
transaction; existing IDs are unchanged. Other entity IDs may remain random.
Successful free-text extraction persists its type through `ClassifyRequest`, even
when no recipe matches. Original message/source/order link and operator changes are
preserved. Type filters work after reload; failed/incomplete extraction stays
unclassified. Redelivery reuses the saved match to retry classification without
another model call. Scripted intake uses natural customer text without disclosure
words; the UI control remains explicitly labelled as a demo tool.

Opt-in live proof: `pnpm smoke:shop-actions`. It seeds an isolated temporary
PGlite with `pnpm -C src seed:shop`, checks CLI/frontend parity, then calls the
real local chat endpoint using the configured model and verifies persisted effects.
Only sanitized assertions/metadata are saved to `scripts/shop-actions-evidence.json`.

## Recipe backtesting

| Action | Input | Result / use |
| --- | --- | --- |
| `backtest-recipe` | `recipe` (version ID or snapshot), `requestType` | Summary, per-request differences and dry-run evidence |
| `compare-recipe-versions` | `baseline`, `candidate` (version IDs or snapshots), `requestType` | Paired reports on one case set, status changes, intended-mutation differences and combined tokens |

`backtest-recipe({recipe, requestType})` accepts a saved version ID or a complete
immutable snapshot. `compare-recipe-versions({baseline, candidate, requestType})`
accepts the same references for both versions. These read-only GET actions are
discoverable through `tool-search`; they never save snapshots, runs or shop data.
Select the recipe trigger's request type explicitly; only resolved requests of
that type are loaded, then the engine evaluates all trigger conditions per case.
Preserve the summary, per-request status/reasons/diff, and dry-run evidence.
`not_handled` includes blocked mutation-output dependencies and handoffs.

Real free-text request extraction and recipe extract steps spend tokens, even
though shop mutations are suppressed. Summary `tokens`/`totalTokens` include both;
comparison's combined summary counts shared request extraction once. A repeated
action call extracts again. Dry-run reads use **current** shop data (acceptable
for the seed), not historical snapshots. Do not treat results as proof of policy
success. Recipe Studio exposes both actions on explicit clicks; its tab-scoped
last-shown summary is in `view-screen.backtest` (null when none). Version history
shows session evidence before activation without blocking it. Details: `server/recipe-execution.md`.

## Application state

`/dashboard` reads `get-handling-stats({})` through the same action available to
the agent/MCP/CLI. Navigate with `view=dashboard`; `view-screen` returns the same
stats projection. It shows the latest 100 recorded handling outcomes, token/time
series, zero-token recipe share, same-type mean costs with separate sample counts,
and live pending approval/active recipe counts. Null means unmeasured, never zero.
Seed history, unlinked/manual resolutions, queued handoffs and dry runs are
excluded. Agent outcomes require an explicit recorded resolution; exact action
run/thread links join framework observability totals for the signed-in actor and
workspace. Multi-request turns have unknown cost. Attribution and matching
duration start with TASK-21, without invented backfill. Read the dashboard method
disclosure or `server/recipe-execution.md` before reporting savings; preserve
coverage and sample counts. A falling curve is an observation, not a guarantee.

- `navigation` describes the view and selected ids. Inbox is `{ view: "inbox", path: "/inbox" }`; an open request is `{ view: "request", requestId, path: "/requests/<requestId>" }`. The same id is in tab-scoped `selection:<TAB_ID>`; leaving the request clears selection. Filters (`status`, `type`) live in URL search params. Chat is `chat` at `/chat` and `/chat/<threadId>`; legacy `/home` links redirect to the inbox.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.
- `navigate({ view: "inbox" })` opens the inbox; `navigate({ view: "request", requestId })` opens a request. `view-screen` reads tab-scoped state and the same shop use-cases to return current request/customer/order/shipment details or filtered inbox records. Never infer the target from a previous chat message when current navigation is available.

## Request workspace

`/inbox` calls `list-requests` with status/type URL filters and `get-customer` for customer names. `/requests/:requestId` calls `get-request`, `get-customer`, `get-order`, `get-shipment-status` and `get-request-activity`. The reply composer calls `send-reply` (plain text or literal template plus optional JSON variables); Add tag calls `tag-request`; Resolve/status menu calls `set-request-status`; Escalate calls `escalate` with a reason. Order actions call `issue-refund`, `create-replacement-order`, `update-shipping-address` and `generate-return-label`. The server validates all policies. Framework action queries refresh after frontend mutations and the current user's agent writes. Only `/inbox` and `/requests/:requestId` opt into shared `useDbSync` for external arrivals and recipe changes; hidden tabs pause and idle polling backs off. Other routes keep background sync off.

Handle with agent stages a bounded request-specific prompt in the contextual sidebar using `sendToAgentChat`; the operator sends it there and can steer the same conversation. Replies are demo records, not externally delivered email. Activity is read through the same read-only `get-request-activity` action the agent uses; replies, refunds, replacements and labels remain visible after reload. Existing request snapshots are labeled Recorded request state, not invented change history. The Teach bar records the current request through the shared demonstration actions below.

Seed content and relative time offsets are deterministic. `pnpm -C src seed:shop` anchors timestamps to the current seeding minute; set `SHOP_DEMO_ANCHOR` to an ISO timestamp for a fixed rehearsal/test anchor (also floored to the minute). The generator accepts an explicit anchor for offline fixtures.

For another rehearsal, `pnpm -C src seed:shop` atomically removes prior shop-linked
intake checkpoints, handoffs, recipe runs and demonstrations/steps before restoring
the shop seed. Recipe catalog entries and immutable versions survive, so active recipes remain usable.
`pnpm -C src reset:shop` performs the same cleanup and leaves the shop empty.
Add `--all` to either command for a pristine rehearsal: all recipe runs/handoffs,
catalog entries and versions are removed too. `seed:shop --all` restores only the
shop seed; it never installs fixture recipes. Framework data and migration records
survive every mode. Run these maintenance commands between executions; they do not
cancel an in-flight worker.

TASK-9 demonstrations/steps are registered alongside intake data. Register additional
shop-dependent tables
in `server/infra/shop-reset-dependents.ts`, before their parents in DELETE order.
That registry controls cleanup and locking for both commands; do not add separate
seed-only teardown code. Missing optional tables are skipped on shop-only schemas.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.

## Teach mode (TASK-9)

`start-demonstration({requestId, fields?})` starts on the request open in the current tab.
`stop-demonstration({demonstrationId})` retains a completed trace; `cancel-demonstration`
with the same ID discards the recording and frees the slot (shop effects remain).
Only one active recording is allowed per authenticated user/workspace/browser tab.
`get-demonstration({requestId})` reads this tab’s latest trace for the request;
`get-demonstration({demonstrationId})` reads an owned trace from UI, agent, MCP or CLI,
including the identical intake trigger, ordered inputs/outputs, navigation and timing.
`view-screen` exposes the current demonstration ID, status, count and incomplete reason.
After stopping, re-read it and verify status and saved step count; never infer success
from the button alone. Incomplete traces retain a reason and must be reviewed.

Teach never calls a model. Structured requests use their original fields through
`buildRequestTrigger`; free text reuses saved validated intake fields or requires
operator-confirmed details through the same strict shop schema. A trace stores full
successful shop results, with invocation-order reservations for concurrent reads.
Within a demonstration each distinct read (same action + canonical JSON input) is
captured once, retaining the first invocation’s output even if identical reads
finish out of order. Refetches still return current shop state. Mutations are
always captured. The bar numbers actions and summarizes lookups separately; Inspect
and get-demonstration retain the complete ordered trace of first reads + mutations.
Rejected actions are omitted; failed capture preserves the successful shop action
and marks the trace incomplete. Do not repeat a refund/reply because capture failed.
A durable pending reservation also prevents stop from claiming an interrupted trace
is complete. Stopping while calls are in flight is explicitly incomplete.

Navigation and related request/order/customer IDs must match; other tabs/users,
inbox-wide query results and deterministic recipe/intake execution are excluded.
The bar observes framework action queries and opts into the shared sync transport
only while recording, because read-only shop calls also write captured steps.
Those notifications target the demonstrations resource; shop query observers declare
the shop resource to prevent refetch/capture loops. No feature polling loop exists.
Demonstrations retain historical snapshots until an explicit rehearsal reset/reseed,
which removes their headers and steps together with other shop operational data.

Offline tests cover the capture-failure refund regression and the Teach controls.
Opt-in HTTP proof: `pnpm exec tsx scripts/teach-mode-smoke.ts` from apps/web. It
seeds an isolated temporary PGlite through the workspace seed command, starts dev
on port 5189, uses the normal authenticated frontend action transport, verifies
five first lookup snapshots + three mutations despite refetches, a 50%-platter
refund and trigger shape, tests overlap/cancellation/isolation, then
stops the server and removes its temporary database. No model is called.

## Draft recipes (TASK-11)

| Action | Input | Result / use |
| --- | --- | --- |
| `draft-recipe-from-demonstration` | `demonstrationId` from a completed Teach recording | `{demonstrationId, recipe, draft, ambiguities}`; saves a new immutable version and draft catalog entry without a model or activation |
| `get-recipe-draft` | `versionId: draft.id` | Owned saved draft and ambiguity evidence, or null; read-only GET for UI, agent, MCP and CLI |

Draft only after Stop and saved-trace readback. Recording, incomplete, cancelled,
empty or foreign demonstrations cannot be drafted. Each call creates a new draft;
keep `draft.id` and retrieve it for review. Inspect every ambiguity before later
crystallization/activation. Unused lookups are removed; trigger matches the recorded
request type, with IDs rebound from intake fields. Native reply templates infer
variables; plain replies infer first names and formatted money from recorded sources
and prior outputs. Keyed lookups select the trigger product independently of line order,
and currency follows the same money object. Inspect `positional-array` fallbacks and
`request-specific-text` warnings (including literal partial product descriptions).
Drafts do not appear in active intake
matching. `run-recipe({recipe:draft, trigger:<other intake-shaped payload>, dryRun:true})`
shows rebound arguments without shop writes; generated mutation outputs can still
block later steps. No Recipe Studio or activation UI is introduced here.

The Teach HTTP smoke now also drafts, reads the saved version and dry-runs another
damaged request, asserting zero tokens and unchanged target activity. See
`server/recipe-execution.md` and the engine README for persistence/pruning details.


### Menu-launched dialogs (TASK-8 regression fixed in TASK-9)

Order actions and the request-status menu use `DropdownMenu modal={false}` because
they launch modal dialogs. Only Dialog owns the body pointer lock during the
handoff; overlapping modal menu/dialog lifetimes can leave pointer-events:none
on body after the last dialog closes. Keep the dialogs modal and leave pointer
style cleanup to Radix. Do not globally reset body styles or disable dialog
modality. Rejected submissions retain an interactive dialog until retry/cancel.
The pointer-event workspace regressions cover all four order dialogs and Escalate
with submit/cancel/rejected-submit→cancel, body lock restoration, and a subsequent
Stop & save click, plus the filmed refund→reply→tag→Stop continuation.

## Recipe Studio

For **Crystallize with agent**, follow `.agents/skills/crystallize/SKILL.md`:
read the draft/source demonstration, resolve data choices, ask at most two
questions about remaining listed ambiguities, generalize request-specific text,
then update/save using the Studio actions below. Include `proposal` description,
human trigger and ambiguity resolutions in `save-recipe-version` for the
`muscle-memory.recipe-proposal` chat card. Dry-run another structured request and
report real arguments/tokens. Never activate implicitly or claim untested success.

`/recipes` lists the catalog; `/recipes/:recipeId` inspects editable bindings,
trigger, approvals, ambiguities and immutable history. Read
`.agents/skills/recipe-studio/SKILL.md` for the editing sequence. All UI edits use
these shared actions. Editing never calls a model. Run backtest and Compare versions
are explicit, token-spending simulations over saved versions; their cohort comes
from the selected trigger. Save draft edits before testing them.

| Action | Input | Result / use |
| --- | --- | --- |
| `list-recipes` | `{}` | Name, draft/active, latest version, run count, last result |
| `get-recipe` | `recipeId` | Catalog metadata and immutable history with content diffs |
| `get-recipe-draft` | `recipeId` (Studio) or `versionId` (TASK-11 original) | Studio content/revision/base/ambiguities/issues; original reads retain owner/workspace scope |
| `update-recipe-draft` | `recipeId`, `expectedRevision`, `content: {name,trigger,steps}` | Editable draft and inline validation issues; preserves original ambiguity evidence |
| `save-recipe-version` | `recipeId`, `expectedRevision` | New immutable version; never activates implicitly |
| `activate-recipe` | `recipeId`, `versionId` | Select valid saved version for future intake |
| `deactivate-recipe` | `recipeId` | Clear active pointer; retain versions and pinned runs |

`navigate` supports `view=recipes` and `view=recipe, recipeId`. Navigation and
selection carry the recipe ID; `view-screen` includes current history/draft.
A stale draft revision is a conflict, requiring readback before retrying. Draft
validation failures stay editable but cannot become executable versions. Saving
also increments the revision; repeated uncertain saves must read back first.
Original ambiguity evidence and editable Studio state share TASK-11’s canonical owner/workspace-scoped recipe_drafts row; original version reads preserve their output.

Studio approvals use Never / Always / When controls plus Advanced JSON. Prefer
`input.amount.amountMinor` for the refund being issued, e.g.
`{">": [{"var":"input.amount.amountMinor"},10000]}` for amounts above $100.
`input.*` exists only inside approvals, after this step's input resolves. The UI
accepts money thresholds in dollars; action JSON uses integer minor units.
Message previews show text with symbolic source chips, without evaluating or
calling a model. Minor ambiguity entries are still preserved as review evidence.

## Human corrections (TASK-17)

Successful operator frontend `send-reply`, `issue-refund` and `tag-request` calls
on the current request are captured by `traced()` for 30 minutes after its latest
completed automatic intake run. Agent/recipe calls, approval runs, dry runs and
unrelated requests/orders are excluded. Read `corrections` on `get-request`,
`get-recipe-run`, `get-recipe` or `view-screen`; each pins the request/run/version,
superseded step and original/new action evidence. Normal shop actions remain the
only way to make the correction. An additional refund is additive shop data.

For **Propose recipe update**, follow `.agents/skills/recipe-studio/SKILL.md`:
update the existing draft, then `save-recipe-version` with `correctionId` and
`proposal` notes. Generalise reply text into the template and refund totals into
price/quantity formulas. Never activate implicitly. The proposal card links to the
saved Studio history diff; optional backtest uses the existing Studio controls.
`activate-recipe` records accepted → version N atomically with activation.
`record-correction-decision({correctionId,decision:"rejected",reason})` records a
terminal rejection and prevents activation of that proposal. Both outcomes are
visible on the request, run timeline and Studio history. Rehearsal resets clear
corrections before their run/request/version parents while preserving the catalog
in the default mode.
