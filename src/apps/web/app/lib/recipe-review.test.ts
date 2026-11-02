import type { JsonValue } from "@muscle-memory/recipe-engine";
import { describe, expect, it } from "vitest";

import {
  approvalArguments,
  approvalDescription,
  approvalExpression,
  readApproval,
} from "./recipe-approval";
import { reviewQuestions } from "./recipe-review";
const step = {
  id: "refund",
  kind: "action",
  action: "issue-refund",
  args: {
    orderId: { mode: "path", path: "trigger.orderId" },
    amount: {
      amountMinor: { mode: "fixed", value: 14000 },
      currency: { mode: "fixed", value: "USD" },
    },
  },
};
describe("human approval and ambiguity presentation", () => {
  it("converts dollar thresholds exactly and rejects fractional cents/unsafe amounts", () => {
    const args = approvalArguments(step);
    expect(readApproval(undefined, args)).toMatchObject({
      mode: "never",
      argument: "amount.amountMinor",
    });
    const choice = {
      mode: "when" as const,
      argument: "amount.amountMinor",
      operator: ">" as const,
      value: "100.01",
    };
    const expr = approvalExpression(choice, args);
    expect(expr).toEqual({ ">": [{ var: "input.amount.amountMinor" }, 10001] });
    expect(readApproval(expr, args)).toEqual(choice);
    for (const value of ["100.001", "-1", "NaN", "1e3", "90071992547410"])
      expect(() => approvalExpression({ ...choice, value }, args)).toThrow();
  });
  it("keeps custom threshold types in Advanced and recognises whole-object refund bindings", () => {
    const args = approvalArguments(step);
    for (const value of [true, -1, 0.5, "100"])
      expect(
        readApproval(
          { ">": [{ var: "input.amount.amountMinor" }, value] },
          args,
        ).mode,
      ).toBe("advanced");
    expect(
      readApproval({ "===": [{ var: "input.orderId" }, 123] }, args).mode,
    ).toBe("advanced");
    expect(
      approvalArguments({
        ...step,
        args: { amount: { mode: "path", path: "trigger.amount" } },
      }),
    ).toEqual([
      { path: "amount.amountMinor", label: "Refund amount", kind: "money" },
    ]);
  });
  it("formats approval history using the bound currency and whole input amounts", () => {
    const approval = { ">": [{ var: "input.amount.amountMinor" }, 10000] };
    expect(approvalDescription({ ...step, approval }, {}, true)).toBe("When refund amount > $100");
    expect(approvalDescription(step, {}, true)).toBe("Never");
    expect(approvalDescription({ ...step, approval: true }, {}, true)).toBe("Always");
    expect(approvalDescription({ ...step, approval, args: {
      amount: { mode: "fixed", value: { amountMinor: 14000, currency: "EUR" } },
    } }, {}, true)).toBe("When refund amount > €100");
    expect(approvalDescription({ ...step, approval, args: {
      amount: { amountMinor: step.args.amount.amountMinor, currency: { mode: "path", path: "trigger.currency" } },
    } }, {}, true)).toBe("When refund amount > 100 in currency · Request");
  });
  it("names the competing refund and reply candidates in the question", () => {
    const formula = { mode: "expr", expr: { "*": [0.5, { find: [
      { var: "steps.order.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.amountMinor",
    ] }] } };
    const refund = { ...step, args: { ...step.args, amount: { ...step.args.amount, amountMinor: formula } } };
    const reply = { id: "reply", action: "send-reply", args: {
      template: { mode: "expr", expr: { cat: ["Hi ", { firstWord: [{ var: "trigger.name" }] }] } },
    } };
    const entries = [
      { stepId: "refund", argumentPath: "amount.amountMinor", kind: "multiple-candidates", candidates: [
        { binding: formula }, { binding: { mode: "fixed", value: 2400 } },
      ] },
      { stepId: "reply", argumentPath: "template", kind: "multiple-candidates", candidates: [
        { binding: reply.args.template }, { binding: { mode: "fixed", value: "Hi Maya" } },
      ] },
    ];
    const questions = reviewQuestions(entries, { steps: [refund, reply] }, { order: "Look up order" });
    expect(questions[0]?.question).toContain("Refund amount matched 50% × unit price");
    expect(questions[0]?.question).toContain("and a fixed $24.00 — which should future requests use?");
    expect(questions[1]?.question).toContain("Reply matched a message using First name of name · Request and fixed text “Hi Maya”");
    expect(questions.every((item) => !item.question.includes("Which source should supply this value?"))).toBe(true);
    expect(questions.map((item) => item.entry)).toEqual(entries);
  });
  it("does not collapse unrelated sources or policy choices into Minor", () => {
    const content: JsonValue = {
      steps: [
        {
          id: "order",
          action: "get-order",
          args: { orderId: { mode: "path", path: "trigger.orderId" } },
        },
        step,
      ],
    };
    const candidate = (path: string) => ({
      reason: "exact-match",
      binding: { mode: "path", path },
    });
    const base = {
      stepId: "refund",
      argumentPath: "orderId",
      kind: "multiple-candidates",
    };
    expect(
      reviewQuestions(
        [
          {
            ...base,
            candidates: [
              candidate("trigger.orderId"),
              candidate("steps.order.output.id"),
            ],
          },
        ],
        content,
        {},
      )[0]?.minor,
    ).toBe(true);
    expect(
      reviewQuestions(
        [
          {
            ...base,
            candidates: [
              candidate("trigger.orderId"),
              candidate("steps.order.output.customerId"),
            ],
          },
        ],
        content,
        {},
      )[0]?.minor,
    ).toBe(false);
    expect(
      reviewQuestions(
        [
          {
            ...base,
            kind: "constant-or-variable",
            candidates: [candidate("trigger.orderId")],
          },
        ],
        content,
        {},
      )[0]?.minor,
    ).toBe(false);
  });
});
