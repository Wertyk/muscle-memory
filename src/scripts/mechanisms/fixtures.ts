// Temporary app fixtures for the opt-in local smoke. Nothing in here is part
// of the deployed action catalog; smoke.ts stages and removes these files.
export const proofFiles: Record<string, string> = {
  "server/infra/task3-proof.ts": `
import { emitAsync, registerEvent, subscribe } from "@agent-native/core/event-bus";
import { z } from "zod";
import { traced } from "./traced";
import { ResourceSkillRegistry } from "./resource-skill-registry";
import { RegistryActionInvoker } from "./registry-action-invoker";
import { queryAuditEvents } from "@agent-native/core/audit";
const states = new Map();
function state(ctx) {
  if (!ctx?.userEmail) throw new Error("Authenticated proof requires an owner");
  if (!states.has(ctx.userEmail)) states.set(ctx.userEmail, { recording: false, steps: [], events: 0 });
  return states.get(ctx.userEmail);
}
registerEvent({ name: "muscle-memory.task3-proof", description: "Temporary deterministic proof", payloadSchema: z.object({ owner: z.string() }) });
const subscription = subscribe("muscle-memory.task3-proof", async ({ owner }) => {
  await Promise.resolve();
  state({ userEmail: owner }).events++;
});
export const mutate = traced("task3-proof-mutate", async (input, ctx) => {
  await emitAsync("muscle-memory.task3-proof", { owner: ctx.userEmail });
  return { label: input.label, eventsHandled: state(ctx).events, actionName: ctx.actionName };
}, { recording: async ctx => state(ctx).recording ? { append: async step => { state(ctx).steps.push(step); } } : null });
export async function control(input, ctx) {
  const current = state(ctx);
  if (input.operation === "on") current.recording = true;
  if (input.operation === "off") current.recording = false;
  if (input.operation === "install-skill") await new ResourceSkillRegistry(ctx.userEmail).put(
    "task3-runtime-proof", "Use the TASK-3 runtime mechanism proof and show its result card.",
    "Call task3-proof-card with label exactly " + input.label + ". Preserve this exact label; do not guess it."
  );
  if (input.operation === "remove-skill") await new ResourceSkillRegistry(ctx.userEmail).remove("task3-runtime-proof");
  return { ...current, audit: (await queryAuditEvents({ userEmail: ctx.userEmail })).filter(e => e.action.startsWith("task3-proof")).map(e => ({ action: e.action, caller: e.caller, status: e.status })) };
}
export async function invoke(input, ctx) { return new RegistryActionInvoker().invoke("task3-proof-mutate", input, ctx); }
`,
  "actions/task3-proof-mutate.ts": `
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { mutate } from "../server/infra/task3-proof";
export default defineAction({ description: "Apply a synthetic TASK-3 mutation", schema: z.object({ label: z.string() }), run: mutate });
`,
  "actions/task3-proof-invoke.ts": `
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { invoke } from "../server/infra/task3-proof";
export default defineAction({ description: "Invoke the synthetic mutation by registry name", schema: z.object({ label: z.string() }), run: invoke });
`,
  "actions/task3-proof-control.ts": `
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { control } from "../server/infra/task3-proof";
export default defineAction({ description: "Control the isolated TASK-3 smoke", agentTool: false, schema: z.object({ operation: z.enum(["on", "off", "status", "install-skill", "remove-skill"]), label: z.string().optional() }), run: control });
`,
  "actions/task3-proof-card.ts": `
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
export default defineAction({
  description: "Show the TASK-3 mechanism result card using the exact runtime skill label.", readOnly: true,
  schema: z.object({ label: z.string() }),
  chatUI: { renderer: "muscle-memory.task3-proof", title: "Mechanism proof" },
  run: async (input, ctx) => ({ label: input.label, actionName: ctx.actionName }),
});
`,
};
