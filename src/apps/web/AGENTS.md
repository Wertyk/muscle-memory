# Chat — Agent Guide

Muscle Memory is the Kiln & Co. ceramics shop workspace. `/` redirects through shared sign-in to `/inbox` (app.homePath). `/requests/:requestId` opens a support request. Chat lives at `/chat`; `/home` redirects to `/inbox` for old bookmarks. The persistent shell keeps domain navigation and the contextual agent sidebar beside the work surface.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

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
`list-request-processing`; do not infer the outcome from the demo script. Phase 1
does not install fixture recipes or add inbox chips/a demo button.

Opt-in live proof: `pnpm smoke:shop-actions`. It seeds an isolated temporary
PGlite with `pnpm -C src seed:shop`, checks CLI/frontend parity, then calls the
real local chat endpoint using the configured model and verifies persisted effects.
Only sanitized assertions/metadata are saved to `scripts/shop-actions-evidence.json`.

## Application state

- `navigation` describes the view and selected ids. Inbox is `{ view: "inbox", path: "/inbox" }`; an open request is `{ view: "request", requestId, path: "/requests/<requestId>" }`. The same id is in tab-scoped `selection:<TAB_ID>`; leaving the request clears selection. Filters (`status`, `type`) live in URL search params. Chat is `chat` at `/chat` and `/chat/<threadId>`; legacy `/home` links redirect to the inbox.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.
- `navigate({ view: "inbox" })` opens the inbox; `navigate({ view: "request", requestId })` opens a request. `view-screen` reads tab-scoped state and the same shop use-cases to return current request/customer/order/shipment details or filtered inbox records. Never infer the target from a previous chat message when current navigation is available.

## Request workspace

`/inbox` calls `list-requests` with status/type URL filters and `get-customer` for customer names. `/requests/:requestId` calls `get-request`, `get-customer`, `get-order`, `get-shipment-status` and `get-request-activity`. The reply composer calls `send-reply` (plain text or literal template plus optional JSON variables); Add tag calls `tag-request`; Resolve/status menu calls `set-request-status`; Escalate calls `escalate` with a reason. Order actions call `issue-refund`, `create-replacement-order`, `update-shipping-address` and `generate-return-label`. The server validates all policies. Framework action queries refresh after both frontend mutations and the current user's agent writes; no background polling is needed.

Handle with agent stages a bounded request-specific prompt in the contextual sidebar using `sendToAgentChat`; the operator sends it there and can steer the same conversation. Replies are demo records, not externally delivered email. Activity is read through the same read-only `get-request-activity` action the agent uses; replies, refunds, replacements and labels remain visible after reload. Existing request snapshots are labeled Recorded request state, not invented change history. The Teach bar records the current request through the shared demonstration actions below.

Seed content and relative time offsets are deterministic. `pnpm -C src seed:shop` anchors timestamps to the current seeding minute; set `SHOP_DEMO_ANCHOR` to an ISO timestamp for a fixed rehearsal/test anchor (also floored to the minute). The generator accepts an explicit anchor for offline fixtures.

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
Demonstrations are historical snapshots and survive shop reseeding.

Offline tests cover the capture-failure refund regression and the Teach controls.
Opt-in HTTP proof: `pnpm exec tsx scripts/teach-mode-smoke.ts` from apps/web. It
seeds an isolated temporary PGlite through the workspace seed command, starts dev
on port 5189, uses the normal authenticated frontend action transport, verifies
five first lookup snapshots + three mutations despite refetches, a 50%-platter
refund and trigger shape, tests overlap/cancellation/isolation, then
stops the server and removes its temporary database. No model is called.


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
