// @vitest-environment happy-dom
/* oxlint-disable unicorn/no-thenable -- Recipe branches contain a non-callable then step array. */
import type { JsonValue, Run, StepRun } from "@muscle-memory/recipe-engine";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";
import { canReplay, initialReplayState, replayPhases, replaySteps, replayWorkspace, savedReply, transitionReplay, type ReplayState } from "@/lib/ghost-replay";

import { ReplayButton } from "./GhostReplay";

const actions = vi.hoisted(() => ({ mutationHook: vi.fn(), queryHook: vi.fn(), call: vi.fn() }));
vi.mock("@agent-native/core/client/hooks", () => ({
  useActionMutation: actions.mutationHook,
  useActionQuery: actions.queryHook,
  callAction: actions.call,
}));
function translate(key: string, values: Record<string, string | number> = {}) {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUS);
  return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""));
}
vi.mock("@agent-native/core/client/i18n", () => ({ useT: () => translate }));

function checkpoint(): Run {
  const step = (stepId: string, action: string, input: JsonValue, output: JsonValue): StepRun => ({
    stepId, kind: "action", action, effect: action.startsWith("get-") ? "read" : "mutation", attempt: 1, status: "completed", approvalRequired: false,
    input, output, startedAt: 1, finishedAt: 2, durationMs: 1, tokens: { input: 0, output: 0 }, error: null, blockedBy: [],
  });
  return {
    id: "run_replay", mode: "execute", status: "completed", createdAt: 1, updatedAt: 5, pendingStepIds: [], approvedStepIds: [], awaitingApprovalStepId: null,
    tokens: { input: 0, output: 0 }, failure: null, handoff: null,
    trigger: { requestId: "req_0006", orderId: "ord_1006", subject: "Broken serving platter" },
    recipe: {
      id: "ver_replay", recipeId: "recipe_replay", version: 1, name: "Damaged platter", trigger: { event: "request.created", match: true },
      steps: [
        { id: "order", kind: "action", action: "get-order", args: { orderId: { mode: "path", path: "trigger.orderId" } } },
        { id: "branch", kind: "branch", condition: true, then: [
          { id: "refund", kind: "action", action: "issue-refund", args: { orderId: { mode: "path", path: "trigger.orderId" }, amount: {
            amountMinor: { mode: "expr", expr: { "*": [0.5, { var: "steps.order.output.items[0].unitPrice.amountMinor" }] } }, currency: { mode: "fixed", value: "USD" },
          }, reason: { mode: "fixed", value: "Damaged platter" } } },
        ], else: [{ id: "unused", kind: "action", action: "escalate", args: {} }] },
        { id: "reply", kind: "action", action: "send-reply", args: { template: { mode: "template", template: "Refunded {{steps.refund.output.amount}}." } } },
        { id: "tag", kind: "action", action: "tag-request", args: { tag: { mode: "fixed", value: "refunded" } } },
      ],
    },
    steps: [
      step("order", "get-order", { orderId: "ord_1006" }, { id: "ord_1006", items: [{ productId: "prd_0006", name: "Serving platter", quantity: 1, unitPrice: { amountMinor: 4400, currency: "USD" } }] }),
      step("refund", "issue-refund", { orderId: "ord_1006", reason: "Damaged platter", amount: { amountMinor: 2200, currency: "USD" } }, { id: "ref_0006", amount: { amountMinor: 2200, currency: "USD" } }),
      step("reply", "send-reply", { requestId: "req_0006", template: "Refunded {{amount}}.", variables: { amount: "$22.00" } }, { id: "reply_0006", body: "Refunded $22.00." }),
      step("tag", "tag-request", { requestId: "req_0006", tag: "refunded" }, { id: "req_0006", tags: ["refunded"] }),
    ],
  };
}

