import { callAction, useDbSync } from "@agent-native/core/client/hooks";
import type { Run, Demonstration, DemonstrationStep } from "@muscle-memory/recipe-engine";
import { PROCESSING_STATES, type RequestProcessing } from "@shared/request-processing";
import {
  GetRequestActivity,
  type Reply,
  type Refund,
  type Order,
} from "@muscle-memory/shop-domain";
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";

import { createShopDemoData } from "../../../server/db/shop-demo-data";
import { damagedItemFixture } from "../../../server/fixtures/intake-recipes";
import { isLiveShopPath } from "@/lib/shop-workspace";
import { InboxPage } from "./InboxPage";
import { RequestPage } from "./RequestPage";
import { stepArgument } from "./TeachBar";

const agent = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@agent-native/core/client/agent-chat", () => ({
  sendToAgentChat: agent.send,
}));
vi.mock("@agent-native/toolkit/app/chat", () => ({
  AgentToggleButton: () => <button>Agent sidebar</button>,
}));
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

const fixtures = createShopDemoData();
let request = structuredClone(fixtures.requests[0]!);
let order = structuredClone(
  fixtures.orders.find((item) => item.id === request.orderId)!,
);
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let failure: string | undefined;
let holdWrite: (() => Promise<void>) | undefined;
let holdRead: (() => Promise<void>) | undefined;
let emptyInbox: boolean;
let savedReplies: Reply[];
let savedRefunds: Refund[];
let savedReplacements: Order[];
let demonstration: Demonstration | null;
let captureFailure: boolean;
let calls: { name: string; input: Record<string, unknown>; method: string }[];
let processing: RequestProcessing[];
let incoming: typeof fixtures.requests;
let recipeRun: Run;
let remoteSync = false;

function processingRow(state: RequestProcessing["state"], requestId = request.id): RequestProcessing {
  return { requestId, runId: "run_ui", state, matchReason: "matched", tokens: { input: 0, output: 0 } };
}
function awaitingRun(): Run {
  return {
    id: "run_ui", recipe: damagedItemFixture, trigger: { requestId: request.id }, mode: "execute", status: "awaiting_approval",
    createdAt: 1, updatedAt: 1, pendingStepIds: ["refund"], approvedStepIds: [], awaitingApprovalStepId: "refund", tokens: { input: 0, output: 0 }, failure: null, handoff: null,
    steps: [{ stepId: "refund", kind: "action", action: "issue-refund", effect: "mutation", attempt: 1, status: "awaiting_approval", approvalRequired: true,
      input: { orderId: order.id, amount: { amountMinor: 12500, currency: "USD" }, reason: "Damage" }, output: null,
      startedAt: 1, finishedAt: null, durationMs: 0, tokens: { input: 0, output: 0 }, error: null, blockedBy: [] }],
  };
}

async function settle(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assertion();
  });
}

