/** Opt-in real HTTP/DOM rehearsal. Run seed:shop + seed-runs first on a disposable DB.
 * --live-agent additionally runs, inspects and rejects a harmless gated tag in chat.
 * No provider output, credentials, or customer messages are written to disk. */
import assert from "node:assert/strict";

import { AgentKitClient } from "@agent-native/agentkit";
import type {
  AgentToolCall,
  AgentWidget,
} from "@agent-native/agentkit/protocol";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import { useDbSync } from "@agent-native/core/client/hooks";
import { AgentNativeI18nProvider } from "@agent-native/core/client/i18n";
import { AgentKitChat } from "@agent-native/toolkit/app/agentkit";
import { CoreAgentKitRoot } from "@agent-native/toolkit/app/chat/agentkit-chat";
import type { Run } from "@muscle-memory/recipe-engine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

import { RunPage } from "../app/components/runs/RunPage";
import { i18nCatalog } from "../app/i18n";
import { runFixtures } from "../server/fixtures/run-recipes";
import "../app/components/runs/RunChatCard";
import {
  APPROVAL_CARD_RENDERER,
  RUN_CARD_RENDERER,
  type RunSummary,
} from "../shared/recipe-runs";

const origin =
  process.argv
    .find((value) => value.startsWith("--origin="))
    ?.slice("--origin=".length) ?? "http://localhost:5193";
assert(
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin),
  "Smoke is restricted to a local disposable app",
);
const nativeFetch = globalThis.fetch;
const signIn = await nativeFetch(`${origin}/sign-in`, {
  redirect: "manual",
  headers: { Accept: "text/html" },
});
const cookies = signIn.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert(cookies, "Disposable dev app must issue its normal development session");
const dom = new Window({ url: `${origin}/runs` });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}
globalThis.fetch = (input, init) =>
  nativeFetch(new URL(String(input), origin), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      cookie: cookies,
      origin,
      referer: `${origin}/runs`,
    },
  });
