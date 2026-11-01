import { defineAction } from "@agent-native/core/action";
import { queryAuditEvents } from "@agent-native/core/audit";
import {
  closeDbExec,
  createDbExec,
  withDbExec,
  type DbExec,
} from "@agent-native/core/db";
import {
  emitAsync,
  registerEvent,
  subscribe,
  unsubscribe,
} from "@agent-native/core/event-bus";
import {
  loadActionsFromStaticRegistry,
  loadResourcesForPrompt,
} from "@agent-native/core/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { RegistryActionInvoker } from "./registry-action-invoker";
import { ResourceSkillRegistry } from "./resource-skill-registry";

let database: DbExec;
beforeAll(async () => {
  database = await createDbExec({ url: "pglite:memory://" });
});
afterAll(async () => {
  await closeDbExec();
});

describe("installed Agent-Native mechanisms (offline, isolated PGlite)", () => {
  it("audits the nested mutation under its own name", async () =>
    withDbExec(database, async () => {
      const child = defineAction({
        description: "Child",
        schema: z.object({ id: z.string() }),
        run: async (input) => input,
      });
      const invoker = new RegistryActionInvoker(async () =>
        loadActionsFromStaticRegistry({ child: { default: child } }),
      );
      const parent = defineAction({
        description: "Parent",
        schema: z.object({ id: z.string() }),
        run: async (input, context) => invoker.invoke("child", input, context!),
      });
      await parent.run(
        { id: "ord_1042" },
        {
          caller: "frontend",
          userEmail: "operator@example.test",
          actionName: "parent",
        },
      );
      const events = await queryAuditEvents({
        userEmail: "operator@example.test",
      });
      expect(events.map((event) => event.action).sort()).toEqual([
        "child",
        "parent",
      ]);
      expect(events.find((event) => event.action === "child")).toMatchObject({
        caller: "frontend",
        status: "success",
      });
    }));

  it("awaits a deterministic async subscriber before the action returns", async () => {
    const name = "muscle-memory.test.handled";
    registerEvent({
      name,
      description: "Offline deterministic proof",
      payloadSchema: z.object({ id: z.string() }),
    });
    const handled: unknown[] = [];
    const subscription = subscribe(name, async (payload) => {
      await Promise.resolve();
      handled.push(payload);
    });
    try {
      const action = defineAction({
        description: "Emit",
        audit: { enabled: false },
        schema: z.object({ id: z.string() }),
        run: async (input) => {
          await emitAsync(name, input);
          return { handled: handled.length };
        },
      });
      expect(
        await action.run({ id: "req_0007" }, { caller: "frontend" }),
      ).toEqual({ handled: 1 });
      expect(handled).toEqual([{ id: "req_0007" }]);
      await expect(emitAsync(name, { id: 5 })).rejects.toThrow(
        "Payload validation failed",
      );
      expect(handled).toHaveLength(1);
    } finally {
      unsubscribe(subscription);
    }
  });

  it("propagates handler rejection and unsubscribes cleanly", async () => {
    const name = "muscle-memory.test.failure";
    registerEvent({
      name,
      description: "Failure proof",
      payloadSchema: z.object({}),
    });
    const subscription = subscribe(name, async () => {
      throw new Error("handler failed");
    });
    await expect(emitAsync(name, {})).rejects.toThrow("failed to accept");
    expect(unsubscribe(subscription)).toBe(true);
    await expect(emitAsync(name, {})).resolves.toBeUndefined();
  });

  it("publishes, updates and removes a runtime skill without leaking it to another owner", async () =>
    withDbExec(database, async () => {
      const registry = new ResourceSkillRegistry("operator@example.test");
      const other = new ResourceSkillRegistry("other@example.test");
      await registry.put(
        "proof-skill",
        "Use the deterministic proof",
        "Call hello with name kiln-proof-7.",
      );
      expect(await registry.read("proof-skill")).toContain("scope: runtime");
      expect(await other.read("proof-skill")).toBeNull();
      // Exercise the actual per-turn resource loader, rather than just reading SQL.
      expect(await loadResourcesForPrompt("operator@example.test")).toContain(
        "proof-skill",
      );
      expect(await loadResourcesForPrompt("other@example.test")).not.toContain(
        "proof-skill",
      );
      await registry.put(
        "proof-skill",
        "Updated instructions",
        "Call hello with name kiln-proof-8.",
      );
      expect(await registry.read("proof-skill")).toContain("kiln-proof-8");
      expect(await registry.read("proof-skill")).not.toContain("kiln-proof-7");
      await registry.remove("proof-skill");
      expect(await registry.read("proof-skill")).toBeNull();
      expect(
        await loadResourcesForPrompt("operator@example.test"),
      ).not.toContain("proof-skill");
    }));

  it("rejects empty owners and invalid skill paths before storage", async () => {
    expect(() => new ResourceSkillRegistry(" ")).toThrow("resource owner");
    const registry = new ResourceSkillRegistry("operator@example.test");
    await expect(
      registry.put("../escape", "Description", "Instructions"),
    ).rejects.toThrow("skill name");
    await expect(registry.put("valid", "", "Instructions")).rejects.toThrow(
      "description",
    );
  });
});
