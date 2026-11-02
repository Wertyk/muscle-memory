import { parseRecipeVersion, type Step } from "@muscle-memory/recipe-engine";

const request = { mode: "path" as const, path: "trigger.requestId" };
const fixed = (value: string) => ({ mode: "fixed" as const, value });
const tag: Step = {
  id: "tag",
  kind: "action",
  action: "tag-request",
  args: { requestId: request, tag: fixed("run-rehearsal") },
};
const recipe = (key: string, name: string, steps: readonly Step[]) =>
  parseRecipeVersion({
    id: `ver_run_${key}`,
    recipeId: `recipe_run_${key}`,
    version: 1,
    name,
    trigger: { event: "request.created", match: false },
    steps,
  });
/** Explicit rehearsal recipes, never activated or silently installed by the UI. */
export const runFixtures = {
  completed: recipe("complete", "Shipment update", [
    {
      id: "shipment",
      kind: "action",
      action: "get-shipment-status",
      args: { orderId: { mode: "path", path: "trigger.orderId" } },
    },
    {
      id: "reply",
      kind: "action",
      action: "send-reply",
      args: {
        requestId: request,
        template: fixed("Your order is {{status}}."),
        variables: {
          status: { mode: "path", path: "steps.shipment.output.orderStatus" },
        },
      },
    },
    tag,
  ]),
  approval: recipe("approval", "Review damaged platter refund", [
    {
      id: "order",
      kind: "action",
      action: "get-order",
      args: { orderId: { mode: "path", path: "trigger.orderId" } },
    },
    {
      id: "refund",
      kind: "action",
      action: "issue-refund",
      approval: true,
      args: {
        orderId: { mode: "path", path: "trigger.orderId" },
        reason: fixed("Damaged platter: 50% refund"),
        amount: {
          amountMinor: { mode: "fixed", value: 14000 },
          currency: fixed("USD"),
        },
      },
    },
    tag,
  ]),
  rejected: recipe("rejected", "Review request tag", [
    { ...tag, approval: true },
  ]),
  handoff: recipe("handoff", "Wholesale enquiry review", [
    {
      id: "review",
      kind: "handoff",
      to: "agent",
      note: fixed(
        "Wholesale pricing needs a personal reply. Review the customer message before continuing.",
      ),
    },
  ]),
  failed: recipe("failed", "Check missing order", [
    {
      id: "order",
      kind: "action",
      action: "get-order",
      args: { orderId: fixed("ord_missing") },
    },
  ]),
};