const root = createRoot(
  document.body.appendChild(document.createElement("div")),
);
const query = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
let controller: AgentKitClient | undefined;
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    if (check()) return;
  }
  throw new Error(message);
}
async function action<T>(
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const result = await fetch(
    `/_agent-native/actions/${name}?${new URLSearchParams(input as Record<string, string>)}`,
  );
  assert(result.ok, `${name} HTTP ${result.status}`);
  return result.json() as Promise<T>;
}
function LocalChatSync() {
  useDbSync({ queryClient: query, pauseWhenHidden: true });
  return null;
}
async function mount(node: ReactNode, path = "/runs") {
  await act(async () => {
    root.render(
      <AgentNativeI18nProvider catalog={i18nCatalog}>
        <QueryClientProvider client={query}>
          <LocalChatSync />
          <MemoryRouter key={path} initialEntries={[path]}>
            {node}
          </MemoryRouter>
        </QueryClientProvider>
      </AgentNativeI18nProvider>,
    );
  });
}
async function card(tool: AgentToolCall, renderer: string) {
  const widget: AgentWidget = {
    id: "widget_smoke",
    kind: renderer,
    data: { toolCallId: tool.id },
  };
  controller = new AgentKitClient({
    transport: {
      async startRun() {
        throw new Error("The DOM rehearsal does not start model runs");
      },
      async *subscribeToRun() {},
      async cancelRun() {},
      async getThreadSnapshot() {
        return {
          id: "thread_smoke",
          createdAt: "2026-11-02T00:00:00Z",
          updatedAt: "2026-11-02T00:00:00Z",
          messages: [
            {
              id: "message_smoke",
              role: "assistant",
              status: "complete",
              parts: [{ type: "widget", widget }],
            },
          ],
          toolCalls: [tool],
          widgets: [{ messageId: "message_smoke", widget }],
        };
      },
    },
  });
  await controller.loadThread("thread_smoke");
  await mount(
    <CoreAgentKitRoot
      controller={controller}
      threadId="thread_smoke"
      load="manual"
    >
      <AgentKitChat composer={false} />
    </CoreAgentKitRoot>,
    "/runs/chat-smoke",
  );
  await until(
    () => Boolean(document.querySelector("[data-run-card]")),
    "Registered card must mount in AgentKit's live DOM transcript",
  );
}
try {
  const { callAction } = await import("@agent-native/core/client/hooks");
  const rows = await action<RunSummary[]>("list-recipe-runs");
  const pending = rows.find(
    (row) =>
      row.recipeId === "recipe_run_approval" &&
      row.status === "awaiting_approval",
  );
  assert(pending, "Seed a fresh pending approval before the smoke");
  for (const path of ["/runs", `/runs/${pending.id}`]) {
    const response = await fetch(path, { headers: { Accept: "text/html" } });
    assert(
      response.ok && new URL(response.url).pathname === path,
      `${path} must load through authenticated routing`,
    );
    assert(
      response.headers.get("content-type")?.includes("text/html"),
      "Route must return the app document",
    );
  }
  const filtered = await action<RunSummary[]>("list-recipe-runs", {
    status: "awaiting_approval",
    requestId: "req_0001",
    recipeId: pending.recipeId,
    mode: "execute",
  });
  assert.equal(filtered.length, 1);
  await mount(
    <Routes>
      <Route path="/runs/:runId" element={<RunPage />} />
    </Routes>,
    `/runs/${pending.id}`,
  );
  await until(
    () =>
      Boolean(document.querySelector(".run-approval button:not([disabled])")),
    "Real detail approval must become usable",
  );
  assert(
    document.body.textContent?.includes("$140.00"),
    "Detail must show resolved refund",
  );
  assert(
    document.querySelector('a[href="/requests/req_0001"]'),
    "Detail must link request",
  );
  const snapshot = await action<Run>("get-recipe-run", { runId: pending.id });
  const rejected = await callAction<Run>(
    "run-recipe",
    {
      recipe: snapshot.recipe,
      trigger: { requestId: "req_0003", orderId: "ord_1003" },
    },
    { uiOnly: true },
  );
  assert.equal(rejected.status, "awaiting_approval");
  await card(
    {
      id: "tool_reject",
      name: "run-recipe",
      input: {},
      output: rejected,
      status: "completed",
    },
    RUN_CARD_RENDERER,
  );
  await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Reject" && !button.disabled,
      ),
    "Chat rejection must become usable",
  );
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reject")!
      .click();
  });
  await until(
    () =>
      document.querySelector(".run-chat-card .run-status")?.textContent ===
      "Aborted",
    "Chat must update after a real rejected checkpoint",
  );
  assert.equal(
    (await action<Run>("get-recipe-run", { runId: rejected.id })).status,
    "aborted",
  );
  await controller?.dispose();

  const output = snapshot;
  const toolId = "tool_inspect";
  const renderer = RUN_CARD_RENDERER;
  if (process.argv.includes("--live-agent")) {
    // The same controller, native transport, transcript and widget slot used by
    // AgentSidebar: no fabricated widgets or manual tool_done reconstruction.
    controller = new AgentKitClient({
      transport: createAgentNativeAgentKitTransport(),
    });
    const thread = await controller.createThread();
    await controller.loadThread(thread.id);
    await mount(
      <CoreAgentKitRoot
        controller={controller}
        threadId={thread.id}
        load="manual"
      >
        <AgentKitChat composer={false} />
      </CoreAgentKitRoot>,
      "/runs/live-chat",
    );
    await act(async () => {
      const handle = await controller!.sendMessage({
        threadId: thread.id,
        text: `This is an isolated synthetic-data rehearsal. Perform exactly these three actions in order: (1) run-recipe with recipe ${JSON.stringify(runFixtures.rejected)} and trigger {"requestId":"req_0003"}; (2) get-recipe-run with the returned run ID; (3) resume-recipe-run with that same run ID and approval {"stepId":"tag","decision":"reject"}. This stops at a harmless tag approval; do not approve, refund, or call any other shop action. Discover the named tools with tool-search if needed. Show their cards and give a one-sentence summary.`,
      });
      await handle.completed;
    });
    const live = controller.getThread(thread.id);
    for (const name of ["run-recipe", "get-recipe-run", "resume-recipe-run"]) {
      assert(
        Object.values(live.tools).some(
          (tool) => tool.name === name && tool.status === "completed",
        ),
        `Live agent must complete ${name}`,
      );
    }
    assert(
      Object.values(live.widgets).some(
        (widget) => widget.kind === RUN_CARD_RENDERER,
      ),
    );
    assert(
      Object.values(live.widgets).some(
        (widget) => widget.kind === APPROVAL_CARD_RENDERER,
      ),
    );
    await until(
      () =>
        document.querySelectorAll("[data-run-card]").length === 3 &&
        [...document.querySelectorAll(".run-chat-card .run-status")].every(
          (chip) => chip.textContent === "Aborted",
        ),
      "All three live streamed cards must mount and reconcile in the actual native AgentKit transcript",
    );
    assert(
      !document.querySelector(".run-approval button"),
      "All historical live cards must remove resolved approval controls",
    );
    console.log(
      "Live native AgentKit transport streamed all three real tool cards into the mounted chat and both registered renderers reconciled to the persisted rejection.",
    );
    await controller.dispose();
  }
  await card(
    {
      id: toolId,
      name: "get-recipe-run",
      input: { runId: pending.id },
      output,
      status: "completed",
    },
    renderer,
  );
  await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Approve" && !button.disabled,
      ),
    "Chat approval must become usable",
  );
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Approve")!
      .click();
  });
  await until(
    () =>
      document.querySelector(".run-chat-card .run-status")?.textContent ===
      "Completed",
    "Chat must update after real approval execution",
  );
  const final = await action<Run>("get-recipe-run", { runId: pending.id });
  assert.equal(final.status, "completed");
  assert.equal(
    final.steps.filter(
      (step) => step.action === "issue-refund" && step.status === "completed",
    ).length,
    1,
  );
  await controller?.dispose();
  await card(
    {
      id: "tool_resume",
      name: "resume-recipe-run",
      input: { runId: final.id },
      output: final,
      status: "completed",
    },
    APPROVAL_CARD_RENDERER,
  );
  assert(
    document.querySelector(".run-zero-tokens")?.textContent === "0 LLM tokens",
  );
  assert(
    !document.querySelector(".run-approval button"),
    "Completed gate must stay unavailable",
  );
  console.log(
    "Authenticated routes, combined filters, $140 resolved evidence, mounted AgentKit cards, real chat approve/reject and persisted readback passed. Visual browser/sidebar verification is separate.",
  );
} finally {
  await act(async () => {
    root.unmount();
  });
  await controller?.dispose();
  query.clear();
  globalThis.fetch = nativeFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
}

// Framework client helpers retain session timers in Node, after DOM cleanup.
process.exit(0);
