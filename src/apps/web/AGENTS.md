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
Every shop mutation uses `traced()`; the injected capture stays inactive until
TASK-9 adds recording/session policy.

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

Handle with agent stages a bounded request-specific prompt in the contextual sidebar using `sendToAgentChat`; the operator sends it there and can steer the same conversation. Replies are demo records, not externally delivered email. Activity is read through the same read-only `get-request-activity` action the agent uses; replies, refunds, replacements and labels remain visible after reload. Existing request snapshots are labeled Recorded request state, not invented change history. The Teach slot is noninteractive and reserved for TASK-9.

Seed content and relative time offsets are deterministic. `pnpm -C src seed:shop` anchors timestamps to the current seeding minute; set `SHOP_DEMO_ANCHOR` to an ISO timestamp for a fixed rehearsal/test anchor (also floored to the minute). The generator accepts an explicit anchor for offline fixtures.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.
