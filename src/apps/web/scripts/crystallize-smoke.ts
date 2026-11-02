/** Opt-in live-model Gate B rehearsal against the local seeded app on 8093.
 * Uses real demonstration/actions and native chat transport. Never run by tests.
 * Run from apps/web: node --env-file=.env --import tsx scripts/crystallize-smoke.ts
 * Synthetic shop effects remain for reviewer inspection; no implicit activation.
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { AgentKitClient } from "@agent-native/agentkit";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import {
  buildRequestTrigger,
  type Demonstration,
  type JsonObject,
  type RecipeDraft,
  type RecipeVersion,
  type Run,
} from "@muscle-memory/recipe-engine";
import type {
  Customer,
  Order,
  Request,
  Shipment,
} from "@muscle-memory/shop-domain";
import { Window } from "happy-dom";

import { recipeMessages } from "../app/i18n/recipes-en.js";

const origin = "http://localhost:8093";
const nativeFetch = globalThis.fetch;
let response = await nativeFetch(`${origin}/sign-in`, {
  redirect: "manual",
  headers: { Accept: "text/html" },
});
if (!response.headers.getSetCookie().length)
  response = await nativeFetch(`${origin}/_agent-native/auth/local-dev`, {
    method: "POST",
    headers: { origin },
  });
const cookies = new Map<string, string>();
const remember = (response: Response) => {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]!;
    cookies.set(pair.slice(0, pair.indexOf("=")), pair);
  }
};
remember(response);
assert(cookies.size, "Local development session required");
const dom = new Window({ url: `${origin}/recipes` });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}
globalThis.fetch = async (input, init) => {
  const result = await nativeFetch(new URL(String(input), origin), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      cookie: [...cookies.values()].join("; "),
      origin,
      referer: `${origin}/recipes`,
    },
  });
  remember(result);
  return result;
};
const { callAction, writeClientAppState, getBrowserTabId } =
  await import("@agent-native/core/client/hooks");
const action = <T>(
  name: string,
  input: Record<string, unknown> = {},
  read = true,
) => callAction<T>(name, input, read ? { method: "GET" } : { uiOnly: true });
const controller = new AgentKitClient({
  transport: createAgentNativeAgentKitTransport(),
});
const chosenType = process.argv
  .find((value) => value.startsWith("--type="))
  ?.slice(7);
const reuseId = process.argv
  .find((value) => value.startsWith("--recipe="))
  ?.slice(9);
const sourceId = process.argv
  .find((value) => value.startsWith("--request="))
  ?.slice(10);
let activeDemonstrationId: string | null = null;
try {
  const requests = await action<Request[]>("list-requests");
  for (const type of ["damaged_item", "where_is_my_order", "address_change"]) {
    if (chosenType && chosenType !== type) continue;
    const eligible = requests.filter(
      (request) =>
        request.status === "open" &&
        request.content.source === "structured" &&
        request.content.fields.type === type,
    );
    const source = sourceId
      ? eligible.find((request) => request.id === sourceId)
      : eligible[0];
    const target = eligible.find((request) => request.id !== source?.id);
    assert(
      source && target && source.orderId && target.orderId,
      `Two open structured ${type} requests required`,
    );
    let demonstration: Demonstration;
    let draft: RecipeDraft | undefined;
    if (reuseId) {
      const detail = await action<{ history: { version: RecipeVersion }[] }>(
        "get-recipe",
        { recipeId: reuseId },
      );
      draft = await action<RecipeDraft>("get-recipe-draft", {
        versionId: detail.history[0]!.version.id,
      });
      demonstration = await action<Demonstration>("get-demonstration", {
        demonstrationId: draft.demonstrationId,
      });
    } else {
      await writeClientAppState(
        "navigation",
        {
          view: "request",
          requestId: source.id,
          path: `/requests/${source.id}`,
        },
        { requestSource: getBrowserTabId() },
      );
      demonstration = await action<Demonstration>(
        "start-demonstration",
        { requestId: source.id },
        false,
      );
      activeDemonstrationId = demonstration.id;
      console.log(
        JSON.stringify({
          type,
          sourceRequestId: source.id,
          demonstrationId: demonstration.id,
          phase: "recording",
        }),
      );
      await assert.rejects(
        action("start-demonstration", { requestId: source.id }, false),
      );
      if (process.argv.includes("--controls-only")) {
        await action(
          "cancel-demonstration",
          { demonstrationId: demonstration.id },
          false,
        );
        const restarted = await action<Demonstration>(
          "start-demonstration",
          { requestId: source.id },
          false,
        );
        activeDemonstrationId = restarted.id;
        await action(
          "cancel-demonstration",
          { demonstrationId: restarted.id },
          false,
        );
        activeDemonstrationId = null;
        const landing = await fetch(`${origin}/inbox`, {
          headers: { Accept: "text/html" },
          redirect: "manual",
        });
        assert.equal(landing.status, 200);
        console.log(
          "Authenticated inbox, overlap rejection, cancellation and slot reuse passed over the normal frontend action transport. No model called.",
        );
        break;
      }
    }
    const order = await action<Order>("get-order", { orderId: source.orderId });
    const customer = await action<Customer>("get-customer", {
      customerId: source.customerId,
    });
    const firstName = customer.name.split(" ")[0];
    if (!reuseId) {
      if (type === "damaged_item") {
        assert(
          source.content.source === "structured" &&
            source.content.fields.type === "damaged_item",
        );
        const fields = source.content.fields;
        const item = order.items.find(
          (item) => item.productId === fields.productId,
        )!;
        const amountMinor = Math.round(item.unitPrice.amountMinor / 2);
        await action(
          "issue-refund",
          {
            orderId: order.id,
            amount: { amountMinor, currency: item.unitPrice.currency },
            reason: "Damaged item: refund half of the selected item's price",
          },
          false,
        );
        const productText =
          item.name === "Ember Large Serving Platter"
            ? "Ember serving platter"
            : item.name;
        await action(
          "send-reply",
          {
            requestId: source.id,
            variables: {},
            template: `Hi ${firstName}, I am sorry your ${productText} arrived damaged. We refunded $${(amountMinor / 100).toFixed(2)}, half of its price. Warmly, Kiln & Co.`,
          },
          false,
        );
        await action(
          "tag-request",
          { requestId: source.id, tag: "damaged" },
          false,
        );
      } else if (type === "where_is_my_order") {
        const status = await action<{
          orderStatus: string;
          shipment: Shipment | null;
        }>("get-shipment-status", { orderId: order.id });
        assert(status.shipment);
        await action(
          "send-reply",
          {
            requestId: source.id,
            variables: {},
            template: `Hi ${firstName}, your order ${order.id} is with ${status.shipment.carrier}. Tracking: ${status.shipment.trackingNumber}. Estimated delivery: ${status.shipment.estimatedDeliveryAt}. This is an estimate. Warmly, Kiln & Co.`,
          },
          false,
        );
        await action(
          "tag-request",
          { requestId: source.id, tag: "delivery" },
          false,
        );
      } else {
        assert(
          source.content.source === "structured" &&
            source.content.fields.type === "address_change",
        );
        await action(
          "update-shipping-address",
          { orderId: order.id, address: source.content.fields.address },
          false,
        );
        await action(
          "send-reply",
          {
            requestId: source.id,
            variables: {},
            template: `Hi ${firstName}, we updated the shipping address for your order ${order.id}. Warmly, Kiln & Co.`,
          },
          false,
        );
        await action(
          "tag-request",
          { requestId: source.id, tag: "address-updated" },
          false,
        );
      }
      await action(
        "stop-demonstration",
        { demonstrationId: demonstration.id },
        false,
      );
      activeDemonstrationId = null;
      const stopped = await action<Demonstration>("get-demonstration", {
        demonstrationId: demonstration.id,
      });
      assert.equal(stopped.status, "completed");
      draft = await action<RecipeDraft>(
        "draft-recipe-from-demonstration",
        { demonstrationId: demonstration.id },
        false,
      );
    }
    assert(draft);
    const thread = await controller.createThread();
    await controller.loadThread(thread.id);
    console.log(
      JSON.stringify({
        type,
        demonstrationId: demonstration.id,
        recipeId: draft.recipe.id,
        draftId: draft.draft.id,
        threadId: thread.id,
        target: target.id,
        model: process.env.AGENT_MODEL,
      }),
    );
    const observed = new Set<string>();
    const unsubscribe = controller.subscribe(() => {
      for (const tool of Object.values(controller.getThread(thread.id).tools)) {
        const key = `${tool.id}:${tool.status}`;
        if (observed.has(key)) continue;
        observed.add(key);
        console.log(JSON.stringify({ tool: tool.name, status: tool.status }));
      }
    });
    try {
      const context = {
        workflow: "crystallize",
        recipeId: draft.recipe.id,
        draftId: draft.draft.id,
        originalVersionId: draft.draft.id,
        demonstrationId: demonstration.id,
        request: demonstration.trigger,
        ambiguities: draft.ambiguities,
      };
      const handle = await controller.sendMessage({
        threadId: thread.id,
        text: `${recipeMessages.crystallizePrompt}\nContext: ${JSON.stringify(context)}`,
      });
      await handle.completed;
      // This is the operator's policy answer, never supplied DSL or model output.
      let detail = await action<{ history: { version: RecipeVersion }[] }>(
        "get-recipe",
        { recipeId: draft.recipe.id },
      );
      if (detail.history.length === 1) {
        console.log(JSON.stringify({ type, phase: "operator clarification" }));
        const answer = await controller.sendMessage({
          threadId: thread.id,
          text:
            type === "damaged_item"
              ? "Use half of the damaged item's unit price for this recipe, not a fixed dollar amount. The product and customer must vary per request. Keep the damaged tag. Please finish saving and dry-run another structured damaged request."
              : type === "where_is_my_order"
                ? "Reuse this delivery reply for delivery questions; carrier, tracking, estimate, order ID and customer name must vary with the request. Keep the delivery tag. Please finish saving and dry-run another structured delivery request."
                : "Reuse this for address-change requests before dispatch. Use each request's complete new address; customer and order IDs must vary. Keep the address-updated tag. Please finish saving and dry-run another structured address-change request.",
        });
        await answer.completed;
        detail = await action("get-recipe", { recipeId: draft.recipe.id });
      }
      let version = detail.history[detail.history.length - 1]!.version;
      if (
        !version.steps.some(
          (step) => step.kind === "action" && step.action === "get-customer",
        )
      ) {
        console.log(
          JSON.stringify({
            type,
            phase:
              "customer source correction: greeting still relies on recipient; not yet a pass",
          }),
        );
        const correction = await controller.sendMessage({
          threadId: thread.id,
          text: "The greeting must use the CUSTOMER first name, not the shipping recipient (which can be someone else). Follow the crystallize skill's customer-source rule, update and save through Studio, and repeat the other-request dry run. Keep the same handling policy.",
        });
        await correction.completed;
        detail = await action("get-recipe", { recipeId: draft.recipe.id });
        version = detail.history[detail.history.length - 1]!.version;
      }
      const state = controller.getThread(thread.id);
      const proposalTools = Object.values(state.tools).filter(
        (tool) =>
          tool.name === "save-recipe-version" && tool.status === "completed",
      );
      assert(target.content.source === "structured");
      const targetTrigger = buildRequestTrigger(
        target.content.fields as unknown as JsonObject,
        {
          requestId: target.id,
          customerId: target.customerId,
          subject: target.subject,
        },
      );
      const run = await action<Run>(
        "run-recipe",
        { recipe: version, trigger: targetTrigger, dryRun: true },
        false,
      );
      const targetOrder = await action<Order>("get-order", {
        orderId: target.orderId,
      });
      const targetCustomer = await action<Customer>("get-customer", {
        customerId: target.customerId,
      });
      const reply = run.steps.find((step) => step.action === "send-reply");
      const input = reply?.input as
        | {
            template?: string;
            variables?: Record<string, string | number | boolean>;
          }
        | undefined;
      const rendered = input?.template?.replace(
        /\{\{\s*([^{}]+?)\s*\}\}/g,
        (placeholder, key) => String(input.variables?.[key] ?? placeholder),
      );
      const customerStep = version.steps.find(
        (step) => step.kind === "action" && step.action === "get-customer",
      );
      let correct =
        detail.history.length > 1 &&
        run.status === "completed" &&
        run.tokens.input === 0 &&
        run.tokens.output === 0 &&
        Boolean(rendered?.includes(targetCustomer.name.split(" ")[0]!)) &&
        Boolean(customerStep);
      if (type === "damaged_item") {
        const fields = target.content.fields as unknown as {
          productId: string;
        };
        const item = targetOrder.items.find(
          (item) => item.productId === fields.productId,
        )!;
        const refund = run.steps.find((step) => step.action === "issue-refund")
          ?.input as JsonObject | undefined;
        correct &&=
          Boolean(rendered?.includes(item.name)) &&
          isDeepStrictEqual(refund?.amount, {
            amountMinor: Math.round(item.unitPrice.amountMinor / 2),
            currency: item.unitPrice.currency,
          });
        assert.notEqual(
          item.productId,
          order.items[0]!.productId,
          "Damage target must select a different product",
        );
      } else if (type === "where_is_my_order") {
        const shipment = await action<{ shipment: Shipment }>(
          "get-shipment-status",
          { orderId: target.orderId },
        );
        correct &&=
          typeof shipment.shipment.trackingNumber === "string" &&
          Boolean(rendered?.includes(shipment.shipment.trackingNumber)) &&
          Boolean(
            rendered?.includes(String(shipment.shipment.estimatedDeliveryAt)),
          );
      } else {
        const update = run.steps.find(
          (step) => step.action === "update-shipping-address",
        );
        correct &&= isDeepStrictEqual(
          (update?.input as { address?: unknown })?.address,
          (target.content.fields as unknown as { address: unknown }).address,
        );
      }
      console.log(
        JSON.stringify({
          type,
          demonstrationId: demonstration.id,
          recipeId: draft.recipe.id,
          originalVersionId: draft.draft.id,
          savedVersionId: version.id,
          savedVersion: version.version,
          ambiguities: draft.ambiguities.map(
            ({ kind, stepId, argumentPath }) => ({
              kind,
              stepId,
              argumentPath,
            }),
          ),
          proposalNotes: proposalTools.map(
            (tool) => (tool.input as { proposal?: unknown }).proposal,
          ),
          proposalWidget: Object.values(state.widgets).some(
            (widget) => widget.kind === "muscle-memory.recipe-proposal",
          ),
          dryRun: {
            requestId: target.id,
            runId: run.id,
            status: run.status,
            tokens: run.tokens,
            steps: run.steps.map(({ action, input, status }) => ({
              action,
              input,
              status,
            })),
          },
          correct,
        }),
      );
      assert(
        correct,
        `${type} failed independent generalization/dry-run checks`,
      );
      assert(
        Object.values(state.widgets).some(
          (widget) => widget.kind === "muscle-memory.recipe-proposal",
        ),
        "Native chat must emit the proposal card",
      );
    } finally {
      unsubscribe();
    }
  }
} finally {
  if (activeDemonstrationId)
    await action(
      "cancel-demonstration",
      { demonstrationId: activeDemonstrationId },
      false,
    ).catch(() => {});
  await controller.dispose();
  globalThis.fetch = nativeFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
}
