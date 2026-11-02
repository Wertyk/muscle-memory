import { recordChange } from "@agent-native/core/server";
import type { Demonstrations, DemonstrationScope, JsonObject } from "@muscle-memory/recipe-engine";
import type { ActionRunContext } from "@agent-native/core/action";

import { isShopLookup } from "../../shared/shop-action-kinds.js";
import { isRecipeJson } from "./recipe-json.js";
import { demonstrationScope, isAgentTool, teachNavigation } from "./teach-session.js";
import type { TraceCapture } from "./traced.js";

/** A read-only shop action mutates the demonstration, so publish that resource
 * through the framework's shared transport. Shop observers declare their own
 * resource to avoid refetch/capture loops. There is no feature EventSource. */
function changed(owner: string) {
  recordChange({
    source: "action",
    type: "updated",
    key: "get-demonstration",
    resourceType: "demonstrations",
    owner,
  });
}
export function createShopTraceCapture(
  getDemonstrations: () => Demonstrations,
  agentSession?: (context: ActionRunContext, action: { input: unknown }) => Promise<{ scope: DemonstrationScope; navigation: { view: string; requestId: string; path: string } } | null>,
): TraceCapture {
  return {
    async recording(context, action) {
      // Deterministic runs and intake must never become operator demonstrations.
      if (
        action.actionName === "create-request" ||
        !context ||
        !["frontend", "tool"].includes(context.caller) ||
        (context.runId &&
          (context.caller !== "tool" ||
            context.toolCallId?.startsWith(`${context.runId}:`)))
      )
        return null;
      const agent = isAgentTool(context);
      const session = agent ? await agentSession?.(context, action).catch(() => null) : null;
      if (agent && !session) return null;
      const scope = session?.scope ?? demonstrationScope(context);
      if (!scope) return null;
      const navigation = session?.navigation ?? await teachNavigation();
      if (
        navigation?.view !== "request" ||
        typeof navigation.requestId !== "string"
      )
        return null;
      const input = action.input as Record<string, unknown>;
      const references = Object.fromEntries(
        ["requestId", "orderId", "customerId"].flatMap((key) =>
          typeof input[key] === "string" ? [[key, input[key] as string]] : [],
        ),
      );
      const read = isShopLookup(action.actionName);
      const readInput = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      const demos = getDemonstrations();
      let ticket;
      try {
        ticket = await demos.begin({
          scope,
          subjectId: navigation.requestId,
          references,
          ...(read && isRecipeJson(readInput)
            ? {
                read: {
                  action: action.actionName,
                  input: readInput as JsonObject,
                },
              }
            : {}),
        });
      } catch {
        // Reservation failure occurs before the shop action. Halt any active demo;
        // the operator can still do the work. Never retry the shop callback.
        const active = await demos
          .current(scope, navigation.requestId)
          .catch(() => null);
        if (active?.status === "recording")
          await demos
            .incomplete(
              scope,
              active.id,
              "Capture could not start. Subsequent shop actions were not recorded.",
            )
            .catch(() => undefined);
        changed(scope.userId);
        return null;
      }
      if (!ticket) return null;
      return {
        navigation,
        async append(step) {
          // list-requests is wrapped too. An inbox-wide result is outside a
          // request-scoped demonstration; never copy other requests into it.
          if (
            step.actionName === "list-requests" &&
            (!Array.isArray(step.output) ||
              step.output.some((r) => r?.id !== navigation.requestId))
          ) {
            await demos.complete(scope, ticket, null);
            return;
          }
          const cleanInput = Object.fromEntries(
            Object.entries(step.input as object).filter(
              ([, value]) => value !== undefined,
            ),
          );
          if (
            !isRecipeJson(cleanInput) ||
            !isRecipeJson(step.output) ||
            !isRecipeJson(step.navigation)
          )
            throw new Error("Capture is not JSON.");
          await demos.complete(
            scope,
            ticket,
            {
              action: step.actionName,
              ...(agent && context.runId ? { runId: context.runId } : {}),
              input: cleanInput as JsonObject,
              output: step.output,
              navigation: step.navigation,
              caller: step.caller,
              startedAt: step.startedAt,
              durationMs: step.durationMs,
            },
            read ? "read" : "mutation",
          );
          if (agent && step.actionName === "set-request-status" && (cleanInput as JsonObject).status === "resolved")
            await demos.finish(scope, ticket.demonstrationId);
          changed(scope.userId);
        },
        async reject() {
          await demos.complete(scope, ticket, null);
        },
        async incomplete(reason) {
          await demos.incomplete(scope, ticket.demonstrationId, reason);
          changed(scope.userId);
        },
      };
    },
  };
}
