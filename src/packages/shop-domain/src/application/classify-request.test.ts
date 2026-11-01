import { describe, expect, it } from "vitest";
import { REQUEST_TYPES, type RequestType } from "../domain/index.js";
import { ClassifyRequest } from "./classify-request.js";
import { request, setup } from "../../test/fakes.js";

function freeText() {
  const deps = setup();
  deps.shop.requests.set(request.id, {
    ...request, content: { source: "free_text", text: "Could you check my delivery?", type: null },
    status: "pending", tags: ["important"], escalation: { reason: "Review", escalatedAt: request.createdAt },
  });
  return deps;
}

describe("ClassifyRequest", () => {
  it.each(REQUEST_TYPES)("persists %s without replacing the original message or other request state", async (type) => {
    const deps = freeText();
    const original = (await deps.shop.getRequest(request.id))!;
    const result = await new ClassifyRequest(deps).execute({ requestId: request.id, type });
    const expected = { ...original, content: { ...original.content, type }, updatedAt: deps.clock.now() };
    expect(result).toEqual({ ok: true, value: expected });
    expect(await deps.shop.getRequest(request.id)).toEqual(expected);
  });

  it("is idempotent on redelivery and refuses a conflicting classification", async () => {
    const deps = freeText();
    const classify = new ClassifyRequest(deps);
    const input = { requestId: request.id, type: "where_is_my_order" as const };
    const result = await classify.execute(input);
    deps.clock.timestamp = "2026-11-03T12:00:00.000Z";
    expect(await classify.execute(input)).toEqual(result);
    expect(await classify.execute({ ...input, type: "return" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", field: "type" } });
    expect(await deps.shop.getRequest(request.id)).toEqual(result.ok ? result.value : null);
  });

  it("rejects unknown types, missing requests and structured requests without changing data", async () => {
    const deps = setup();
    const classify = new ClassifyRequest(deps);
    expect(await classify.execute({ requestId: request.id, type: "other" as RequestType })).toMatchObject({ ok: false, error: { field: "type" } });
    expect(await classify.execute({ requestId: "req_missing", type: "return" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await classify.execute({ requestId: request.id, type: "return" })).toMatchObject({ ok: false, error: { field: "content" } });
    expect(await deps.shop.getRequest(request.id)).toEqual(request);
  });

  it("leaves a free-text request unclassified when the clock is invalid", async () => {
    const deps = freeText();
    const before = await deps.shop.getRequest(request.id);
    deps.clock.timestamp = "invalid";
    expect(await new ClassifyRequest(deps).execute({ requestId: request.id, type: "return" })).toMatchObject({ ok: false, error: { field: "clock" } });
    expect(await deps.shop.getRequest(request.id)).toEqual(before);
  });
});
