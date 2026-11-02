// @vitest-environment happy-dom
import { AgentKitClient } from "@agent-native/agentkit";
import type {
  AgentToolCall,
  AgentWidget,
} from "@agent-native/agentkit/protocol";
import { AgentKitChat } from "@agent-native/toolkit/app/agentkit";
import { CoreAgentKitRoot } from "@agent-native/toolkit/app/chat/agentkit-chat";
import { recipeCardOrder } from "@/lib/chat-card-order";
import type { Run } from "@muscle-memory/recipe-engine";
import {
  APPROVAL_CARD_RENDERER,
  RUN_CARD_RENDERER,
  summarizeRun,
} from "@shared/recipe-runs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";
import { durationText } from "@/lib/recipe-runs";
import { valueSummary } from "@/lib/recipe-presentation";

import { runFixtures } from "../../../server/fixtures/run-recipes";
import { RunPage } from "./RunPage";
import { RunReason, RunTimeline } from "./RunParts";
import { RunsPage } from "./RunsPage";
import "./RunChatCard";

vi.mock("@agent-native/core/client/i18n", () => ({
  useT:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          enUS,
        );
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(values[name] ?? ""),
      );
    },
}));

function gateRun(): Run {
  return {
    id: "run_ui",
    recipe: runFixtures.approval,
    trigger: { requestId: "req_0001" },
    mode: "execute",
    status: "awaiting_approval",
    createdAt: Date.UTC(2026, 10, 2),
    updatedAt: Date.UTC(2026, 10, 2) + 30_000,
    pendingStepIds: ["refund", "tag"],
    approvedStepIds: [],
    awaitingApprovalStepId: "refund",
    tokens: { input: 0, output: 0 },
    failure: null,
    handoff: null,
    steps: [
      {
        stepId: "order",
        kind: "action",
        action: "get-order",
        effect: "read",
        attempt: 1,
        status: "completed",
        approvalRequired: false,
        input: { orderId: "ord_1001" },
        output: { id: "ord_1001", status: "delivered", items: [{ productId: "prd_0016", name: "Ember Large Serving Platter", quantity: 4, unitPrice: { amountMinor: 28000, currency: "USD" } }] },
        startedAt: 1,
        finishedAt: 31,
        durationMs: 30,
        tokens: { input: 0, output: 0 },
        error: null,
        blockedBy: [],
      },
      {
        stepId: "refund",
        kind: "action",
        action: "issue-refund",
        effect: "mutation",
        attempt: 1,
        status: "awaiting_approval",
        approvalRequired: true,
        input: {
          orderId: "ord_1001",
          requestId: "req_0001",
          productId: "prd_0016",
          amount: { amountMinor: 14000, currency: "USD" },
          reason: "Damaged platter",
        },
        output: null,
        startedAt: 31,
        finishedAt: null,
        durationMs: 0,
        tokens: { input: 0, output: 0 },
        error: null,
        blockedBy: [],
      },
    ],
  };
}
let saved: Run;
let listedSubject: string;
let root: Root;
let element: HTMLDivElement;
let queries: QueryClient;
let chat: AgentKitClient | undefined;
let calls: { name: string; input: Record<string, unknown> }[];
let writeWait: Promise<void> | undefined;
let readFails: boolean;
let writeFailsAfterCommit: boolean;

