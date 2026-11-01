import type { ActionRunContext } from "@agent-native/core/action";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";

type Registry = ReturnType<typeof loadActionsFromStaticRegistry>;

async function generatedRegistry(): Promise<Registry> {
  // Lazy import avoids actions -> composition -> registry -> actions cycles.
  const { default: modules } =
    await import("../../.generated/actions-registry.js");
  return loadActionsFromStaticRegistry(modules);
}

/** Server invocation only. Recipe approval gates belong to the executor:
 * direct .run() does not enforce the agent-only needsApproval metadata. */
export class RegistryActionInvoker {
  constructor(
    private readonly load: () => Promise<Registry> = generatedRegistry,
  ) {}

  private async action(name: string) {
    const registry = await this.load();
    const action = Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
    if (!action) throw new Error(`Unknown action: ${name}`);
    return action;
  }

  async describe(name: string): Promise<{ effect: "read" | "mutation" }> {
    const action = await this.action(name);
    // Explicit false wins over GET, matching framework action classification.
    const read = action.readOnly ?? (action.http !== false && action.http?.method === "GET");
    return { effect: read ? "read" : "mutation" };
  }

  async invoke(
    name: string,
    input: unknown,
    context: ActionRunContext,
  ): Promise<unknown> {
    const action = await this.action(name);
    // A fresh context is necessary for nested action identity and its audit row.
    return action.run(input, { ...context, actionName: name });
  }
}