describe("checkpoint replay model", () => {
  it("maps refund/menu/dialog, reply and tag to controls, with caption fallbacks", () => {
    const run = checkpoint();
    const steps = replaySteps(run, translate);
    expect(steps.map((step) => step.phases.map((phase) => phase.target))).toEqual([
      [null], ["order-actions", "order-operation", "order-preview"], ["reply-composer"], ["add-tag", "tag-input"],
    ]);
    expect(steps[0]?.caption).toBe("Looked up order ord_1006");
    expect(steps[1]?.values.find((value) => value.path === "amount")).toMatchObject({ label: "Refund amount", value: "$22.00", source: expect.stringContaining("50%") });
    expect(steps.map((step) => step.saved.stepId)).not.toContain("unused");
    const unknown = { ...run.steps[0]!, action: "future-shop-operation", effect: "mutation" as const };
    const fallback = replaySteps({ ...run, steps: [unknown] }, translate)[0]!;
    expect(fallback.phases[0]?.target).toBeNull();
    expect(fallback.caption).toBe("Recorded: Future shop operation");
    expect(replayPhases({ ...unknown, kind: "extract", action: null })).toEqual([{ target: null, view: "workspace" }]);
    for (const action of ["create-replacement-order", "update-shipping-address", "generate-return-label"]) expect(replayPhases({ ...unknown, action })[2]?.target).toBe("order-preview");
    for (const action of ["set-request-status", "escalate"]) expect(replayPhases({ ...unknown, action })[0]?.target).toBe("request-status");
  });

  it("does not evaluate bindings, recalculate refunds, or reconstruct reply outputs", () => {
    const run = checkpoint();
    // The checkpoint may disagree with a formula: saved values win.
    const changed = { ...run, steps: run.steps.map((step) => step.action === "issue-refund" ? { ...step, input: { amount: { amountMinor: 1700, currency: "EUR" } } } : step) };
    expect(replaySteps(changed, translate)[1]?.values[0]?.value).toBe("€17.00");
    expect(savedReply(run.steps[2]!)).toBe("Refunded $22.00.");
    expect(savedReply({ ...run.steps[2]!, output: null })).toBe("Refunded {{amount}}.");
  });

  it("uses only historical snapshots reached in playback and excludes unfinished attempts", () => {
    const run = checkpoint();
    const read = { ...run.steps[0]!, stepId: "request", action: "get-request", input: { requestId: "req_0006" }, output: { subject: "Saved subject" } };
    const withRead = { ...run, steps: [...run.steps, read] };
    expect(replayWorkspace(withRead, withRead.steps[0]!).request).toBeUndefined();
    expect(replayWorkspace(withRead, read).request?.subject).toBe("Saved subject");
    expect(replayWorkspace(run, run.steps[1]!).order?.id).toBe("ord_1006");
    const retried = { ...run, steps: [{ ...run.steps[0]!, status: "failed" as const }, { ...run.steps[0]!, attempt: 2 }, ...run.steps.slice(1)] };
    expect(replaySteps(retried, translate)).toHaveLength(4);
    for (const status of ["running", "awaiting_approval", "failed", "aborted", "handed_off"] as const) expect(canReplay({ ...run, status })).toBe(false);
    expect(canReplay({ ...run, mode: "dry-run" })).toBe(false);
    expect(canReplay({ ...run, steps: [] })).toBe(false);
  });

  it("plays phases, pauses, steps in both directions, ends, restarts and exits", () => {
    const steps = replaySteps(checkpoint(), translate);
    let state: ReplayState = { ...initialReplayState };
    const send = (event: Parameters<typeof transitionReplay>[1]) => state = transitionReplay(state, event, steps);
    send("tick");
    expect(state).toEqual({ status: "playing", index: 1, phase: 0 });
    send("tick");
    expect(state.phase).toBe(1);
    send("pause");
    send("tick");
    expect(state).toEqual({ status: "paused", index: 1, phase: 1 });
    send("next");
    expect(state).toEqual({ status: "paused", index: 2, phase: 0 });
    send("previous");
    expect(state).toEqual({ status: "paused", index: 1, phase: 2 });
    send("play");
    for (let i = 0; i < 6; i++) send("tick");
    expect(state.status).toBe("ended");
    expect(state.index).toBe(3);
    send("play");
    expect(state).toEqual(initialReplayState);
    send("previous");
    expect(state.index).toBe(0);
    send("exit");
    send("play");
    expect(state.status).toBe("closed");
    expect(transitionReplay(initialReplayState, "tick", []).status).toBe("ended");
  });

  it("skips visual phases in reduced motion", () => {
    const steps = replaySteps(checkpoint(), translate);
    expect(transitionReplay({ status: "playing", index: 1, phase: 0 }, "tick", steps, true)).toEqual({ status: "playing", index: 2, phase: 0 });
  });
});