async function settle(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assertion();
  });
}
async function mount(node: ReactNode, path = "/runs/run_ui") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queries}>
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}
async function detail() {
  await mount(
    <Routes>
      <Route path="/runs/:runId" element={<RunPage />} />
    </Routes>,
  );
}
function button(text: string): HTMLButtonElement {
  const result = [...element.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  saved = gateRun();
  listedSubject = "Broken Ember platter";
  calls = [];
  writeWait = undefined;
  readFails = false;
  writeFailsAfterCommit = false;
  queries = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url, "http://localhost");
      const name = parsed.pathname.split("/").pop()!;
      if (name === "get-actions-batch")
        return Response.json({ error: "batch unavailable" }, { status: 404 });
      const input =
        init.method === "POST"
          ? JSON.parse(String(init.body))
          : Object.fromEntries(parsed.searchParams);
      calls.push({ name, input });
      if (name === "get-handling-stats") return Response.json({ samples: [] });
      if (name === "list-request-processing") return Response.json([]);
      if (name === "get-request") return Response.json({ id: "req_0001", subject: "Broken Ember platter" });
      if (name === "get-recipe-run")
        return readFails
          ? Response.json({ error: "Read unavailable" }, { status: 409 })
          : Response.json(structuredClone(saved));
      if (name === "list-recipe-runs")
        return Response.json(
          input.status === "failed"
            ? []
            : [summarizeRun(saved, listedSubject)],
        );
      if (name === "resume-recipe-run") {
        await writeWait;
        const decision = input.approval.decision;
        saved = {
          ...saved,
          status: decision === "approve" ? "completed" : "aborted",
          awaitingApprovalStepId: null,
          pendingStepIds: [],
          approvedStepIds: decision === "approve" ? ["refund"] : [],
          steps: saved.steps.map((step) =>
            step.stepId === "refund"
              ? {
                  ...step,
                  status: decision === "approve" ? "completed" : "rejected",
                  output:
                    decision === "approve"
                      ? { amount: { amountMinor: 14000, currency: "USD" } }
                      : null,
                  finishedAt: 40,
                  durationMs: 9,
                }
              : step,
          ),
        };
        return writeFailsAfterCommit
          ? Response.json(
              { error: "Connection lost after save" },
              { status: 503 },
            )
          : Response.json(saved);
      }
      return Response.json({ error: "Unexpected action" }, { status: 404 });
    }),
  );
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  if (chat) await chat.dispose();
  chat = undefined;
  queries.clear();
  element.remove();
  vi.unstubAllGlobals();
});

