import {
  notFound,
  success,
  type RequestActivity,
  type RequestId,
  type Result,
} from "../domain/index.js";
import type { ShopRepository } from "./ports.js";

export class GetRequestActivity {
  constructor(
    private readonly shop: Pick<ShopRepository, "getRequestActivityRecords">,
  ) {}

  async execute(input: {
    readonly requestId: RequestId;
  }): Promise<Result<readonly RequestActivity[]>> {
    const records = await this.shop.getRequestActivityRecords(input.requestId);
    if (!records) return notFound("request", input.requestId);
    const { request, order, shipment, replies, refunds, replacements } =
      records;
    const activity: RequestActivity[] = [
      { id: request.id, at: request.createdAt, kind: "request_received" },
    ];
    if (order)
      activity.push({
        id: order.id,
        at: order.createdAt,
        kind: "order_placed",
        orderId: order.id,
      });
    if (shipment?.shippedAt)
      activity.push({
        id: shipment.id,
        at: shipment.shippedAt,
        kind: "dispatched",
        carrier: shipment.carrier,
      });
    if (order?.deliveredAt)
      activity.push({
        id: `del_${order.id}`,
        at: order.deliveredAt,
        kind: "delivered",
      });
    for (const reply of replies) {
      const text = Array.from(reply.body);
      activity.push({
        id: reply.id,
        at: reply.createdAt,
        kind: "reply",
        bodyExcerpt:
          text.length > 240 ? `${text.slice(0, 240).join("")}…` : reply.body,
      });
    }
    for (const refund of refunds)
      activity.push({
        id: refund.id,
        at: refund.createdAt,
        kind: "refund",
        amount: { ...refund.amount },
        reason: refund.reason,
      });
    for (const replacement of replacements)
      activity.push({
        id: replacement.id,
        at: replacement.createdAt,
        kind: "replacement",
        orderId: replacement.id,
        items: replacement.items.map(({ name, quantity }) => ({
          name,
          quantity,
        })),
      });
    if (order?.returnLabel)
      activity.push({
        id: order.returnLabel.id,
        at: order.returnLabel.createdAt,
        kind: "return_label",
        labelId: order.returnLabel.id,
      });
    if (request.escalation)
      activity.push({
        id: `esc_${request.id}`,
        at: request.escalation.escalatedAt,
        kind: "escalation",
        reason: request.escalation.reason,
      });
    if (request.status !== "open" || request.tags.length)
      activity.push({
        id: `state_${request.id}`,
        at: request.updatedAt,
        kind: "recorded_state",
        status: request.status,
        tags: [...request.tags],
      });
    return success(
      activity.sort(
        (a, b) =>
          Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id),
      ),
    );
  }
}
