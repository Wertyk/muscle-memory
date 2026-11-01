import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RecipeActionInvoker } from "./recipe-action-invoker.js";
import { RegistryActionInvoker } from "./registry-action-invoker.js";

const invocation = { runId: "run_1", stepId: "read", idempotencyKey: "run_1:read" };
function adapter(output: unknown, metadata: { readOnly?: boolean; http?: false | { method: "GET" } } = {}) {
  const run = vi.fn(async () => output);
  const action = defineAction({ description: "Test", audit: { enabled: false }, schema: z.object({}), ...metadata, run });
  return { run, invoker: new RecipeActionInvoker(new RegistryActionInvoker(async () =>
    loadActionsFromStaticRegistry({ test: { default: action } }))) };
}

describe("recipe registry boundary", () => {
  it.each([
    [{ readOnly: true }, "read"], [{ http: { method: "GET" as const } }, "read"],
    [{ readOnly: false, http: { method: "GET" as const } }, "mutation"],
    [{}, "mutation"], [{ http: false as const }, "mutation"],
  ])("classifies from the installed action metadata: %j", async (metadata, effect) => {
    expect(await adapter({}, metadata).invoker.describe("test")).toEqual({ effect });
  });

  it("rejects unknown and inherited names before dry-run can trust their effect", async () => {
    const { invoker, run } = adapter({});
    for (const name of ["missing", "toString", "__proto__"]) {
      await expect(invoker.describe(name)).rejects.toThrow("Unknown action");
      await expect(invoker.invoke(name, {}, invocation)).rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("sets a fresh identity and stable invocation metadata without mutating parent context", async () => {
    const run = vi.fn(async (_input, context) => ({ name: context.actionName, runId: context.runId, key: context.toolCallId, approved: context.approvedToolCallKey ?? null }));
    const action = defineAction({ description: "Read", audit: { enabled: false }, readOnly: true, schema: z.object({}), run });
    const context = { caller: "frontend" as const, actionName: "parent", approvedToolCallKey: "parent-approval" };
    const invoker = new RecipeActionInvoker(new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({ read: { default: action } })), context);
    expect(await invoker.invoke("read", {}, invocation)).toEqual({ name: "read", runId: "run_1", key: "run_1:read", approved: null });
    expect(context.actionName).toBe("parent");
  });

  it.each([{ ok: false }, { success: false }, { isError: true }, { error: "private" }])("normalizes unsuccessful results %j", async (output) => {
    await expect(adapter(output).invoker.invoke("test", {}, invocation)).rejects.toThrow("unsuccessful result");
  });

  it.each([undefined, Number.POSITIVE_INFINITY, new Date(), { value: undefined }])("rejects non-JSON results", async (output) => {
    await expect(adapter(output).invoker.invoke("test", {}, invocation)).rejects.toThrow("invalid JSON");
  });

  it("preserves contract error codes while sanitizing private exception details", async () => {
    const errors = defineActionErrors("POLICY");
    const action = defineAction({ description: "Policy", schema: z.object({}), audit: { enabled: false }, errors,
      run: () => errors.noWrite("private policy input", "POLICY") });
    const invoker = new RecipeActionInvoker(new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({ test: { default: action } })));
    await expect(invoker.invoke("test", {}, invocation)).rejects.toThrow("Action test failed (POLICY).");
  });
});