describe("run detail and list", () => {
  it("offers Replay only for completed live runs and opens the saved checkpoint", async () => {
    await detail();
    await settle(() => expect(button("Approve").disabled).toBe(false));
    expect([...element.querySelectorAll("button")].some((item) => item.textContent === "Replay")).toBe(false);
    saved = { ...saved, status: "completed", awaitingApprovalStepId: null, pendingStepIds: [], steps: saved.steps.map((step) => ({ ...step, status: "completed" })) };
    await act(async () => { await queries.invalidateQueries({ queryKey: ["action"] }); });
    await settle(() => expect(button("Replay")).toBeDefined());
    await click(button("Replay"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Saved run checkpoint · Read-only replay");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Looked up order ord_1001");
    const exit = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Exit replay")!;
    await click(exit);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.every((call) => ["get-recipe-run", "get-request", "list-request-processing"].includes(call.name))).toBe(true);
  });

  it("shows an empty filtered list and recovers through clearing filters", async () => {
    await mount(<RunsPage />, "/runs?status=failed");
    await settle(() =>
      expect(element.textContent).toContain("No runs match these filters."),
    );
    await click(button("Clear filters"));
    await settle(() =>
      expect(element.textContent).toContain("Broken Ember platter"),
    );
  });
  it.each([
    ["completed", "execute", "recipe"],
    ["handed_off", "execute", "neutral"],
    ["aborted", "execute", "neutral"],
    ["completed", "dry-run", "neutral"],
  ] as const)("colours %s %s costs as %s work", async (status, mode, handler) => {
    saved = { ...saved, status, mode };
    await mount(<RunsPage />, "/runs");
    await settle(() => expect(element.querySelector(".kiln-run-row .kiln-cost")?.getAttribute("data-handler")).toBe(handler));
  });

  it("shows an unavailable run read and recovers without enabling an unverified gate", async () => {
    readFails = true;
    await detail();
    await settle(() =>
      expect(element.textContent).toContain("Read unavailable"),
    );
    expect(element.querySelector(".run-approval button")).toBeNull();
    readFails = false;
    await click(button("Try again"));
    await settle(() => expect(button("Approve").disabled).toBe(false));
  });
  it("shows both a failure reason and the queued handoff disposition", async () => {
    const run: Run = {
      ...saved,
      status: "handed_off",
      failure: { stepId: "order", message: "Lookup failed", retryable: true },
      handoff: {
        status: "delivered",
        error: null,
        context: {
          idempotencyKey: "run_ui:handoff:order:1",
          runId: saved.id,
          recipeVersionId: saved.recipe.id,
          trigger: saved.trigger,
          stepId: "order",
          to: "human",
          reason: "failure",
          note: "Check the order with the customer.",
          steps: saved.steps,
          outputs: {},
        },
      },
    };
    await mount(<RunReason run={run} />);
    expect(element.textContent).toContain("Lookup failed");
    expect(element.textContent).toContain("Queued for human review");
    expect(element.textContent).toContain("Check the order with the customer.");
  });
  it("shows resolved evidence, human labels, metrics, pending steps and both links", async () => {
    await detail();
    await settle(() =>
      expect(element.textContent).toContain("Your approval is needed"),
    );
    expect(element.textContent).toContain("Look up order");
    expect(element.textContent).toContain("Issue refund");
    expect(element.textContent).toContain("$140.00");
    expect(element.textContent).toContain("Order ID: ord_1001");
    expect(element.textContent).toContain("Request ID: req_0001");
    expect(element.textContent).toContain("Product ID: prd_0016");
    expect(element.textContent).toContain("Ember Large Serving Platter × 4 ($280.00 each)");
    await settle(() => expect(element.querySelector("h1 a")?.textContent).toBe("Broken Ember platter"));
    expect(element.querySelector("h1 .kiln-data")).toBeNull();
    expect(element.querySelector("h1")?.previousElementSibling?.textContent).toBe("req_0001");
    expect(element.querySelector(".kiln-detail-meta")?.classList.contains("kiln-data")).toBe(true);
    expect(element.querySelector('a[href^="/recipes/recipe_run_approval"]')?.textContent).toBe(`${saved.recipe.name} · Version 1`);
    expect(element.querySelector("h1")?.textContent).not.toContain(saved.recipe.name);
    expect(element.textContent).toContain("30 ms");
    expect(element.textContent).toContain("0 LLM tokens");
    expect(element.textContent).toContain("Not executed yet");
    expect(
      element.querySelector('a[href="/requests/req_0001"]'),
    ).not.toBeNull();
    expect(
      element.querySelector('a[href^="/recipes/recipe_run_approval"]'),
    ).not.toBeNull();
    expect(element.querySelectorAll(".run-json")[1]?.textContent).toContain(
      '"delivered"',
    );
  });
  it.each(["approve", "reject"] as const)(
    "%s uses only the resume action and persists through reload",
    async (decision) => {
      await detail();
      await settle(() => expect(button("Approve").disabled).toBe(false));
      let release!: () => void;
      writeWait = new Promise((resolve) => {
        release = resolve;
      });
      const target = button(decision === "approve" ? "Approve" : "Reject");
      await click(target);
      await click(target);
      expect(button("Saving…").disabled).toBe(true);
      expect(
        calls.filter((call) => call.name === "resume-recipe-run"),
      ).toHaveLength(1);
      await act(async () => {
        release();
      });
      await settle(() =>
        expect(
          element.querySelector(".run-page > header .run-status")?.textContent,
        ).toBe(decision === "approve" ? "Completed" : "Aborted"),
      );
      expect(
        calls.find((call) => call.name === "resume-recipe-run")?.input,
      ).toEqual({ runId: "run_ui", approval: { stepId: "refund", decision } });
      expect(calls.some((call) => call.name === "issue-refund")).toBe(false);
      await act(async () => {
        queries.clear();
      });
      await detail();
      await settle(() =>
        expect(element.textContent).toContain(
          decision === "approve" ? "Approval granted" : "Approval rejected",
        ),
      );
      expect(element.querySelector(".run-approval button")).toBeNull();
    },
  );
  it("reads a durable decision after a failed response and disables stale controls when readback fails", async () => {
    await detail();
    await settle(() => expect(button("Approve").disabled).toBe(false));
    writeFailsAfterCommit = true;
    readFails = true;
    await click(button("Approve"));
    await settle(() =>
      expect(element.textContent).toContain("Connection lost after save"),
    );
    await settle(() =>
      expect(
        [...element.querySelectorAll<HTMLButtonElement>(".run-approval button")]
          .filter((item) =>
            ["Approve", "Reject"].includes(item.textContent ?? ""),
          )
          .every((item) => item.disabled),
      ).toBe(true),
    );
    readFails = false;
    await act(async () => {
      await queries.invalidateQueries({ queryKey: ["action"] });
    });
    await settle(() =>
      expect(element.textContent).toContain("already been decided"),
    );
    expect(
      calls.filter((call) => call.name === "resume-recipe-run"),
    ).toHaveLength(1);
  });
  it("sends combined URL filters, renders list columns and clears an empty filtered view", async () => {
    listedSubject = "Broken Ember platter ".repeat(30);
    await mount(
      <RunsPage />,
      "/runs?status=awaiting_approval&requestId=req_0001&recipeId=recipe_run_approval&mode=execute",
    );
    await settle(() =>
      expect(element.textContent).toContain("Broken Ember platter"),
    );
    expect(
      calls.find((call) => call.name === "list-recipe-runs")?.input,
    ).toEqual({
      status: "awaiting_approval",
      requestId: "req_0001",
      recipeId: "recipe_run_approval",
      mode: "execute",
    });
    expect(element.querySelector('a[href="/runs/run_ui"] strong')?.textContent).toHaveLength(220);
    expect(element.querySelectorAll('.kiln-run-list li a')).toHaveLength(1);
    expect(element.querySelector('.kiln-run-row a, .kiln-run-row button')).toBeNull();
    expect(element.querySelector('a[href="/runs/run_ui"] strong')?.textContent).toMatch(/…$/);
    expect(element.textContent).toContain("Active duration");
    expect(element.textContent).toContain("Execution tokens");
    await click(button("Clear filters"));
    await settle(() =>
      expect(
        calls.filter((call) => call.name === "list-recipe-runs").slice(-1)[0]
          ?.input,
      ).toEqual({}),
    );
  });
  it("renders failures, planned mutations, blocked dependencies and retry attempts truthfully", async () => {
    const first = saved.steps[0]!;
    saved = {
      ...saved,
      steps: [
        { ...first, status: "failed", error: "Lookup failed" },
        {
          ...first,
          status: "completed",
          attempt: 2,
          tokens: { input: 7, output: 2 },
        },
        { ...saved.steps[1]!, status: "planned", approvalRequired: false },
        {
          ...first,
          stepId: "dependent",
          status: "blocked",
          blockedBy: ["refund"],
        },
      ],
    };
    await mount(<RunTimeline run={saved} />);
    expect(element.textContent).toContain("Attempt 2");
    expect(element.textContent).toContain("9 LLM tokens");
    expect(element.textContent).toContain("Lookup failed");
    expect(element.textContent).toContain("Blocked by refund");
    expect(element.textContent).toContain("Planned");
  });
  it("keeps summaries bounded and formats zero, seconds and minutes", () => {
    expect(valueSummary({ amountMinor: 14000, currency: "USD" })).toBe(
      "$140.00",
    );
    expect(valueSummary("x".repeat(500))).toHaveLength(220);
    expect(durationText(0)).toBe("0 ms");
    expect(durationText(1500)).toBe("1.50 s");
    expect(durationText(60_000)).toBe("1.0 min");
  });
});

