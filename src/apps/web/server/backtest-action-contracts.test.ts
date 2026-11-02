import { FeatureNotConfiguredError } from "@agent-native/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { backtestOperation } from "./backtest-action-contracts.js";
import { CompleteTextExtractor, ExtractionError } from "./infra/complete-text-extraction.js";
import { HistoricalReconstructionError } from "./infra/shop-historical-cases.js";

afterEach(() => vi.restoreAllMocks());

describe("safe backtest diagnostics", () => {
  it("returns the failing request and known extraction reason without duplicating usage guidance", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new HistoricalReconstructionError("req_0039", new ExtractionError("not-configured", "Extraction is not configured."));
    await expect(backtestOperation(async () => { throw error; })).rejects.toMatchObject({
      errorCode: "BACKTEST_FAILED", message: "Request req_0039 could not be reconstructed: Extraction is not configured.",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith("[recipe-backtest]", {
      name: "HistoricalReconstructionError", message: error.message, requestId: "req_0039",
      causeName: "ExtractionError", causeMessage: "Extraction is not configured.",
    });
  });

  it("logs request/step context for output validation without logging invalid values", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const schema = z.object({ cases: z.array(z.object({ caseId: z.string(), run: z.object({ steps: z.array(z.object({ stepId: z.string(), attempt: z.number() })) }) })) });
    const result = { cases: [{ caseId: "req_0039", run: { steps: [{ stepId: "refund", attempt: "private customer text" }] } }] };
    // Simulate a transport result with a wrong field type before output validation.
    await expect(backtestOperation(async () => result as unknown as z.infer<typeof schema>, schema)).rejects.toMatchObject({ errorCode: "BACKTEST_FAILED" });
    expect(log).toHaveBeenCalledExactlyOnceWith("[recipe-backtest]", {
      name: "ZodError", message: "Backtest data failed schema validation.", requestId: "req_0039", stepId: "refund",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private customer text");
  });

  it("keeps unknown errors generic and does not serialize provider messages, credentials or customer text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateMessage = "Bearer synthetic-secret; customer said: private text";
    await expect(backtestOperation(async () => { throw new TypeError(privateMessage); })).rejects.toMatchObject({
      errorCode: "BACKTEST_FAILED", message: "Backtest could not finish. Check the historical request fields and recipe, then retry.",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith("[recipe-backtest]", { name: "TypeError", message: "Unexpected backtest failure (private details withheld)." });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateMessage);
  });

  it("recognizes missing model and credential configuration before exposing any provider details", async () => {
    const fields = { type: { type: "string" as const, required: true } };
    const complete = vi.fn();
    await expect(new CompleteTextExtractor(() => ({ model: "" }), complete).extract({ text: "Message", fields })).rejects.toMatchObject({ code: "not-configured" });
    expect(complete).not.toHaveBeenCalled();
    const missingCredential = async () => { throw new FeatureNotConfiguredError({ requiredCredential: "OPENAI_API_KEY" }); };
    await expect(new CompleteTextExtractor(() => ({ model: "fake-model" }), missingCredential).extract({ text: "Message", fields })).rejects.toMatchObject({
      code: "not-configured", message: "Extraction is not configured.",
    });
  });
});
