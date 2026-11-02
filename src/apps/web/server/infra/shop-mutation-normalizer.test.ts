import { diffJson, type JsonObject, type Mutation } from "@muscle-memory/recipe-engine";
import { describe, expect, it } from "vitest";
import { ShopDifferenceClassifier, ShopMutationNormalizer } from "./shop-mutation-normalizer.js";

const normalizer = new ShopMutationNormalizer();
const normalize = (action: string, input: JsonObject) => normalizer.normalize([{ action, input }]);
const refund = { orderId: "ord_1001", reason: "Damaged item", amount: { amountMinor: 1200, currency: "USD" } };

describe("shop difference field policy", () => {
  const classifier = new ShopDifferenceClassifier();
  it("classifies internal tag operations as bookkeeping, preserving customer operations and status", () => {
    const before = [{ action: "tag-request", input: { requestId: "req_0001", tag: "handled" } }];
    const after = [{ action: "tag-request", input: { requestId: "req_0001", tag: "damaged" } }];
    expect(classifier.classify("/0/input/tag", before, after)).toBe("bookkeeping");
    expect(classifier.classify("/0", before, [])).toBe("bookkeeping");
    expect(classifier.classify("/0", [], after)).toBe("bookkeeping");
    expect(classifier.classify("/0/input/requestId", before, after)).toBe("bookkeeping");
    expect(classifier.classify("/0/action", [{ action: "issue-refund", input: refund }], after)).toBe("outcome");
    const status = [{ action: "set-request-status", input: { requestId: "req_0001", status: "resolved" } }];
    expect(classifier.classify("/0/input/status", status, status)).toBe("outcome");
  });
  it.each([
    ["issue-refund", "reason", "wording"],
    ["send-reply", "template", "wording"], ["send-reply", "body", "wording"],
    ["send-reply", "variables", "wording"], ["send-reply", "variables/name", "wording"],
    ["send-reply", "variables/a~1b~0c", "wording"],
    ["issue-refund", "orderId", "outcome"], ["send-reply", "requestId", "outcome"],
    ["issue-refund", "amount", "outcome"], ["issue-refund", "amount/amountMinor", "outcome"],
    ["issue-refund", "amount/currency", "outcome"], ["create-replacement-order", "items/0/productId", "outcome"],
    ["create-replacement-order", "items/0/quantity", "outcome"], ["tag-request", "tag", "outcome"],
    ["set-request-status", "status", "outcome"], ["escalate", "reason", "outcome"],
    ["unknown", "body", "outcome"], ["issue-refund", "reason/nested", "outcome"],
    ["send-reply", "body~1nested", "outcome"], ["send-reply", "extra", "outcome"],
  ])("classifies %s input %s as %s", (action, field, expected) => {
    const mutations = [{ action, input: {} }];
    expect(classifier.classify(`/0/input/${field}`, mutations, mutations)).toBe(expected);
  });

  it("keeps whole operations, changed action types, missing sides and unknown paths as outcomes", () => {
    const before = [{ action: "issue-refund", input: {} }];
    const after = [{ action: "send-reply", input: {} }];
    for (const path of ["", "/0", "/0/action", "/0/input", "/01/input/body", "/-1/input/body", "/1/input/body"])
      expect(classifier.classify(path, after, after)).toBe("outcome");
    expect(classifier.classify("/0/input/reason", before, after)).toBe("outcome");
    expect(classifier.classify("/0/input/body", [], after)).toBe("outcome");
  });

  it("retains normalized wording evidence while preserving a refund amount outcome difference", () => {
    const before = normalizer.normalize([{ action: "issue-refund", input: refund },
      { action: "send-reply", input: { requestId: "req_0001", template: "Hello {{name}}", variables: { name: "Maya" } } }]);
    const after = normalizer.normalize([{ action: "issue-refund", input: { ...refund, reason: "Chipped", amount: { amountMinor: 600, currency: "USD" } } },
      { action: "send-reply", input: { requestId: "req_0001", template: "Sorry Maya", variables: {} } }]);
    const differences = diffJson(before.map(({ action, input }) => ({ action, input })), after.map(({ action, input }) => ({ action, input })))
      .map((diff) => ({ path: diff.path, classification: classifier.classify(diff.path, before, after) }));
    expect(differences).toEqual([
      { path: "/0/input/amount/amountMinor", classification: "outcome" },
      { path: "/0/input/reason", classification: "wording" },
      { path: "/1/input/body", classification: "wording" },
    ]);
  });

  it("classifies added/removed refund reasons as wording even when the operation changes", () => {
    const replacement = [{ action: "create-replacement-order", input: { orderId: "ord_1001", items: [] } }];
    const refunded = [{ action: "issue-refund", input: refund }];
    expect(classifier.classify("/0/input/reason", replacement, refunded)).toBe("wording");
    expect(classifier.classify("/0/input/reason", refunded, replacement)).toBe("wording");
    expect(classifier.classify("/0/action", replacement, refunded)).toBe("outcome");
    expect(classifier.classify("/0/input/reason", [{ action: "unknown", input: { reason: "Semantic" } }], refunded)).toBe("outcome");
  });
});

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

  it("normalizes tag operations as a trimmed deduplicated set after customer operations", () => {
    const tag = (value: string): Mutation => ({ action: "tag-request", input: { requestId: "req_0001", tag: value } });
    expect(normalizer.normalize([tag("handled"), tag(" damaged_item "), tag("handled")]))
      .toEqual(normalizer.normalize([tag("damaged_item"), tag("handled")]));
    expect(normalizer.normalize([tag("handled")])).not.toEqual(normalizer.normalize([tag("other")]));
    const effect = { action: "issue-refund", input: refund };
    expect(normalizer.normalize([tag("handled"), effect])).toEqual(normalizer.normalize([effect, tag("handled")]));
    const before = normalizer.normalize([effect]);
    const after = normalizer.normalize([tag("handled"), effect]);
    const differences = diffJson(before.map(({ action, input }) => ({ action, input })), after.map(({ action, input }) => ({ action, input })));
    expect(differences).toHaveLength(1);
    expect(new ShopDifferenceClassifier().classify(differences[0]!.path, before, after)).toBe("bookkeeping");
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