async function transcript(action: string, renderer: string, closingText = false) {
  const tool: AgentToolCall = {
    id: "tool_run",
    name: action,
    input: { runId: saved.id },
    output: structuredClone(saved),
    status: "completed",
  };
  const widget: AgentWidget = {
    id: "widget_run",
    kind: renderer,
    data: { toolCallId: tool.id },
  };
  chat = new AgentKitClient({
    transport: {
      async startRun() {
        throw new Error("Offline tests never call a model");
      },
      async *subscribeToRun() {},
      async cancelRun() {},
      async getThreadSnapshot() {
        return {
          id: "thread_runs",
          createdAt: "2026-11-02T00:00:00Z",
          updatedAt: "2026-11-02T00:00:00Z",
          messages: [
            {
              id: "message_run",
              role: "assistant",
              status: "complete",
              parts: closingText ? [{ type: "text", text: "Review the approval card to continue." }] : [{ type: "widget", widget }],
            },
          ],
          toolCalls: [tool],
          widgets: [{ messageId: "message_run", widget }],
        };
      },
    },
  });
  await chat.loadThread("thread_runs");
  await mount(
    <CoreAgentKitRoot controller={chat} threadId="thread_runs" load="manual" resolveMessageContentOrder={recipeCardOrder}>
      <AgentKitChat composer={false} />
    </CoreAgentKitRoot>,
  );
}

