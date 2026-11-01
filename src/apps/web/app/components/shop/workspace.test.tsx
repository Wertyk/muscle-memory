import { useDbSync } from "@agent-native/core/client/hooks";
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
import { InboxPage } from "./InboxPage";
import { RequestPage } from "./RequestPage";

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
let calls: { name: string; input: Record<string, unknown>; method: string }[];

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
  useDbSync({ queryClient: client });
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
      switch (name) {
        case "get-request":
          return Response.json(request);
        case "get-request-activity": {
          const result = await new GetRequestActivity({
            getRequestActivityRecords: async () => ({
              request,
              order: request.orderId ? order : null,
              shipment: null,
              replies: savedReplies,
              refunds: savedRefunds,
              replacements: savedReplacements,
            }),
          }).execute({ requestId: request.id });
          return Response.json(result.ok ? result.value : []);
        }
        case "get-order":
          return Response.json(order);
        case "get-customer":
          return Response.json(
            fixtures.customers.find((item) => item.id === input.customerId),
          );
        case "get-shipment-status":
          return Response.json({
            orderStatus: order.status,
            shipment:
              fixtures.shipments.find((item) => item.orderId === order.id) ??
              null,
          });
        case "list-requests":
          return Response.json(
            emptyInbox
              ? []
              : fixtures.requests.filter(
                  (item) =>
                    (!input.status || item.status === input.status) &&
                    (!input.type ||
                      (item.content.source === "structured"
                        ? item.content.fields.type
                        : item.content.type) === input.type),
                ),
          );
        case "set-request-status":
          request = {
            ...request,
            status: input.status,
            updatedAt: "2026-11-02T14:00:00Z",
          };
          return Response.json(request);
        case "tag-request":
          request = { ...request, tags: [...request.tags, input.tag] };
          return Response.json(request);
        case "escalate":
          request = {
            ...request,
            status: "escalated",
            escalation: {
              reason: input.reason,
              escalatedAt: "2026-11-02T14:00:00Z",
            },
          };
          return Response.json(request);
        case "send-reply": {
          const reply = {
            ...fixtures.replies[0]!,
            id: `rpl_${savedReplies.length}` as const,
            requestId: request.id,
            body: input.template,
          };
          savedReplies.push(reply);
          return Response.json(reply);
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
          return Response.json(refund);
        }
        case "create-replacement-order": {
          const replacement: Order = { ...order, id: "ord_replacement" };
          savedReplacements.push(replacement);
          return Response.json(replacement);
        }
        case "update-shipping-address":
          order = { ...order, shippingAddress: input.address };
          return Response.json(order);
        case "generate-return-label": {
          const label = {
            id: "lbl_test",
            orderId: order.id,
            createdAt: "2026-11-02T14:00:00Z",
            fromAddress: order.shippingAddress,
          } as const;
          order = { ...order, returnLabel: label };
          return Response.json(label);
        }
        default:
          return Response.json({});
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
  it("handles a request manually: saves reply, tags and resolves, refreshing the visible status", async () => {
    await mount();
    expect(container.textContent).toContain(request.subject);
    const product = container.querySelector(".shop-form-fields dd");
    expect(product).not.toBeNull();
    expect(
      container.querySelector(".shop-original-message")?.textContent,
    ).toContain(order.items[0]!.name);
    expect(
      container.querySelector('[data-teach-slot="reserved"] button'),
    ).toBeNull();
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
