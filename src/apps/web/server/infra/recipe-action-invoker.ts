import { isActionContractError, type ActionRunContext } from "@agent-native/core/action";
import type { ActionInvoker, JsonObject, JsonValue } from "@muscle-memory/recipe-engine";
import { isRecipeJson } from "./recipe-json.js";
import { RegistryActionInvoker } from "./registry-action-invoker.js";

export class RecipeActionInvoker implements ActionInvoker {
  constructor(
    private readonly registry: RegistryActionInvoker,
    private readonly context: ActionRunContext = { caller: "automation" },
  ) {}

  describe(name: string) { return this.registry.describe(name); }

  async invoke(name: string, input: JsonObject, invocation: Parameters<ActionInvoker["invoke"]>[2]): Promise<JsonValue> {
    let output: unknown;
    try {
      // Do not carry an enclosing agent's approval key into a recipe step.
      const { approvedToolCallKey: _approval, ...context } = this.context;
      output = await this.registry.invoke(name, input, {
        ...context, actionName: name, runId: invocation.runId,
        toolCallId: invocation.idempotencyKey,
      });
    } catch (error) {
      // Contract codes are useful for reconciliation; provider/internal details
      // and customer data from thrown messages must not leak into run failures.
      throw new Error(isActionContractError(error)
        ? `Action ${name} failed (${error.errorCode}).`
        : `Action ${name} failed.`);
    }
    if (!isRecipeJson(output)) throw new Error(`Action ${name} returned invalid JSON.`);
    if (output !== null && typeof output === "object" && !Array.isArray(output)) {
      const result = output as JsonObject;
      if (result.isError === true || result.ok === false || result.success === false ||
        Object.prototype.hasOwnProperty.call(result, "error")) {
        throw new Error(`Action ${name} returned an unsuccessful result.`);
      }
    }
    return structuredClone(output);
  }
}
