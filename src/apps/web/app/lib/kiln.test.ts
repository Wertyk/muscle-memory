import { describe, expect, it } from "vitest";
import type { RequestProcessing } from "@shared/request-processing";
import { inboxOutcome, intakeSummary, isRecipeOutcome, newArrivalIds, waterfallKind, waterfallPercent } from "./kiln";

const row = (id: string, state: RequestProcessing["state"], completed = false): RequestProcessing => ({
  requestId: id as RequestProcessing["requestId"], runId: "run_1", state, matchReason: "matched", tokens: { input: 12, output: 8 },
  recipe: { name: "Bowl care", version: 2 }, runStatus: completed ? "completed" : state === "with_agent" ? "handed_off" : "awaiting_approval",
  mode: "execute", totalTokens: completed ? 20 : null, durationMs: completed ? 17 : null,
});

describe("measured inbox outcomes", () => {
  it("recognises completed recipes even after their shop request is resolved", () => {
    expect(inboxOutcome(row("req_1", "done", true))).toBe("recipe");
    expect(inboxOutcome(row("req_2", "auto_handled", true))).toBe("recipe");
    expect(inboxOutcome(row("req_3", "awaiting_approval"))).toBe("approval");
    expect(inboxOutcome(row("req_4", "with_agent"))).toBe("agent");
    expect(inboxOutcome(row("req_5", "done"))).toBe("other");
    expect(inboxOutcome({ ...row("req_6", "done", true), mode: "dry-run" })).toBe("other");
  });
  it("summarises the returned IDs from real processing, never from script positions", () => {
    const rows = [row("req_1", "auto_handled", true), row("req_2", "done", true), row("req_3", "done", true), row("req_4", "awaiting_approval"), row("req_5", "with_agent")];
    expect(intakeSummary(rows.map(r => r.requestId), rows)).toBe("5 arrived · 3 handled by recipes · 1 awaiting approval · 1 with agent");
    expect(intakeSummary(["req_5", "req_5"], rows)).toBe("1 arrived · 1 with agent");
    expect(intakeSummary(["req_unknown"], rows)).toBe("1 arrived · 1 still processing");
    expect(intakeSummary([], rows)).toBe("0 arrived");
    expect(intakeSummary(["req_1", "req_4", "req_5", "req_unknown"], rows)).toBe("4 arrived · 1 handled by recipes · 1 awaiting approval · 1 with agent · 1 still processing");
  });
  it("does not replay old rows, refetches, duplicates or filtered rows later shown", () => {
    expect(newArrivalIds(["req_1"], ["req_1", "req_2", "req_2", "req_3"])).toEqual(["req_2", "req_3"]);
    expect(newArrivalIds(["req_1"], ["req_2", "req_3"], ["req_2", "req_3"])).toEqual([]);
    expect(newArrivalIds(["req_1", "req_2"], ["req_1", "req_2"])).toEqual([]);
    expect(newArrivalIds([], ["req_2"], ["req_2"])).toEqual([]);
  });
});

describe("recipe marks and waterfall evidence", () => {
  it("marks only completed live runs", () => {
    const outcome = { status: "completed", mode: "execute", recipeName: "Bowl care", version: 2, tokens: 20 };
    expect(isRecipeOutcome(outcome)).toBe(true);
    for (const status of ["running", "awaiting_approval", "handed_off", "aborted", "failed"])
      expect(isRecipeOutcome({ ...outcome, status })).toBe(false);
    expect(isRecipeOutcome({ ...outcome, mode: "dry-run" })).toBe(false);
  });
  it("scales against total active run time and bounds invalid measurements", () => {
    expect(waterfallPercent(12, 48)).toBe(25);
    expect(waterfallPercent(48, 48)).toBe(100);
    expect(waterfallPercent(60, 48)).toBe(100);
    expect(waterfallPercent(0, 0)).toBe(0);
    expect(waterfallPercent(-1, 48)).toBe(0);
    expect(waterfallPercent(NaN, 48)).toBe(0);
    expect(waterfallPercent(1, Infinity)).toBe(0);
  });
  it("gives approval gates precedence and distinguishes reads from effects", () => {
    expect(waterfallKind({ kind: "action", effect: "mutation", approvalRequired: true })).toBe("approval");
    expect(waterfallKind({ kind: "action", effect: "read", approvalRequired: false })).toBe("lookup");
    expect(waterfallKind({ kind: "handoff", effect: null, approvalRequired: false })).toBe("handoff");
  });
});
