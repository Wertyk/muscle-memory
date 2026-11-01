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

  async invoke(
    name: string,
    input: unknown,
    context: ActionRunContext,
  ): Promise<unknown> {
    const registry = await this.load();
    const action = Object.prototype.hasOwnProperty.call(registry, name)
      ? registry[name]
      : undefined;
    if (!action) throw new Error(`Unknown action: ${name}`);
    // A fresh context is necessary for nested action identity and its audit row.
    return action.run(input, { ...context, actionName: name });
  }
}