describe("registered renderers inside the mounted AgentKit chat transcript", () => {
  it("places a restored approval card before the brief closing text", async () => {
    await transcript("get-recipe-run", RUN_CARD_RENDERER, true);
    await settle(() => expect(element.querySelector("[data-run-card]")).not.toBeNull());
    const card = element.querySelector("[data-run-card]")!;
    const closing = [...element.querySelectorAll("p")].find((node) => node.textContent === "Review the approval card to continue.")!;
    expect(closing).toBeDefined();
    expect(card.compareDocumentPosition(closing) & 4).toBe(4);
    expect(element.querySelectorAll("[data-run-card]")).toHaveLength(1);
  });
  it.each([
    ["run-recipe", RUN_CARD_RENDERER],
    ["get-recipe-run", RUN_CARD_RENDERER],
    ["resume-recipe-run", APPROVAL_CARD_RENDERER],
  ])(
    "%s mounts its card with live approval controls",
    async (action, renderer) => {
      await transcript(action, renderer);
      await settle(() =>
        expect(
          element.querySelector('[data-run-card="run_ui"]'),
        ).not.toBeNull(),
      );
      await settle(() => expect(button("Approve").disabled).toBe(false));
      expect(
        element.querySelectorAll(
          '.run-timeline-compact li[data-status="completed"]',
        ),
      ).toHaveLength(1);
      expect(element.querySelector(".run-chat-card")?.textContent).toContain("Order ID: ord_1001");
      expect(element.querySelector(".run-chat-card")?.textContent).toContain("Ember Large Serving Platter × 4 ($280.00 each)");
      expect(element.querySelector(".run-approval")?.textContent).toContain("$140.00");
      expect(element.querySelector(".run-approval")?.textContent).toContain("Request ID: req_0001");
      await settle(() => expect(element.querySelector(".kiln-cost")?.textContent).toBe("0 tokens · 30 ms"));
      await click(button("Approve"));
      await settle(() =>
        expect(
          element.querySelector(".run-chat-card .run-status")?.textContent,
        ).toBe("Completed"),
      );
      expect(element.querySelector(".run-approval button")).toBeNull();
      expect(
        calls.find((call) => call.name === "resume-recipe-run")?.input,
      ).toEqual({
        runId: saved.id,
        approval: { stepId: "refund", decision: "approve" },
      });
    },
  );
  it("rejects in chat and removes a gate already decided elsewhere", async () => {
    await transcript("get-recipe-run", RUN_CARD_RENDERER);
    await settle(() => expect(button("Reject").disabled).toBe(false));
    await click(button("Reject"));
    await settle(() =>
      expect(
        element.querySelector(".run-chat-card .run-status")?.textContent,
      ).toBe("Aborted"),
    );
    expect(
      calls.find((call) => call.name === "resume-recipe-run")?.input,
    ).toEqual({
      runId: saved.id,
      approval: { stepId: "refund", decision: "reject" },
    });
  });
  it("reconciles historical tool output against a gate already decided in another surface", async () => {
    const snapshot = structuredClone(saved);
    await transcript("get-recipe-run", RUN_CARD_RENDERER);
    await settle(() => expect(button("Approve").disabled).toBe(false));
    saved = { ...snapshot, status: "aborted", awaitingApprovalStepId: null };
    await act(async () => {
      await queries.invalidateQueries({ queryKey: ["action"] });
    });
    await settle(() =>
      expect(
        element.querySelector(".run-chat-card .run-status")?.textContent,
      ).toBe("Aborted"),
    );
    expect(element.querySelector(".run-approval button")).toBeNull();
    expect(calls.some((call) => call.name === "resume-recipe-run")).toBe(false);
  });
});
