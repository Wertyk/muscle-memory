import type { JsonObject, Mutation } from "@muscle-memory/recipe-engine";
import { describe, expect, it } from "vitest";
import { ShopMutationNormalizer } from "./shop-mutation-normalizer.js";

const normalizer = new ShopMutationNormalizer();
const normalize = (action: string, input: JsonObject) => normalizer.normalize([{ action, input }]);
const refund = { orderId: "ord_1001", reason: "Damaged item", amount: { amountMinor: 1200, currency: "USD" } };

describe("shop mutation comparison equivalences", () => {
  it("ignores known top-level generated IDs/times, retaining semantic identifiers", () => {
    expect(normalize("issue-refund", { ...refund, id: "ref_0001", createdAt: "yesterday", updatedAt: "today" })).toEqual(normalize("issue-refund", refund));
    expect(normalize("issue-refund", { ...refund, orderId: "ord_1002" })).not.toEqual(normalize("issue-refund", refund));
    expect(normalize("tag-request", { requestId: "req_0001", tag: "handled" })).not.toEqual(normalize("tag-request", { requestId: "req_0002", tag: "handled" }));
    expect(normalize("create-replacement-order", { orderId: "ord_1001", items: [{ productId: "prd_0001", quantity: 1 }] }))
      .not.toEqual(normalize("create-replacement-order", { orderId: "ord_1001", items: [{ productId: "prd_0002", quantity: 1 }] }));
  });

  it("compares rendered replies despite different template/variable representations", () => {
    const template = { requestId: "req_0001", template: "Hello {{ name }}, refunded {{amount}}.", variables: { name: "Maya", amount: 12, unused: "ignored" } };
    const literal = { requestId: "req_0001", template: "Hello Maya, refunded 12.", variables: {} };
    expect(normalize("send-reply", template)).toEqual(normalize("send-reply", literal));
    expect(normalize("send-reply", { ...literal, template: "Hello Maya, refunded 24." })).not.toEqual(normalize("send-reply", template));
  });

  it("substitutes once and preserves punctuation, whitespace, line breaks and embedded IDs", () => {
    expect(normalize("send-reply", { requestId: "req_0001", template: "Hi {{name}}", variables: { name: "$& {{other}}" } }))
      .toEqual([{ action: "send-reply", input: { requestId: "req_0001", body: "Hi $& {{other}}" } }]);
    const reply = (template: string) => normalize("send-reply", { requestId: "req_0001", template, variables: {} });
    expect(reply("Hi\nord_1061")).not.toEqual(reply("Hi ord_1062"));
    expect(reply("Hi.")).not.toEqual(reply("Hi!"));
  });

  it.each([
    { template: "Hi {{missing}}", variables: {} },
    { template: "Hi {name}", variables: { name: "Maya" } },
    { template: "Hi {{name}}", variables: { name: null } },
    { template: "Hi {{name}}", variables: { name: "Maya" }, body: "Conflicting body" },
  ])("does not hide invalid/extra reply fields: %j", (input) => {
    const original = { requestId: "req_0001", ...input } as JsonObject;
    expect(normalize("send-reply", original)).toEqual([{ action: "send-reply", input: original }]);
  });

  it("trims only fields trimmed by shop use-cases", () => {
    expect(normalize("issue-refund", { ...refund, reason: "  Damaged item  " })).toEqual(normalize("issue-refund", refund));
    expect(normalize("escalate", { requestId: "req_0001", reason: " Review " })).toEqual(normalize("escalate", { requestId: "req_0001", reason: "Review" }));
  });

  it("normalizes contiguous tag operations as a trimmed deduplicated set", () => {
    const tag = (value: string): Mutation => ({ action: "tag-request", input: { requestId: "req_0001", tag: value } });
    expect(normalizer.normalize([tag("handled"), tag(" damaged_item "), tag("handled")]))
      .toEqual(normalizer.normalize([tag("damaged_item"), tag("handled")]));
    expect(normalizer.normalize([tag("handled")])).not.toEqual(normalizer.normalize([tag("other")]));
    const effect = { action: "issue-refund", input: refund };
    expect(normalizer.normalize([tag("handled"), effect])).not.toEqual(normalizer.normalize([effect, tag("handled")]));
  });

  it("preserves money, reasons, unknown/nested fields, omitted defaults and action order", () => {
    for (const input of [
      { ...refund, amount: { amountMinor: 2400, currency: "USD" } },
      { ...refund, amount: { amountMinor: 1200, currency: "EUR" } },
      { ...refund, reason: "Full refund" }, { ...refund, other: { id: "keep", createdAt: "keep" } },
    ]) expect(normalize("issue-refund", input)).not.toEqual(normalize("issue-refund", refund));
    expect(normalize("issue-refund", { orderId: refund.orderId, reason: refund.reason })).not.toEqual(normalize("issue-refund", refund));
    const unknown = { id: "semantic", createdAt: "meaningful", template: "{{x}}", variables: { x: "value" } };
    expect(normalize("unknown-action", unknown)).toEqual([{ action: "unknown-action", input: unknown }]);
    const mutations = [{ action: "issue-refund", input: refund }, { action: "generate-return-label", input: { orderId: "ord_1001" } }];
    expect(normalizer.normalize(mutations)).not.toEqual(normalizer.normalize([...mutations].reverse()));
  });

  it("is deterministic, idempotent, detached and does not mutate evidence", () => {
    const evidence: Mutation[] = [{ action: "issue-refund", input: { ...refund, reason: " Damaged item " } }];
    const before = structuredClone(evidence);
    const result = normalizer.normalize(evidence);
    expect(normalizer.normalize(result)).toEqual(result);
    expect(evidence).toEqual(before);
    (result[0]!.input.amount as Record<string, unknown>).amountMinor = 1;
    expect(evidence).toEqual(before);
  });
});
