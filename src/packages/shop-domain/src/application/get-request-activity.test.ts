import { describe, expect, it } from "vitest";

import { setup, request, order } from "../../test/fakes.js";
import type { Result } from "../domain/index.js";
import { GetRequestActivity } from "./get-request-activity.js";
import {
  CreateReplacementOrder,
  Escalate,
  GenerateReturnLabel,
  IssueRefund,
  SendReply,
  SetRequestStatus,
  TagRequest,
} from "./use-cases.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("GetRequestActivity", () => {
  it("returns a typed missing-request error", async () => {
    expect(
      await new GetRequestActivity(setup().shop).execute({
        requestId: "req_missing",
      }),
    ).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", entity: "request", id: "req_missing" },
    });
  });

  it("projects durable operations, named replacement lines and the recorded request state in newest-first order", async () => {
    const deps = setup();
    value(
      await new IssueRefund(deps).execute({
        orderId: order.id,
        amount: { amountMinor: 2000, currency: "USD" },
        reason: "Chipped rim",
      }),
    );
    deps.clock.timestamp = "2026-11-02T12:01:00Z";
    value(
      await new SendReply(deps).execute({
        requestId: request.id,
        template: "Your refund is ready.",
        variables: {},
      }),
    );
    deps.clock.timestamp = "2026-11-02T12:02:00Z";
    value(
      await new CreateReplacementOrder(deps).execute({ orderId: order.id }),
    );
    value(await new GenerateReturnLabel(deps).execute({ orderId: order.id }));
    value(
      await new TagRequest(deps).execute({
        requestId: request.id,
        tag: "handled",
      }),
    );
    value(
      await new Escalate(deps).execute({
        requestId: request.id,
        reason: "Review packaging",
      }),
    );
    deps.clock.timestamp = "2026-11-02T12:03:00Z";
    value(
      await new SetRequestStatus(deps).execute({
        requestId: request.id,
        status: "resolved",
      }),
    );
    const query = new GetRequestActivity(deps.shop);
    const events = value(await query.execute({ requestId: request.id }));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "refund",
          amount: { amountMinor: 2000, currency: "USD" },
          reason: "Chipped rim",
        }),
        expect.objectContaining({
          kind: "reply",
          bodyExcerpt: "Your refund is ready.",
        }),
        expect.objectContaining({
          kind: "replacement",
          items: [{ name: "Sand mug", quantity: 2 }],
        }),
        expect.objectContaining({ kind: "return_label" }),
        expect.objectContaining({
          kind: "recorded_state",
          status: "resolved",
          tags: ["handled"],
        }),
        expect.objectContaining({
          kind: "escalation",
          reason: "Review packaging",
        }),
      ]),
    );
    expect(events.map((event) => Date.parse(event.at))).toEqual(
      events.map((event) => Date.parse(event.at)).sort((a, b) => b - a),
    );
    expect(value(await query.execute({ requestId: request.id }))).toEqual(
      events,
    );
  });

  it("scopes records to the request and its order and supports orderless inquiries", async () => {
    const deps = setup();
    deps.shop.requests.set("req_inquiry", {
      ...request,
      id: "req_inquiry",
      orderId: null,
    });
    const reply = value(
      await new SendReply(deps).execute({
        requestId: "req_inquiry",
        template: "Wholesale details",
        variables: {},
      }),
    );
    value(
      await new IssueRefund(deps).execute({
        orderId: order.id,
        reason: "Other request",
      }),
    );
    expect(
      value(
        await new GetRequestActivity(deps.shop).execute({
          requestId: "req_inquiry",
        }),
      ),
    ).toEqual([
      {
        id: reply.id,
        at: reply.createdAt,
        kind: "reply",
        bodyExcerpt: "Wholesale details",
      },
      { id: "req_inquiry", at: request.createdAt, kind: "request_received" },
    ]);
    expect(
      value(
        await new GetRequestActivity(deps.shop).execute({
          requestId: request.id,
        }),
      ).some((event) => event.kind === "reply"),
    ).toBe(false);
  });

  it("limits reply excerpts without splitting Unicode characters or mutating stored bodies", async () => {
    const deps = setup();
    const body = "🍵".repeat(300);
    value(
      await new SendReply(deps).execute({
        requestId: request.id,
        template: body,
        variables: {},
      }),
    );
    const event = value(
      await new GetRequestActivity(deps.shop).execute({
        requestId: request.id,
      }),
    ).find((item) => item.kind === "reply");
    expect(event).toMatchObject({ bodyExcerpt: `${"🍵".repeat(240)}…` });
    expect(deps.shop.replies[0]?.body).toBe(body);
  });
});
