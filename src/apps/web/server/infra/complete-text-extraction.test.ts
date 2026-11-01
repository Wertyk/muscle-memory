import { describe, expect, it, vi } from "vitest";
import type { CompleteTextResult } from "@agent-native/core/server";
import { extractRequest } from "./complete-text-extraction";

const config = { model: "test-model", apiKey: "synthetic-test-credential" };
function completion(text: string): CompleteTextResult {
  return { text, content: [], engine: "ai-sdk:openai", model: "test-model", usage: { inputTokens: 20, outputTokens: 10 } };
}

describe("completeText extraction boundary (fake completion only)", () => {
  it("calls the narrow helper and validates JSON, preserving usage", async () => {
    const fake = vi.fn(async () => completion('{"category":"damaged","orderId":"ord_1042"}'));
    const result = await extractRequest("My ord_1042 mug arrived broken.", config, fake);
    expect(result).toMatchObject({ fields: { category: "damaged", orderId: "ord_1042" }, usage: { inputTokens: 20, outputTokens: 10 } });
    expect(fake).toHaveBeenCalledWith(expect.objectContaining({ engine: "ai-sdk:openai", model: "test-model", maxOutputTokens: 256, timeoutMs: 30_000 }));
  });
  it("allows a missing order ID", async () => {
    expect((await extractRequest("Wholesale inquiry", config, async () => completion('{"category":"other","orderId":null}'))).fields.orderId).toBeNull();
  });
  it.each([
    '```json\n{"category":"damaged","orderId":"ord_1042"}\n```',
    '{"category":"invalid","orderId":"ord_1042"}',
    '{"category":"damaged","orderId":"not-an-id"}',
    '{"category":"damaged","orderId":"ord_1042","extra":true}',
    '{"category":"damaged"}',
    'not JSON',
  ])("rejects malformed or schema-invalid output without leaking it", async text => {
    await expect(extractRequest("customer data", config, async () => completion(text))).rejects.toThrow("Extraction returned invalid structured output.");
  });
  it("rejects truncated output and sanitizes provider errors", async () => {
    await expect(extractRequest("hello", config, async () => ({ ...completion('{"category":"other","orderId":null}'), stopReason: "max_tokens" }))).rejects.toThrow("Extraction returned invalid structured output.");
    await expect(extractRequest("hello", config, async () => { throw new Error("private provider details"); })).rejects.toThrow("Extraction provider request failed.");
  });
  it("rejects oversized or empty input before calling the provider", async () => {
    const fake = vi.fn();
    await expect(extractRequest(" ", config, fake)).rejects.toThrow("Invalid extraction input");
    await expect(extractRequest("a".repeat(4001), config, fake)).rejects.toThrow("Invalid extraction input");
    expect(fake).not.toHaveBeenCalled();
  });
});
