// @vitest-environment happy-dom
import type { Correction } from "@muscle-memory/shop-domain";
import type { Run } from "@muscle-memory/recipe-engine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import enUS from "@/i18n/en-US";
import { RequestPage } from "../shop/RequestPage";
import { RunTimeline } from "../runs/RunParts";
import { CorrectionsPanel } from "./CorrectionsPanel";
import { createShopDemoData } from "../../../server/db/shop-demo-data";
import { damagedItemFixture } from "../../../server/fixtures/intake-recipes";

const mocks = vi.hoisted(() => ({ send: vi.fn(), mutate: vi.fn(), query: vi.fn() }));
vi.mock("@agent-native/core/client/agent-chat", () => ({ sendToAgentChat: mocks.send }));
vi.mock("@agent-native/core/client/hooks", () => ({
  useActionQuery: mocks.query, useActionMutation: () => ({ mutateAsync: mocks.mutate }), useDbSync: () => {}, actionErrorMessage: (e: Error) => e.message,
}));
vi.mock("@agent-native/toolkit/app/chat", () => ({ AgentToggleButton: () => <button>Agent sidebar</button>, registerActionChatRenderer: vi.fn() }));
vi.mock("@agent-native/core/client/i18n", () => ({ useT: () => (key: string, values: Record<string, unknown> = {}) => {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUS);
  return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""));
} }));
const correction: Correction = {
  id: "cor_ui", owner: { userId: "operator@example.test", workspaceId: "personal" }, requestId: "req_0001", runId: "run_ui",
  recipe: { id: damagedItemFixture.id, recipeId: damagedItemFixture.recipeId, version: 1 }, stepId: "reply", action: "send-reply",
  originalInput: { template: "Half of its price" }, originalOutput: { body: "Half of its price" },
  input: { requestId: "req_0001", template: "Keep the piece" }, output: { body: "Keep the piece" }, createdAt: 1000, status: "recorded", proposal: null, decision: null,
};
let root: Root;
let node: HTMLDivElement;
async function render(ui: React.ReactNode) {
  node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); node?.remove(); vi.clearAllMocks(); });
describe("visible operational corrections", () => {
  it("appears on the request and in the exact run timeline, and sends typed evidence to the shared agent", async () => {
    const data = createShopDemoData();
    mocks.query.mockImplementation((name: string) => ({ data: name === "get-request" ? { ...data.requests[0], corrections: [correction] }
      : name === "get-customer" ? data.customers[0] : name === "get-demonstration" ? null : name === "get-order" ? data.orders[0]
      : name === "get-shipment-status" ? { shipment: null } : [], isPending: false, isError: false, refetch: vi.fn() }));
    const run: Run = { id: "run_ui", recipe: damagedItemFixture, trigger: { requestId: "req_0001" }, mode: "execute", status: "completed", createdAt: 1, updatedAt: 1000, steps: [], pendingStepIds: [], approvedStepIds: [], awaitingApprovalStepId: null, tokens: { input: 0, output: 0 }, failure: null, handoff: null };
    await render(<><RequestPage requestId="req_0001" /><RunTimeline run={{ ...run, corrections: [correction] }} /></>);
    expect(node.querySelectorAll("[data-correction]")).toHaveLength(2);
    const buttons = [...node.querySelectorAll("button")].filter(button => button.textContent === "Propose recipe update");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]!.click());
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ submit: true, openSidebar: true }));
    expect(JSON.parse(mocks.send.mock.calls[0]![0].context)).toMatchObject({ workflow: "correct-recipe", correction: { id: "cor_ui", runId: "run_ui", stepId: "reply", input: correction.input } });
    expect(node.textContent).toContain("Correction recorded");
  });
  it.each(["accepted", "rejected"] as const)("shows the durable %s outcome instead of proposing again", async status => {
    await render(<CorrectionsPanel corrections={[{ ...correction, status, proposal: { version: { ...correction.recipe, id: "ver_2", version: 2 }, notes: {} }, decision: { at: 1200, by: correction.owner, reason: status === "rejected" ? "Keep existing policy" : null } }]} />);
    expect(node.textContent).toContain(status === "accepted" ? "Accepted → version 2" : "Rejected → Keep existing policy");
    expect(node.textContent).not.toContain("Propose recipe update");
    expect(node.textContent).not.toContain("Review diff and activate in Studio");
    expect(node.querySelector("a")?.textContent).toBe("View version 2 in Studio");
    expect(node.textContent).not.toContain("Reject proposal");
    expect(node.querySelector("a")?.getAttribute("href")).toContain("ver_2");
  });
  it("records rejection through the shared action with a required reason and immediate pending feedback", async () => {
    const proposed: Correction = { ...correction, status: "proposed", proposal: { version: { ...correction.recipe, id: "ver_2", version: 2 }, notes: {} } };
    await render(<CorrectionsPanel corrections={[proposed]} />);
    expect(node.querySelector("a")?.textContent).toBe("Review diff and activate in Studio");
    const input = node.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Keep existing policy");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.mutate).toHaveBeenCalledWith({ correctionId: "cor_ui", decision: "rejected", reason: "Keep existing policy" });
  });
  it("renders no correction affordance before a correction exists", async () => {
    await render(<CorrectionsPanel />); expect(node.textContent).toBe("");
  });
});

it("renders correction proposals with the existing Studio history diff inside the proposal card", async () => {
  const { RecipeProposalCard } = await import("./RecipeProposalCard");
  const version = structuredClone({ ...damagedItemFixture, id: "ver_diff", version: 2 });
  const reply = (version.steps[1] as any).then[1];
  const before = reply.args.template.value;
  reply.args.template.value += " Please keep the piece; no return needed.";
  mocks.query.mockReturnValue({ data: { history: [
    { version: damagedItemFixture, diff: [] },
    { version, diff: [{ path: "/steps/1/then/1/args/template/value", historical: before, intended: reply.args.template.value }] },
  ] }, isError: false });
  await render(<RecipeProposalCard context={{ toolName: "save-recipe-version", args: {}, isRunning: false, status: "completed", resultJson: { version, correctionId: correction.id } }} />);
  expect(node.querySelector(".recipe-diff")).not.toBeNull();
  expect(node.querySelector("ins")?.textContent).toContain("Please keep the piece; no return needed.");
  expect(node.querySelector("a")?.getAttribute("href")).toContain("#version-ver_diff");
});
