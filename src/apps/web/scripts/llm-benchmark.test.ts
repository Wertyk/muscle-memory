import { describe, expect, it } from "vitest";
import { candidates, cases, gradeCalls, tools } from "../../../scripts/llm/llm-benchmark-cases";
import { summarize, type Measurement } from "../../../scripts/llm/llm-benchmark";

describe("tool benchmark scoring (no network)", () => {
  const test = cases[0]!;
  const call = { type: "function", function: { name: test.name, arguments: JSON.stringify(test.args) } };
  it("covers ten distinct tasks and four main/two cheap models", () => {
    expect(new Set(cases.map(item => item.id)).size).toBeGreaterThanOrEqual(10);
    expect(candidates.filter(item => item.role === "main")).toHaveLength(4);
    expect(candidates.filter(item => item.role === "cheap")).toHaveLength(2);
    expect(tools).toHaveLength(5);
  });
  it("accepts exact JSON arguments regardless of property order", () => {
    for (const item of cases) {
      expect(gradeCalls([{ type: "function", function: { name: item.name, arguments: JSON.stringify(Object.fromEntries(Object.entries(item.args).reverse())) } }], item)).toBe("pass");
    }
  });
  it("rejects missing/extra calls, wrong tool, invalid JSON and extra/coerced arguments", () => {
    expect(gradeCalls(undefined, test)).toBe("wrong-call-count");
    expect(gradeCalls([call, call], test)).toBe("wrong-call-count");
    expect(gradeCalls([{ ...call, function: { ...call.function, name: "send_reply" } }], test)).toBe("wrong-tool");
    expect(gradeCalls([{ ...call, function: { ...call.function, arguments: "{" } }], test)).toBe("invalid-arguments-json");
    expect(gradeCalls([{ ...call, function: { ...call.function, arguments: '{"orderId":"ord_1042","extra":true}' } }], test)).toBe("wrong-arguments");
    const refund = cases.find(item => item.id === "refund-cents")!;
    expect(gradeCalls([{ type: "function", function: { name: refund.name, arguments: JSON.stringify({ ...refund.args, amountCents: "1250" }) } }], refund)).toBe("wrong-arguments");
  });
  it("includes failures in latency and never reports missing usage as zero", () => {
    const rows: Measurement[] = [
      { role: "main", model: "kimi-k3", case: "a", verdict: "pass", latencyMs: 10, inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      { role: "main", model: "kimi-k3", case: "b", verdict: "timeout", latencyMs: 30, inputTokens: null, outputTokens: null, totalTokens: null },
    ];
    expect(summarize(rows)[0]).toMatchObject({ passed: 1, cases: 2, meanLatencyMs: 20, totalTokens: null });
  });
});