let root: Root;
let host: HTMLDivElement;
let media: EventTarget & { matches: boolean };
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => (item.getAttribute("aria-label") ?? item.textContent) === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function mount(run = checkpoint()) {
  await act(async () => root.render(<ReplayButton run={run} />));
}
async function open() { await mount(); await click("Replay"); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Replay must not fetch or mutate"); }));
  for (const spy of Object.values(actions)) spy.mockReset().mockImplementation(() => { throw new Error("Replay must not mount action hooks or call actions"); });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("read-only ghost playback", () => {
  it("plays the menu and refund preview, pauses, and steps through saved reply/tag values without actions", async () => {
    await open();
    expect(document.body.textContent).toContain("Looked up order ord_1006");
    await advance(1600);
    expect(document.querySelector('[data-replay-target="order-actions"]')?.getAttribute("data-active")).toBe("true");
    await advance(1600);
    expect(document.querySelector('[data-replay-target="order-operation"]')?.getAttribute("data-active")).toBe("true");
    await advance(2400);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Refund amount"]')?.value).toBe("$22.00");
    expect(document.querySelector('[data-replay-target="order-preview"]')?.getAttribute("data-active")).toBe("true");
    expect(document.body.textContent).toContain("50%");
    await click("Pause");
    await advance(20_000);
    expect(document.body.textContent).toContain("Step 2 of 4");
    await click("Step forward");
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to customer"]')?.value).toBe("Refunded $22.00.");
    await click("Step forward");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')?.value).toBe("refunded");
    const workspace = document.querySelector(".ghost-workspace")!;
    expect(workspace.querySelector("form")).toBeNull();
    expect(workspace.querySelector("a")).toBeNull();
    for (const control of workspace.querySelectorAll<HTMLInputElement>("input,textarea,button")) {
      expect(control.disabled).toBe(true);
      await act(async () => control.click());
      if (control.tagName !== "BUTTON") expect(control.readOnly).toBe(true);
    }
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    await act(async () => workspace.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    await click("Step back");
    expect(document.body.textContent).toContain("Step 3 of 4");
    await click("Play");
    for (let i = 0; i < 6; i++) await advance(2400);
    expect(document.body.textContent).toContain("Replay complete");
    expect(button("Step forward").disabled).toBe(true);
    await click("Play again");
    expect(document.body.textContent).toContain("Step 1 of 4");
    await click("Exit replay");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await advance(50_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(actions.mutationHook).not.toHaveBeenCalled();
    expect(actions.queryHook).not.toHaveBeenCalled();
    expect(actions.call).not.toHaveBeenCalled();
  });

  it("freezes its checkpoint across parent updates and reopens from the beginning", async () => {
    await open();
    await click("Pause");
    await click("Step forward");
    const changed = checkpoint();
    await mount({ ...changed, steps: changed.steps.map((step) => ({ ...step, input: { amount: { amountMinor: 9999, currency: "USD" } } })) });
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Refund amount"]')?.value).toBe("$22.00");
    await click("Exit replay");
    await mount();
    await click("Replay");
    expect(document.body.textContent).toContain("Step 1 of 4");
  });

  it("uses captions only in reduced motion, reacts to preference changes, and cleans up", async () => {
    media.matches = true;
    const remove = vi.spyOn(media, "removeEventListener");
    await open();
    expect(document.querySelector(".ghost-workspace")).toBeNull();
    expect(document.querySelector(".ghost-cursor")).toBeNull();
    expect(document.body.textContent).toContain("Reduced motion · Step captions only");
    await advance(1600);
    expect(document.body.textContent).toContain("Step 2 of 4");
    await advance(1600);
    expect(document.body.textContent).toContain("Step 3 of 4");
    await act(async () => { media.matches = false; media.dispatchEvent(new Event("change")); });
    expect(document.querySelector(".ghost-workspace")).not.toBeNull();
    await act(async () => { media.matches = true; media.dispatchEvent(new Event("change")); });
    expect(document.querySelector(".ghost-workspace")).toBeNull();
    await click("Exit replay");
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
    await advance(50_000);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not offer playback of dry runs, empty or unfinished runs", async () => {
    for (const run of [{ ...checkpoint(), status: "awaiting_approval" as const }, { ...checkpoint(), mode: "dry-run" as const }, { ...checkpoint(), steps: [] }]) {
      await mount(run);
      expect(host.querySelector("button")).toBeNull();
    }
  });
});
