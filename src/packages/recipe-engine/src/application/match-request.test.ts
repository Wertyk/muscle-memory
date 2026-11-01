import { describe, expect, it, vi } from "vitest";
import { MatchRequest, type MatchInput } from "./match-request.js";
import { parseRecipeVersion } from "./recipe-schema.js";
import type { JsonObject } from "../domain/model.js";

const version = (id = "v_one", event = "request.created") => parseRecipeVersion({
  id, recipeId: `recipe_${id}`, version: 1, name: id,
  trigger: { event, match: { "===": [{ var: "trigger.type" }, "example"] } },
  steps: [{ id: "human", kind: "handoff", to: "human", note: { mode: "fixed", value: "Test" } }],
});
const structured: MatchInput = {
  event: "request.created", context: { requestId: "req_one" },
  content: { source: "structured", fields: { type: "example", orderId: "ord_one" } },
};
const freeText: MatchInput = { ...structured, content: { source: "free_text", text: "A message" } };
const setup = (versions = [version()]) => ({
  recipes: { listActive: vi.fn(async () => versions) },
  extractor: { extract: vi.fn(async (_text: string): Promise<{ fields: JsonObject | null; tokens: { input: number; output: number } }> => ({
    fields: { type: "example", orderId: "ord_one" }, tokens: { input: 13, output: 7 },
  })) },
});

describe("MatchRequest", () => {
  it("matches structured fields with zero extraction calls/tokens and ignores other events", async () => {
    const deps = setup([version("v_other", "other.event"), version()]);
    const result = await new MatchRequest(deps).execute(structured);
    expect(result).toMatchObject({ reason: "matched", recipe: { id: "v_one" }, tokens: { input: 0, output: 0 }, trigger: { requestId: "req_one", type: "example", orderId: "ord_one" } });
    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.recipe)).toBe(true);
  });
  it("extracts exactly once before testing all active triggers, retaining measured usage", async () => {
    const deps = setup([version("v_other", "other.event"), version()]);
    const result = await new MatchRequest(deps).execute(freeText);
    expect(result.reason).toBe("matched");
    expect(result.tokens).toEqual({ input: 13, output: 7 });
    expect(deps.extractor.extract).toHaveBeenCalledExactlyOnceWith("A message");
  });
  it("keeps trusted request identity even if an extractor supplies the same key", async () => {
    const deps = setup();
    deps.extractor.extract.mockResolvedValue({ fields: { type: "example", requestId: "req_untrusted" }, tokens: { input: 1, output: 1 } });
    expect((await new MatchRequest(deps).execute(freeText)).trigger.requestId).toBe("req_one");
  });
  it("returns no_match for no active recipes, and ambiguous instead of choosing between overlaps", async () => {
    expect((await new MatchRequest(setup([])).execute(structured)).reason).toBe("no_match");
    const result = await new MatchRequest(setup([version(), version("v_two")])).execute(structured);
    expect(result).toMatchObject({ reason: "ambiguous", recipe: null });
  });
  it("never retries extraction failures and does not leak provider data", async () => {
    const deps = setup();
    deps.extractor.extract.mockRejectedValue(new Error("private provider details"));
    const result = await new MatchRequest(deps).execute(freeText);
    expect(result).toEqual({ recipe: null, trigger: { requestId: "req_one" }, reason: "extraction_failed", tokens: { input: 0, output: 0 } });
    expect(deps.extractor.extract).toHaveBeenCalledTimes(1);
    expect(deps.recipes.listActive).not.toHaveBeenCalled();
  });
  it("retains usage for schema-invalid extraction; invalid usage fails closed", async () => {
    const deps = setup();
    deps.extractor.extract.mockResolvedValue({ fields: null, tokens: { input: 15, output: 4 } });
    expect(await new MatchRequest(deps).execute(freeText)).toMatchObject({ reason: "extraction_failed", tokens: { input: 15, output: 4 } });
    deps.extractor.extract.mockResolvedValue({ fields: { type: "example" }, tokens: { input: -1, output: 4 } });
    expect((await new MatchRequest(deps).execute(freeText)).reason).toBe("extraction_failed");
  });
  it("hands off matching errors instead of treating a broken catalog as an empty catalog", async () => {
    const deps = setup();
    deps.recipes.listActive.mockRejectedValue(new Error("Database details"));
    expect(await new MatchRequest(deps).execute(structured)).toMatchObject({ recipe: null, reason: "matching_failed" });
  });
});