function element<T extends Element>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}
function byText(text: string, selector = "button"): HTMLElement {
  const result = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!result) throw new Error(`Missing ${selector}: ${text}`);
  return result;
}
async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}
// Exercise the pointer-down path used by Radix mouse triggers; click() alone
// does not open a DropdownMenu and happy-dom does not enforce CSS hit testing.
async function pointerClick(target: HTMLElement) {
  await act(async () => {
    const pointer = {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
    };
    target.dispatchEvent(
      new PointerEvent("pointerdown", { ...pointer, buttons: 1 }),
    );
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1 }),
    );
    target.dispatchEvent(
      new PointerEvent("pointerup", { ...pointer, buttons: 0 }),
    );
    target.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0 }),
    );
    target.click();
  });
}
function expectPagePointerInput() {
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(getComputedStyle(document.body).pointerEvents).not.toBe("none");
}
const menuDialogs = [
  {
    label: "Issue refund",
    action: "issue-refund",
    fill: async () => {
      await fill('input[name="amount"]', "140.00");
      await fill('textarea[name="reason"]', "50% of chipped platter price");
    },
  },
  {
    label: "Create replacement",
    action: "create-replacement-order",
    fill: async () => {},
  },
  {
    label: "Change shipping address",
    action: "update-shipping-address",
    fill: async () => {
      await fill('input[name="line1"]', "14 Studio Lane");
    },
  },
  {
    label: "Generate return label",
    action: "generate-return-label",
    fill: async () => {},
  },
  {
    label: "Escalate request",
    action: "escalate",
    fill: async () => {
      await fill('textarea[name="reason"]', "Human review required");
    },
  },
] as const;
async function openDialogWithMouse(label: string) {
  await pointerClick(
    label === "Escalate request"
      ? element('button[aria-label="Change request status"]')
      : byText("Order actions"),
  );
  await settle(() =>
    expect(document.querySelector('[role="menu"]')).not.toBeNull(),
  );
  // Only the modal dialog may own the body pointer lock during the handoff.
  // Checking the actual style catches the root cause even without CSS hit testing.
  expect(document.body.style.pointerEvents).not.toBe("none");
  await pointerClick(byText(label, '[role="menuitem"]'));
  await settle(() =>
    expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
  );
  expect(document.body.style.pointerEvents).toBe("none");
  expect(getComputedStyle(element('[role="dialog"]')).pointerEvents).toBe(
    "auto",
  );
}
async function openMenu(label: string) {
  await act(async () => {
    byText(label).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}
async function chooseOperation(label: string) {
  await openMenu("Order actions");
  await click(byText(label, '[role="menuitem"]'));
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const field = element<HTMLInputElement | HTMLTextAreaElement>(selector);
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(label: string) {
  await act(async () => {
    element<HTMLFormElement>(`form[aria-label="${label}"]`).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}
function writes(name?: string) {
  return calls.filter(
    (call) => call.method === "POST" && (!name || call.name === name),
  );
}

async function mount(page: "request" | "inbox" = "request", path = "/inbox") {
  await render(page, path);
  await settle(() => expect(container.querySelector("h1")).not.toBeNull());
  if (page === "request" && request.orderId)
    await settle(() =>
      expect(container.textContent).toContain("Order actions"),
    );
}

function LocalAgentSync() {
  useDbSync({ queryClient: client, ...(remoteSync ? { realtime: { reason: "Incoming requests change while the inbox is open" } } : {}) });
  return null;
}
async function render(page: "request" | "inbox", path = "/inbox") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LocalAgentSync />
        <MemoryRouter initialEntries={[path]}>
          {page === "request" ? (
            <RequestPage requestId={request.id} />
          ) : (
            <InboxPage />
          )}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  request = structuredClone(fixtures.requests[0]!);
  order = structuredClone(
    fixtures.orders.find((item) => item.id === request.orderId)!,
  );
  failure = undefined;
  holdWrite = undefined;
  holdRead = undefined;
  emptyInbox = false;
  savedReplies = [];
  savedRefunds = [];
  savedReplacements = [];
  calls = [];
  processing = [];
  incoming = [];
  recipeRun = awaitingRun();
  remoteSync = false;
  demonstration = null;
  captureFailure = false;
  agent.send.mockReset();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url, "http://localhost");
      const name = parsed.pathname.split("/").slice(-1)[0]!;
      if (name === "get-actions-batch")
        return Response.json(
          { error: "get-actions-batch unavailable in fake transport" },
          { status: 404 },
        );
      const method = init.method ?? "GET";
      const input =
        method === "GET"
          ? Object.fromEntries(parsed.searchParams)
          : JSON.parse(String(init.body ?? "{}"));
      calls.push({ name, input, method });
      if (method === "POST") await holdWrite?.();
      if (method === "GET") await holdRead?.();
      if (failure === name)
        return Response.json(
          {
            error: "Shop policy rejected this operation",
            errorCode: "ADDRESS_CHANGE_NOT_ALLOWED",
          },
          { status: 409 },
        );
      function result(output: unknown): Response {
        if (
          demonstration?.status === "recording" &&
          [
            "get-request",
            "get-order",
            "get-customer",
            "get-shipment-status",
            "get-request-activity",
            "list-requests",
            "send-reply",
            "issue-refund",
            "tag-request",
            "set-request-status",
          ].includes(name)
        ) {
          if (captureFailure && method === "POST")
            demonstration = {
              ...demonstration,
              status: "incomplete",
              incompleteReason:
                "Could not save captured step. The shop action succeeded; do not repeat it.",
            };
          // This request-page fixture has one input for each GET action. The
          // engine/PGlite tests exercise canonical inputs and concurrent reads.
          else if (
            method !== "GET" ||
            !demonstration.steps.some((step) => step.action === name)
          ) {
            const sequence = demonstration.nextSequence;
            demonstration = {
              ...demonstration,
              nextSequence: sequence + 1,
              steps: [
                ...demonstration.steps,
                {
                  id: `step_${sequence}`,
                  sequence,
                  action: name,
                  input,
                  output: output as never,
                  navigation: { view: "request", requestId: request.id },
                  startedAt: Date.now(),
                  durationMs: 4,
                  caller: "frontend",
                },
              ],
            };
          }
        }
        return Response.json(output);
      }
      switch (name) {
        case "get-demonstration":
          return result(demonstration);
        case "start-demonstration": {
          if (demonstration?.status === "recording")
            return Response.json(
              { error: "A demonstration is already recording" },
              { status: 409 },
            );
          demonstration = {
            id: "demo_ui",
            scope: {
              userId: "operator@example.test",
              workspaceId: "shop",
              sessionId: "test",
            },
            subjectId: request.id,
            references: {},
            trigger: {
              ...(request.content.source === "structured"
                ? request.content.fields
                : input.fields),
              requestId: request.id,
              customerId: request.customerId,
              subject: request.subject,
            },
            status: "recording",
            startedAt: Date.now(),
            stoppedAt: null,
            nextSequence: 1,
            pending: [],
            incompleteReason: null,
            steps: [],
          };
          return result(demonstration);
        }
        case "stop-demonstration":
        case "cancel-demonstration": {
          if (demonstration)
            demonstration = {
              ...demonstration,
              status:
                name === "cancel-demonstration"
                  ? "cancelled"
                  : demonstration.status === "incomplete"
                    ? "incomplete"
                    : "completed",
              stoppedAt: Date.now(),
            };
          return result(demonstration);
        }
        case "get-request":
          return result(request);
        case "get-request-activity": {
          const activity = await new GetRequestActivity({
            getRequestActivityRecords: async () => ({
              request,
              order: request.orderId ? order : null,
              shipment: null,
              replies: savedReplies,
              refunds: savedRefunds,
              replacements: savedReplacements,
            }),
          }).execute({ requestId: request.id });
          return result(activity.ok ? activity.value : []);
        }
        case "get-order":
          return result(order);
        case "get-customer":
          return result(
            fixtures.customers.find((item) => item.id === input.customerId),
          );
        case "get-shipment-status":
          return result({
            orderStatus: order.status,
            shipment:
              fixtures.shipments.find((item) => item.orderId === order.id) ??
              null,
          });
        case "list-requests":
          return result(
            emptyInbox
              ? []
              : [...fixtures.requests, ...incoming].filter(
                  (item) =>
                    (!input.customerId ||
                      item.customerId === input.customerId) &&
                    (!input.status || item.status === input.status) &&
                    (!input.type ||
                      (item.content.source === "structured"
                        ? item.content.fields.type
                        : item.content.type) === input.type),
                ),
          );
        case "list-request-processing":
          return Response.json(processing);
        case "get-recipe-run":
          return Response.json(recipeRun);
        case "resume-recipe-run":
          recipeRun = { ...recipeRun, status: input.approval.decision === "approve" ? "completed" : "aborted", awaitingApprovalStepId: null };
          processing = [processingRow("done")];
          return Response.json(recipeRun);
        case "demo-intake":
          incoming = Array.from({ length: 5 }, (_, index) => ({ ...request, id: `req_new${index}` as const, subject: `Incoming demo ${index}` }));
          processing = incoming.map((item) => processingRow("with_agent", item.id));
          return Response.json(incoming);
        case "set-request-status":
          request = {
            ...request,
            status: input.status,
            updatedAt: "2026-11-02T14:00:00Z",
          };
          return result(request);
        case "tag-request":
          request = { ...request, tags: [...request.tags, input.tag] };
          return result(request);
        case "escalate":
          request = {
            ...request,
            status: "escalated",
            escalation: {
              reason: input.reason,
              escalatedAt: "2026-11-02T14:00:00Z",
            },
          };
          return result(request);
        case "send-reply": {
          const reply = {
            ...fixtures.replies[0]!,
            id: `rpl_${savedReplies.length}` as const,
            requestId: request.id,
            body: input.template,
          };
          savedReplies.push(reply);
          return result(reply);
        }
        case "issue-refund": {
          const refund = {
            ...fixtures.refunds[0]!,
            id: `ref_${savedRefunds.length}` as const,
            orderId: order.id,
            amount: input.amount ?? order.paid,
            reason: input.reason,
          };
          savedRefunds.push(refund);
          return result(refund);
        }
        case "create-replacement-order": {
          const replacement: Order = { ...order, id: "ord_replacement" };
          savedReplacements.push(replacement);
          return result(replacement);
        }
        case "update-shipping-address":
          order = { ...order, shippingAddress: input.address };
          return result(order);
        case "generate-return-label": {
          const label = {
            id: "lbl_test",
            orderId: order.id,
            createdAt: "2026-11-02T14:00:00Z",
            fromAddress: order.shippingAddress,
          } as const;
          order = { ...order, returnLabel: label };
          return result(label);
        }
        default:
          return result({});
      }
    }),
  );
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("shop workspace with real framework action hooks and an offline action transport", () => {
  it("keeps the approval banner available while Teach starts and saves on the same request", async () => {
    processing = [processingRow("awaiting_approval")];
    await mount();
    await settle(() => expect(container.textContent).toContain("Step refund · issue-refund"));
    expect(byText("Approve")).toBeDefined();
    await click(byText("Teach"));
    await settle(() => expect(demonstration?.status).toBe("recording"));
    expect(container.querySelector('[data-processing="awaiting_approval"]')).not.toBeNull();
    await click(byText("Stop & save"));
    await settle(() => expect(demonstration?.status).toBe("completed"));
    expect(container.textContent).toContain("Step refund · issue-refund");
    expect(byText("Approve")).toBeDefined();
    expect(writes("resume-recipe-run")).toHaveLength(0);
  });
  it("shows every processing outcome alongside shop status, with none invented for seed requests", async () => {
    processing = PROCESSING_STATES.map((state, index) => processingRow(state, fixtures.requests[index]!.id));
    processing.push(processingRow(null, fixtures.requests[4]!.id));
    await mount("inbox");
    await settle(() => expect(container.querySelectorAll("[data-processing]")).toHaveLength(5));
    for (const state of PROCESSING_STATES) {
      const chip = element(`[data-processing="${state}"]`);
      expect(chip.closest("li")?.querySelector("[data-status]")).not.toBeNull();
    }
    expect(container.querySelectorAll(".shop-inbox-row").length).toBeGreaterThan(5);
    expect(container.textContent).toContain("Processing…");
  });

  it("combines the processing URL filter with shop filters and updates membership after agent changes", async () => {
    processing = [processingRow("awaiting_approval")];
    const type = request.content.source === "structured" ? request.content.fields.type : request.content.type;
    await mount("inbox", `/inbox?processing=awaiting_approval&status=${request.status}&type=${type}`);
    await settle(() => expect(container.querySelectorAll(".shop-inbox-row")).toHaveLength(1));
    expect(calls.find((call) => call.name === "list-requests")?.input).toEqual({ status: request.status, type });
    processing = [processingRow("done")];
    await act(async () => window.dispatchEvent(new CustomEvent("agent-native:tool-done", { detail: { tool: "resume-recipe-run", completedSideEffect: true } })));
    await settle(() => expect(container.querySelectorAll(".shop-inbox-row")).toHaveLength(0));
    await click(byText("Clear filters"));
    await settle(() => expect(container.querySelector('[data-processing="done"]')).not.toBeNull());
  });

  it("injects a real demo action, blocks duplicate submissions and shows arriving requests without reload", async () => {
    await mount("inbox");
    let release!: () => void;
    holdWrite = () => new Promise<void>((resolve) => { release = resolve; });
    const button = byText("Demo · Simulate incoming requests");
    await click(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.textContent).toContain("Processing incoming");
    await click(button);
    expect(writes("demo-intake")).toHaveLength(1);
    await act(async () => { holdWrite = undefined; release(); });
    await settle(() => expect(container.textContent).toContain("Incoming demo 4"));
    expect(writes("demo-intake")[0]?.input).toEqual({});
    expect(container.textContent).toContain("5 requests added");
    expect(container.querySelectorAll('[data-processing="with_agent"]')).toHaveLength(5);
  });

  it("reports demo failure with partial-batch guidance and rereads saved requests", async () => {
    await mount("inbox");
    failure = "demo-intake";
    incoming = [{ ...request, id: "req_partial", subject: "Saved before error" }];
    await click(byText("Demo · Simulate incoming requests"));
    await settle(() => expect(container.textContent).toContain("Some requests may already be saved"));
    await settle(() => expect(container.textContent).toContain("Saved before error"));
    expect(writes("demo-intake")).toHaveLength(1);
  });

  it("opens a queued handoff in the shared sidebar with saved run IDs and bounded context", async () => {
    processing = [processingRow("with_agent")];
    recipeRun = { ...recipeRun, status: "handed_off", awaitingApprovalStepId: null, handoff: {
      status: "delivered", error: null, context: { idempotencyKey: "run_ui:handoff", runId: "run_ui", recipeVersionId: damagedItemFixture.id,
        trigger: { privateOriginal: "Do not copy this into the chat context" }, stepId: "handoff", to: "agent", reason: "step", note: "No matching recipe; review the wholesale inquiry", steps: [], outputs: {} },
    } };
    await mount();
    await settle(() => expect(container.textContent).toContain("Handoff queued for agent review"));
    await click(byText("Open handoff in agent"));
    expect(agent.send).toHaveBeenCalledWith(expect.objectContaining({ submit: true, openSidebar: true, message: expect.stringContaining("get-recipe-run") }));
    const context = agent.send.mock.calls[0]![0].context;
    expect(JSON.parse(context)).toMatchObject({ requestId: request.id, runId: "run_ui", handoffStepId: "handoff" });
    expect(context).not.toContain("privateOriginal");
    expect(writes()).toHaveLength(0);
  });

  it.each(["approve", "reject"] as const)("shows the saved step and amount and sends exact %s decision, refreshing the banner", async (decision) => {
    processing = [processingRow("awaiting_approval")];
    await mount();
    await settle(() => expect(container.textContent).toContain("Step refund · issue-refund"));
    expect(container.textContent).toContain("125.00");
    let release!: () => void;
    holdWrite = () => new Promise<void>((resolve) => { release = resolve; });
    await click(byText(decision === "approve" ? "Approve" : "Reject"));
    expect(byText("Reject").hasAttribute("disabled")).toBe(true);
    await click(byText("Reject"));
    expect(writes("resume-recipe-run")).toHaveLength(1);
    await act(async () => { holdWrite = undefined; release(); });
    await settle(() => expect(container.querySelector('[data-processing="done"]')).not.toBeNull());
    expect(container.querySelector('[aria-label="Request processing"] a[href="/runs/run_ui"]')?.textContent).toBe("View run");
    expect(container.querySelector('[aria-label="Request processing"] button')).toBeNull();
    expect(writes("resume-recipe-run")[0]?.input).toEqual({ runId: "run_ui", approval: { stepId: "refund", decision } });
    expect(writes("issue-refund")).toHaveLength(0);
  });

  it("keeps approval errors visible, rereads the checkpoint and disables decisions on failed refresh", async () => {
    processing = [processingRow("awaiting_approval")];
    await mount();
    await settle(() => expect(container.textContent).toContain("Step refund"));
    failure = "resume-recipe-run";
    await click(byText("Approve"));
    await settle(() => expect(container.textContent).toContain("Review its state before deciding again"));
    failure = "get-recipe-run";
    await act(async () => { await client.invalidateQueries({ queryKey: ["action"] }); });
    await settle(() => expect(byText("Approve").hasAttribute("disabled")).toBe(true));
    expect(writes("resume-recipe-run")).toHaveLength(1);
  });

  it("reports a processing read failure without claiming a filtered inbox is empty", async () => {
    failure = "list-request-processing";
    await mount("inbox", "/inbox?processing=with_agent");
    await settle(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).not.toContain("No requests match");
  });

  it("limits live sync to shop work routes", () => {
    expect(isLiveShopPath("/inbox")).toBe(true);
    expect(isLiveShopPath("/requests/req_0001")).toBe(true);
    expect(isLiveShopPath("/runs")).toBe(true);
    expect(isLiveShopPath("/runs/run_0001")).toBe(true);
    for (const path of ["/", "/sign-in", "/chat", "/settings", "/inbox/public", "/requests"]) expect(isLiveShopPath(path)).toBe(false);
  });

  it("receives external arrivals and processing changes through the framework's shared SSE transport", async () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      static CLOSED = 2;
      readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { sources.push(this); }
      close() {}
      addEventListener() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    remoteSync = true;
    await mount("inbox");
    await settle(() => expect(sources[0]?.onmessage).toBeTypeOf("function"));
    const source = sources[0]!;
    incoming = [{ ...request, id: "req_remote", subject: "External arrival" }];
    processing = [processingRow("awaiting_approval", "req_remote")];
    await act(async () => source?.onmessage?.({ data: JSON.stringify({ version: 1, events: [{ source: "action", version: 1 }] }) }));
    await settle(() => expect(container.textContent).toContain("External arrival"));
    expect(container.querySelector('[data-processing="awaiting_approval"]')).not.toBeNull();
    processing = [processingRow("done", "req_remote")];
    await act(async () => source?.onmessage?.({ data: JSON.stringify({ version: 2, events: [{ source: "action", version: 2 }] }) }));
    await settle(() => expect(container.querySelector('[data-processing="done"]')).not.toBeNull());
    expect(writes()).toHaveLength(0);
  });

  it.each(
    menuDialogs.flatMap((dialog) =>
      ["submit", "cancel", "rejected submit"].map((exit) => ({
        ...dialog,
        exit,
      })),
    ),
  )(
    "releases page pointer input after $label: $exit (TASK-8 regression)",
    async ({ label, action, fill: prepare, exit }) => {
      await mount();
      await pointerClick(byText("Teach"));
      await settle(() => expect(demonstration?.status).toBe("recording"));
      await openDialogWithMouse(label);
      if (exit !== "cancel") {
        await prepare();
        if (exit === "rejected submit") failure = action;
        await submit(label);
        if (exit === "rejected submit") {
          await settle(() =>
            expect(
              document.querySelector('[role="dialog"] [role="alert"]')
                ?.textContent,
            ).toContain("Shop policy rejected"),
          );
          expect(document.querySelector('[role="dialog"]')).not.toBeNull();
          expect(
            getComputedStyle(element('[role="dialog"]')).pointerEvents,
          ).toBe("auto");
          await pointerClick(byText("Cancel"));
        }
      } else await pointerClick(byText("Cancel"));
      await settle(expectPagePointerInput);
      expect(writes(action)).toHaveLength(exit === "cancel" ? 0 : 1);
      failure = undefined;
      await pointerClick(byText("Stop & save"));
      await settle(() => expect(demonstration?.status).toBe("completed"));
      expect(writes("stop-demonstration")).toHaveLength(1);
      expectPagePointerInput();
    },
  );

  it("continues refund → reply → tag → Stop with mouse input after closing the refund dialog", async () => {
    await mount();
    await pointerClick(byText("Teach"));
    await settle(() => expect(demonstration?.status).toBe("recording"));
    await openDialogWithMouse("Issue refund");
    await menuDialogs[0].fill();
    await submit("Issue refund");
    await settle(expectPagePointerInput);
    await fill(
      'textarea[name="template"]',
      "We refunded half of the chipped platter’s price.",
    );
    await submit("Save reply");
    await settle(() => expect(savedReplies).toHaveLength(1));
    expectPagePointerInput();
    await pointerClick(byText("Add tag"));
    await fill('input[name="tag"]', "damage-handled");
    await submit("Add tag");
    await settle(expectPagePointerInput);
    await pointerClick(byText("Stop & save"));
    await settle(() => expect(demonstration?.status).toBe("completed"));
    expect(writes("issue-refund")[0]?.input.amount).toEqual({
      amountMinor: 14000,
      currency: "USD",
    });
    expect(
      demonstration!.steps
        .filter((step) =>
          ["issue-refund", "send-reply", "tag-request"].includes(step.action),
        )
        .map((step) => step.action),
    ).toEqual(["issue-refund", "send-reply", "tag-request"]);
    expectPagePointerInput();
  });

  it("summarizes actual refund amounts, rendered replies, addresses and replacement quantities in human terms", () => {
    const step: DemonstrationStep = {
      id: "step_1",
      sequence: 1,
      action: "issue-refund",
      input: { orderId: "ord_1001", reason: "Damage" },
      output: { amount: { amountMinor: 1250, currency: "USD" } },
      navigation: {},
      caller: "frontend",
      startedAt: 1,
      durationMs: 2,
    };
    expect(stepArgument(step)).toBe("$12.50 · ord_1001");
    expect(
      stepArgument({
        ...step,
        action: "send-reply",
        input: { template: "Hello {{name}}", variables: { name: "Maya" } },
        output: { body: "Hello Maya" },
      }),
    ).toBe("Hello Maya");
    expect(
      stepArgument({
        ...step,
        action: "update-shipping-address",
        input: {
          orderId: "ord_1001",
          address: { line1: "14 Studio Lane", city: "Alder Glen" },
        },
      }),
    ).toBe("14 Studio Lane, Alder Glen");
    expect(
      stepArgument({
        ...step,
        action: "create-replacement-order",
        output: {
          items: [{ name: "Chalk Mug", productId: "prd_0001", quantity: 2 }],
        },
      }),
    ).toBe("2 × Chalk Mug");
  });

  it("teaches through shared actions, displays real arguments live, stops and reloads the saved trace", async () => {
    await mount();
    await click(byText("Teach"));
    await settle(() =>
      expect(
        container.querySelector(".shop-teach-bar")?.getAttribute("data-state"),
      ).toBe("recording"),
    );
    await fill(
      'textarea[name="template"]',
      "We have refunded half the chipped platter’s price.",
    );
    await submit("Save reply");
    await settle(() =>
      expect(
        container.querySelector(".shop-teach-strip")?.textContent,
      ).toContain("Save reply"),
    );
    await click(byText("Add tag"));
    await fill('input[name="tag"]', "teach-proof");
    await submit("Add tag");
    await settle(() =>
      expect(
        container.querySelector(".shop-teach-strip")?.textContent,
      ).toContain("teach-proof"),
    );
    await settle(() =>
      expect(container.querySelector(".shop-teach-count")?.textContent).toBe(
        "2 actions · 5 lookups",
      ),
    );
    expect(container.querySelectorAll(".shop-teach-strip li")).toHaveLength(2);
    expect(container.querySelectorAll(".shop-teach-lookup")).toHaveLength(5);
    const platter = order.items.find(
      (item) =>
        request.content.source === "structured" &&
        request.content.fields.type === "damaged_item" &&
        item.productId === request.content.fields.productId,
    )!;
    const halfPriceMinor = Math.round(platter.unitPrice.amountMinor * 0.5);
    await chooseOperation("Issue refund");
    await fill('input[name="amount"]', (halfPriceMinor / 100).toFixed(2));
    await fill('textarea[name="reason"]', "50% of chipped platter price");
    await submit("Issue refund");
    await settle(() =>
      expect(container.querySelector(".shop-teach-count")?.textContent).toBe(
        "3 actions · 5 lookups",
      ),
    );
    expect(writes("issue-refund")[0]?.input).toEqual({
      orderId: order.id,
      reason: "50% of chipped platter price",
      amount: { amountMinor: halfPriceMinor, currency: order.paid.currency },
    });
    expect(container.querySelector(".shop-teach-strip")?.textContent).toContain(
      `$${(halfPriceMinor / 100).toFixed(2)}`,
    );
    expect(
      [...container.querySelectorAll(".shop-teach-step-number")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["1", "2", "3"]);
    expect(
      [...container.querySelectorAll(".shop-teach-step-action")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["Save reply", "Add tag", "Issue refund"]);
    await click(byText("Inspect captured trace", "summary"));
    const inspected = JSON.parse(
      container.querySelector(".shop-teach-inspect pre")!.textContent!,
    );
    expect(inspected.steps).toEqual(
      JSON.parse(JSON.stringify(demonstration!.steps)),
    );
    expect(inspected.steps).toHaveLength(8);
    await click(byText("Stop & save"));
    await settle(() =>
      expect(container.querySelector(".shop-teach-bar")?.textContent).toContain(
        "Demonstration saved",
      ),
    );
    expect(
      demonstration?.steps.some(
        (s) => s.action === "tag-request" && s.input.tag === "teach-proof",
      ),
    ).toBe(true);
    expect(demonstration?.steps.some((s) => s.action === "issue-refund")).toBe(
      true,
    );
    expect(writes("start-demonstration")).toHaveLength(1);
    expect(writes("stop-demonstration")).toHaveLength(1);
    await act(async () => {
      root.render(null);
    });
    client.clear();
    await mount();
    await settle(() =>
      expect(container.querySelector(".shop-teach-bar")?.textContent).toContain(
        "Demonstration saved",
      ),
    );
    expect(container.querySelector(".shop-teach-strip")?.textContent).toContain(
      "teach-proof",
    );
  });

  it("updates secondary lookups from shared sync without adding primary cards or refetching shop queries", async () => {
    const streams: Array<{
      onmessage: ((message: { data: string }) => void) | null;
    }> = [];
    class FakeEventSource {
      static CLOSED = 2;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((message: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        streams.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener() {}
      close() {
        this.readyState = 2;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    await mount();
    await click(byText("Teach"));
    await settle(() => expect(streams.length).toBeGreaterThan(0));
    await settle(() => expect(demonstration!.steps.length).toBe(5));
    await act(async () => {
      await callAction(
        "list-requests",
        { customerId: request.customerId, type: "damaged_item" },
        { method: "GET" },
      );
    });
    const captured = demonstration!.steps.length;
    const shopReads = () =>
      calls.filter((c) =>
        [
          "get-request",
          "get-order",
          "get-customer",
          "get-shipment-status",
          "get-request-activity",
        ].includes(c.name),
      ).length;
    const before = shopReads();
    await act(async () => {
      streams[streams.length - 1]!.onmessage?.({
        data: JSON.stringify({
          source: "action",
          type: "updated",
          key: "get-demonstration",
          resourceType: "demonstrations",
          version: Date.now(),
        }),
      });
    });
    await settle(() =>
      expect(container.querySelectorAll(".shop-teach-lookup").length).toBe(
        captured,
      ),
    );
    expect(shopReads()).toBe(before);
    expect(container.querySelectorAll(".shop-teach-strip li")).toHaveLength(0);
    expect(container.querySelector(".shop-teach-count")?.textContent).toBe(
      "0 actions · 6 lookups",
    );
  });

  it("confirms free-text request details through labeled fields before teaching", async () => {
    request = {
      ...request,
      content: {
        source: "free_text",
        type: "damaged_item",
        text: "One piece arrived chipped.",
      },
    };
    await mount();
    await click(byText("Teach"));
    await settle(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    await fill('textarea[name="description"]', "One piece arrived chipped.");
    await submit("Confirm the request fields");
    await settle(() => expect(demonstration?.status).toBe("recording"));
    expect(writes("start-demonstration")[0]?.input).toEqual({
      requestId: request.id,
      fields: {
        type: "damaged_item",
        orderId: request.orderId,
        productId: order.items[0]!.productId,
        quantity: 1,
        description: "One piece arrived chipped.",
      },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("acknowledges starting immediately and prevents duplicate Teach submits", async () => {
    await mount();
    let release!: () => void;
    holdWrite = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const teach = byText("Teach");
    await click(teach);
    expect(
      container.querySelector(".shop-teach-bar")?.getAttribute("aria-busy"),
    ).toBe("true");
    await click(teach);
    expect(writes("start-demonstration")).toHaveLength(1);
    holdWrite = undefined;
    await act(async () => {
      release();
    });
    await settle(() => expect(demonstration?.status).toBe("recording"));
  });

  it("discards a recording and starts another without losing saved shop effects", async () => {
    await mount();
    await click(byText("Teach"));
    await settle(() =>
      expect(
        container.querySelector('[aria-label="Discard recording"]'),
      ).not.toBeNull(),
    );
    await click(element('[aria-label="Discard recording"]'));
    await settle(() => expect(demonstration?.status).toBe("cancelled"));
    await click(byText("Teach"));
    await settle(() => expect(demonstration?.status).toBe("recording"));
    expect(writes("start-demonstration")).toHaveLength(2);
  });

  it("shows a capture failure without inviting a repeat of the successful shop action", async () => {
    await mount();
    await click(byText("Teach"));
    await settle(() => expect(demonstration?.status).toBe("recording"));
    captureFailure = true;
    await fill('textarea[name="template"]', "Saved despite capture failure.");
    await submit("Save reply");
    await settle(() =>
      expect(container.querySelector(".shop-teach-bar")?.textContent).toContain(
        "Recording incomplete",
      ),
    );
    expect(container.textContent).toContain("Reply saved");
    expect(savedReplies).toHaveLength(1);
    expect(writes("send-reply")).toHaveLength(1);
    expect(container.querySelector(".shop-teach-error")?.textContent).toContain(
      "do not repeat",
    );
  });

  it("handles a request manually: saves reply, tags and resolves, refreshing the visible status", async () => {
    await mount();
    expect(container.textContent).toContain(request.subject);
    const product = container.querySelector(".shop-form-fields dd");
    expect(product).not.toBeNull();
    expect(
      container.querySelector(".shop-original-message")?.textContent,
    ).toContain(order.items[0]!.name);
    expect(byText("Teach")).toBeDefined();
    await fill(
      'textarea[name="template"]',
      "We have refunded the chipped piece. Thank you for letting us know.",
    );
    await submit("Save reply");
    await settle(() => expect(container.textContent).toContain("Reply saved"));
    await settle(() =>
      expect(container.querySelector(".shop-timeline")?.textContent).toContain(
        "We have refunded the chipped piece.",
      ),
    );
    expect(writes("send-reply")[0]?.input).toEqual({
      requestId: request.id,
      template:
        "We have refunded the chipped piece. Thank you for letting us know.",
      variables: {},
    });
    await click(byText("Add tag"));
    await fill('input[name="tag"]', "damage-handled");
    await submit("Add tag");
    await settle(() =>
      expect(
        [...container.querySelectorAll(".shop-tag")].some(
          (tag) => tag.textContent === "damage-handled",
        ),
      ).toBe(true),
    );
    await click(byText("Resolve request"));
    await settle(() =>
      expect(
        container.querySelector(".shop-status")?.getAttribute("data-status"),
      ).toBe("resolved"),
    );
    expect(writes("set-request-status")[0]?.input).toEqual({
      requestId: request.id,
      status: "resolved",
    });
    expect(
      calls.filter((call) => call.name === "get-request").length,
    ).toBeGreaterThan(1);
  });

  it("uses the action-query refresh path after an agent write without polling or reloading", async () => {
    await mount();
    request = { ...request, status: "pending", tags: ["agent-handled"] };
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("agent-native:tool-done", {
          detail: { tool: "set-request-status", completedSideEffect: true },
        }),
      );
    });
    await settle(() =>
      expect(
        container.querySelector(".shop-status")?.getAttribute("data-status"),
      ).toBe("pending"),
    );
    expect(container.textContent).toContain("agent-handled");
    expect(writes()).toHaveLength(0);
  });

  it("routes agent work through the shared sidebar with bounded request context", async () => {
    await mount();
    await click(byText("Handle with agent"));
    expect(agent.send).toHaveBeenCalledWith(
      expect.objectContaining({
        openSidebar: true,
        submit: false,
        message: expect.stringContaining(request.id),
        context: expect.stringContaining(request.customerId),
      }),
    );
    expect(writes()).toHaveLength(0);
  });

  it("sends custom and remaining-balance refunds through issue-refund", async () => {
    await mount();
    await chooseOperation("Issue refund");
    await fill('input[name="amount"]', "12.50");
    await fill('textarea[name="reason"]', "Chipped rim");
    await submit("Issue refund");
    await settle(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(writes("issue-refund")[0]?.input).toEqual({
      orderId: order.id,
      reason: "Chipped rim",
      amount: { amountMinor: 1250, currency: order.paid.currency },
    });
    await settle(() =>
      expect(container.querySelector(".shop-timeline")?.textContent).toContain(
        "Chipped rim",
      ),
    );
    await chooseOperation("Issue refund");
    await fill('textarea[name="reason"]', "Remaining balance");
    await submit("Issue refund");
    await settle(() => expect(writes("issue-refund")).toHaveLength(2));
    expect(writes("issue-refund")[1]?.input).not.toHaveProperty("amount");
  });

  it("creates selected replacements, updates an address, and generates a return label", async () => {
    await mount();
    await chooseOperation("Create replacement");
    await submit("Create replacement");
    await settle(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(writes("create-replacement-order")[0]?.input).toEqual({
      orderId: order.id,
      items: order.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    });
    await settle(() =>
      expect(container.querySelector(".shop-timeline")?.textContent).toContain(
        "Replacement created",
      ),
    );
    await chooseOperation("Change shipping address");
    await fill('input[name="line1"]', "14 Studio Lane");
    await submit("Change shipping address");
    await settle(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(writes("update-shipping-address")[0]?.input).toMatchObject({
      orderId: order.id,
      address: { ...order.shippingAddress, line1: "14 Studio Lane" },
    });
    await chooseOperation("Generate return label");
    await submit("Generate return label");
    await settle(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(writes("generate-return-label")[0]?.input).toEqual({
      orderId: order.id,
    });
    await settle(() =>
      expect(container.querySelector(".shop-timeline")?.textContent).toContain(
        "lbl_test",
      ),
    );
  });

  it("reloads activity from the query after the work surface remounts", async () => {
    await mount();
    await fill(
      'textarea[name="template"]',
      "This reply must survive leaving the request.",
    );
    await submit("Save reply");
    await settle(() =>
      expect(container.querySelector(".shop-timeline")?.textContent).toContain(
        "This reply must survive",
      ),
    );
    await act(async () => {
      root.render(null);
    });
    client.clear();
    await mount();
    await settle(() =>
      expect(container.querySelector(".shop-timeline")?.textContent).toContain(
        "This reply must survive",
      ),
    );
    expect(container.querySelector(".shop-saved-result")).toBeNull();
    expect(
      calls.filter((call) => call.name === "get-request-activity").length,
    ).toBeGreaterThan(1);
  });

  it("escalates with a reason and shows persisted escalation details after refresh", async () => {
    await mount();
    await act(async () => {
      element('button[aria-label="Change request status"]').dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await click(byText("Escalate request", '[role="menuitem"]'));
    await fill(
      'textarea[name="reason"]',
      "Wholesale pricing needs a human review",
    );
    await submit("Escalate request");
    await settle(() =>
      expect(
        container.querySelector(".shop-status")?.getAttribute("data-status"),
      ).toBe("escalated"),
    );
    expect(container.textContent).toContain(
      "Wholesale pricing needs a human review",
    );
    expect(writes("escalate")[0]?.input).toEqual({
      requestId: request.id,
      reason: "Wholesale pricing needs a human review",
    });
  });

  it("keeps rejected inputs and permits retry; cancellation makes no write", async () => {
    await mount();
    failure = "update-shipping-address";
    await chooseOperation("Change shipping address");
    await fill('input[name="line1"]', "22 Kept Lane");
    await submit("Change shipping address");
    await settle(() =>
      expect(element('[role="alert"]').textContent).toContain(
        "Shop policy rejected",
      ),
    );
    expect(element<HTMLInputElement>('input[name="line1"]').value).toBe(
      "22 Kept Lane",
    );
    failure = undefined;
    await submit("Change shipping address");
    await settle(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await chooseOperation("Issue refund");
    await click(byText("Cancel"));
    expect(writes("issue-refund")).toHaveLength(0);
  });

  it("acknowledges pending writes and rejects duplicate submits", async () => {
    await mount();
    let release!: () => void;
    holdWrite = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await fill('textarea[name="template"]', "A carefully saved reply");
    await submit("Save reply");
    await settle(() =>
      expect(
        container
          .querySelector('form[aria-label="Save reply"]')
          ?.getAttribute("aria-busy"),
      ).toBe("true"),
    );
    await submit("Save reply");
    expect(writes("send-reply")).toHaveLength(1);
    await act(async () => {
      release();
    });
    await settle(() => expect(container.textContent).toContain("Reply saved"));
  });

  it("filters the inbox through list-requests and renders customer names, chips and ages", async () => {
    await mount("inbox", "/inbox?status=open&type=damaged_item");
    await settle(() =>
      expect(container.textContent).toContain(fixtures.customers[0]!.name),
    );
    expect(calls.find((call) => call.name === "list-requests")?.input).toEqual({
      status: "open",
      type: "damaged_item",
    });
    expect(
      container.querySelectorAll(".shop-inbox-row").length,
    ).toBeGreaterThan(0);
    expect(container.querySelector("time[datetime]")).not.toBeNull();
    expect(container.querySelector('a[href^="/requests/"]')).not.toBeNull();
    let release!: () => void;
    holdRead = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await click(byText("Clear filters"));
    expect(
      container.querySelector('[aria-label="Filter by status"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(".shop-inbox-list")?.getAttribute("aria-busy"),
    ).toBe("true");
    holdRead = undefined;
    await act(async () => {
      release();
    });
    await settle(() =>
      expect(
        calls.filter((call) => call.name === "list-requests").slice(-1)[0]
          ?.input,
      ).toEqual({}),
    );
  });

  it("renders a no-order inquiry and validates template variables before making a write", async () => {
    request = {
      ...request,
      orderId: null,
      content: {
        source: "structured",
        fields: {
          type: "wholesale_inquiry",
          company: "Test Studio",
          message: "A synthetic wholesale inquiry",
        },
      },
    };
    await mount();
    expect(container.textContent).toContain("No order linked");
    expect(container.textContent).toContain("A synthetic wholesale inquiry");
    await fill('textarea[name="template"]', "Hello {{name}}");
    await fill('textarea[name="variables"]', "[]");
    await submit("Save reply");
    expect(container.textContent).toContain(
      "Use a JSON object with text or number values.",
    );
    expect(writes()).toHaveLength(0);
  });

  it("shows a quiet empty state for an empty filtered inbox", async () => {
    emptyInbox = true;
    await mount("inbox", "/inbox?status=pending");
    expect(container.textContent).toContain("No requests match these filters.");
    expect(container.querySelectorAll(".shop-inbox-row")).toHaveLength(0);
    expect(byText("Clear filters")).toBeDefined();
  });

  it("shows immediate loading feedback, then the requested record", async () => {
    let release!: () => void;
    holdRead = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await render("request");
    expect(
      container.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Loading request");
    holdRead = undefined;
    await act(async () => {
      release();
    });
    await settle(() =>
      expect(container.textContent).toContain(request.subject),
    );
  });

  it("recovers from a failed initial read through the visible retry control", async () => {
    failure = "get-request";
    await render("request");
    await settle(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "This view couldn’t be loaded.",
      ),
    );
    failure = undefined;
    await click(byText("Try again"));
    await settle(() =>
      expect(container.textContent).toContain(request.subject),
    );
  });
});
