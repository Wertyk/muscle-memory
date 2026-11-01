import { defineAction } from "@agent-native/core/action";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RegistryActionInvoker } from "./registry-action-invoker";

describe("RegistryActionInvoker", () => {
  it("runs a registered action with its own identity and preserves caller context", async () => {
    const run = vi.fn(async (input, context) => ({ input, context }));
    const callee = defineAction({
      description: "Callee",
      audit: { enabled: false },
      schema: z.object({ id: z.string() }),
      run,
    });
    const load = vi.fn(async () =>
      loadActionsFromStaticRegistry({ callee: { default: callee } }),
    );
    const invoker = new RegistryActionInvoker(load);
    const context = {
      caller: "frontend" as const,
      userEmail: "operator@example.test",
      actionName: "parent",
      threadId: "thread_7",
    };
    const result = await invoker.invoke("callee", { id: "ord_1042" }, context);
    expect(result).toEqual({
      input: { id: "ord_1042" },
      context: { ...context, actionName: "callee" },
    });
    expect(context.actionName).toBe("parent");
    expect(load).toHaveBeenCalledOnce();
  });

  it("preserves framework schema validation and rejects missing or inherited names", async () => {
    const run = vi.fn();
    const callee = defineAction({
      description: "Callee",
      audit: { enabled: false },
      schema: z.object({ id: z.string() }),
      run,
    });
    const invoker = new RegistryActionInvoker(async () =>
      loadActionsFromStaticRegistry({ callee: { default: callee } }),
    );
    const context = { caller: "cli" as const };
    await expect(
      invoker.invoke("callee", { id: 12 }, context),
    ).rejects.toThrow();
    await expect(invoker.invoke("missing", {}, context)).rejects.toThrow(
      "Unknown action: missing",
    );
    await expect(invoker.invoke("toString", {}, context)).rejects.toThrow(
      "Unknown action: toString",
    );
    expect(run).not.toHaveBeenCalled();
  });
});
