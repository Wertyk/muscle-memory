import {
  checkAddressChange, checkRefund, checkReturnWindow, invalidInput, money, notFound,
  parseShopId, refundableBalance, replacementContents, REQUEST_STATUSES, success, validateAddress,
  type Address, type Customer, type CustomerId, type IdKind, type Money, type Order,
  type OrderId, type Refund, type Reply, type Request, type RequestFilter, type RequestId,
  type ReplacementItemSelection, type RequestStatus, type Result, type ReturnLabel, type Shipment, type ShopId,
} from "../domain/index.js";
import type { Clock, IdGenerator, ShopDependencies, ShopRecords, ShopRepository } from "./ports.js";
import { renderReplyTemplate } from "./templates.js";

function now(clock: Clock): Result<string> {
  const value = clock.now();
  return Number.isFinite(Date.parse(value))
    ? success(new Date(value).toISOString())
    : invalidInput("clock", "Expected a valid timestamp");
}

function nextId<K extends IdKind>(ids: IdGenerator, kind: K): Result<ShopId<K>> {
  return parseShopId(kind, ids.next(kind));
}

async function findOrder(shop: ShopRecords, id: OrderId): Promise<Result<Order>> {
  const order = await shop.getOrder(id);
  return order ? success(order) : notFound("order", id);
}

async function findRequest(shop: ShopRecords, id: RequestId): Promise<Result<Request>> {
  const request = await shop.getRequest(id);
  return request ? success(request) : notFound("request", id);
}

export class ListRequests {
  constructor(private readonly shop: Pick<ShopRecords, "listRequests">) {}
  async execute(filter: RequestFilter = {}): Promise<Result<readonly Request[]>> {
    return success(await this.shop.listRequests(filter));
  }
}

export class GetRequest {
  constructor(private readonly shop: ShopRecords) {}
  execute(input: { readonly requestId: RequestId }): Promise<Result<Request>> {
    return findRequest(this.shop, input.requestId);
  }
}

export class GetOrder {
  constructor(private readonly shop: ShopRecords) {}
  execute(input: { readonly orderId: OrderId }): Promise<Result<Order>> {
    return findOrder(this.shop, input.orderId);
  }
}

export class GetCustomer {
  constructor(private readonly shop: Pick<ShopRecords, "getCustomer">) {}
  async execute(input: { readonly customerId: CustomerId }): Promise<Result<Customer>> {
    const customer = await this.shop.getCustomer(input.customerId);
    return customer ? success(customer) : notFound("customer", input.customerId);
  }
}

export class GetShipmentStatus {
  constructor(private readonly shop: ShopRecords) {}
  async execute(input: { readonly orderId: OrderId }): Promise<Result<{ readonly orderStatus: Order["status"]; readonly shipment: Shipment | null }>> {
    const order = await findOrder(this.shop, input.orderId);
    if (!order.ok) return order;
    return success({ orderStatus: order.value.status, shipment: await this.shop.getShipmentForOrder(input.orderId) });
  }
}

export class IssueRefund {
  constructor(private readonly deps: ShopDependencies) {}
  /** Omitting amount refunds the entire remaining balance, after prior refunds. */
  execute(input: { readonly orderId: OrderId; readonly amount?: Money; readonly reason: string }): Promise<Result<Refund>> {
    return this.deps.shop.transaction(async (shop) => {
      const order = await findOrder(shop, input.orderId);
      if (!order.ok) return order;
      if (!input.reason.trim()) return invalidInput("reason", "Refund reason is required");
      const refunds = await shop.listRefundsForOrder(input.orderId);
      const balance = refundableBalance(order.value, refunds);
      if (!balance.ok) return balance;
      const amount = checkRefund(order.value, refunds, input.amount ?? balance.value);
      if (!amount.ok) return amount;
      const id = nextId(this.deps.ids, "refund");
      if (!id.ok) return id;
      const createdAt = now(this.deps.clock);
      if (!createdAt.ok) return createdAt;
      const refund: Refund = { id: id.value, orderId: input.orderId, amount: { ...amount.value }, reason: input.reason.trim(), createdAt: createdAt.value };
      await shop.createRefund(refund);
      return success(refund);
    });
  }
}

export class SendReply {
  constructor(private readonly deps: ShopDependencies) {}
  execute(input: { readonly requestId: RequestId; readonly template: string; readonly variables: Readonly<Record<string, string | number>> }): Promise<Result<Reply>> {
    return this.deps.shop.transaction(async (shop) => {
      const request = await findRequest(shop, input.requestId);
      if (!request.ok) return request;
      const customer = await shop.getCustomer(request.value.customerId);
      if (!customer) return notFound("customer", request.value.customerId);
      const body = renderReplyTemplate(input.template, input.variables);
      if (!body.ok) return body;
      const id = nextId(this.deps.ids, "reply");
      if (!id.ok) return id;
      const createdAt = now(this.deps.clock);
      if (!createdAt.ok) return createdAt;
      const reply: Reply = {
        id: id.value, requestId: input.requestId, customerId: customer.id, to: customer.email,
        template: input.template, variables: { ...input.variables }, body: body.value, createdAt: createdAt.value,
      };
      await shop.createReply(reply);
      return success(reply);
    });
  }
}

async function updateRequest(
  shop: ShopRepository, clock: Clock, requestId: RequestId,
  change: (request: Request, timestamp: string) => Result<Request>,
): Promise<Result<Request>> {
  return shop.transaction(async (records) => {
    const request = await findRequest(records, requestId);
    if (!request.ok) return request;
    const timestamp = now(clock);
    if (!timestamp.ok) return timestamp;
    const updated = change(request.value, timestamp.value);
    if (updated.ok) await records.saveRequest(updated.value);
    return updated;
  });
}

export class TagRequest {
  constructor(private readonly deps: Pick<ShopDependencies, "shop" | "clock">) {}
  execute(input: { readonly requestId: RequestId; readonly tag: string }): Promise<Result<Request>> {
    return updateRequest(this.deps.shop, this.deps.clock, input.requestId, (request, timestamp) => {
      const tag = input.tag.trim();
      if (!tag) return invalidInput("tag", "Tag is required");
      return success({ ...request, tags: request.tags.includes(tag) ? request.tags : [...request.tags, tag], updatedAt: timestamp });
    });
  }
}

export class SetRequestStatus {
  constructor(private readonly deps: Pick<ShopDependencies, "shop" | "clock">) {}
  execute(input: { readonly requestId: RequestId; readonly status: RequestStatus }): Promise<Result<Request>> {
    return updateRequest(this.deps.shop, this.deps.clock, input.requestId, (request, timestamp) => {
      if (!REQUEST_STATUSES.includes(input.status)) return invalidInput("status", "Unknown request status");
      if (input.status === "escalated" && !request.escalation) {
        return invalidInput("status", "Use Escalate to record an escalation reason");
      }
      return success({ ...request, status: input.status, updatedAt: timestamp });
    });
  }
}

export class Escalate {
  constructor(private readonly deps: Pick<ShopDependencies, "shop" | "clock">) {}
  execute(input: { readonly requestId: RequestId; readonly reason: string }): Promise<Result<Request>> {
    return updateRequest(this.deps.shop, this.deps.clock, input.requestId, (request, timestamp) => {
      if (!input.reason.trim()) return invalidInput("reason", "Escalation reason is required");
      return success({ ...request, status: "escalated", escalation: { reason: input.reason.trim(), escalatedAt: timestamp }, updatedAt: timestamp });
    });
  }
}

export class CreateReplacementOrder {
  constructor(private readonly deps: ShopDependencies) {}
  /** Replaces selected items (all original lines by default) at no additional charge. */
  execute(input: { readonly orderId: OrderId; readonly items?: readonly ReplacementItemSelection[] }): Promise<Result<Order>> {
    return this.deps.shop.transaction(async (shop) => {
      const original = await findOrder(shop, input.orderId);
      if (!original.ok) return original;
      const contents = replacementContents(original.value, input.items);
      if (!contents.ok) return contents;
      const id = parseShopId("order", await shop.nextSequentialId("order"));
      if (!id.ok) return id;
      const createdAt = now(this.deps.clock);
      if (!createdAt.ok) return createdAt;
      const paid = money(0, original.value.paid.currency);
      if (!paid.ok) return paid;
      const replacement: Order = {
        ...original.value, ...contents.value, id: id.value, paid: paid.value, status: "unshipped",
        shippingAddress: { ...original.value.shippingAddress }, createdAt: createdAt.value,
        deliveredAt: null, replacementForOrderId: original.value.id, returnLabel: null,
      };
      await shop.createOrder(replacement);
      return success(replacement);
    });
  }
}

export class UpdateShippingAddress {
  constructor(private readonly deps: Pick<ShopDependencies, "shop">) {}
  execute(input: { readonly orderId: OrderId; readonly address: Address }): Promise<Result<Order>> {
    return this.deps.shop.transaction(async (shop) => {
      const order = await findOrder(shop, input.orderId);
      if (!order.ok) return order;
      const allowed = checkAddressChange(order.value, await shop.getShipmentForOrder(input.orderId));
      if (!allowed.ok) return allowed;
      const address = validateAddress(input.address);
      if (!address.ok) return address;
      const updated: Order = { ...order.value, shippingAddress: address.value };
      await shop.saveOrder(updated);
      return success(updated);
    });
  }
}

export class GenerateReturnLabel {
  constructor(private readonly deps: ShopDependencies) {}
  /** Synthetic demo label record; carrier purchase/printing belongs in infrastructure. */
  execute(input: { readonly orderId: OrderId }): Promise<Result<ReturnLabel>> {
    return this.deps.shop.transaction(async (shop) => {
      const order = await findOrder(shop, input.orderId);
      if (!order.ok) return order;
      // An already-issued label stays available even after the issuance window closes.
      if (order.value.returnLabel) return success(order.value.returnLabel);
      const createdAt = now(this.deps.clock);
      if (!createdAt.ok) return createdAt;
      const allowed = checkReturnWindow(order.value, createdAt.value);
      if (!allowed.ok) return allowed;
      const id = nextId(this.deps.ids, "returnLabel");
      if (!id.ok) return id;
      const label: ReturnLabel = { id: id.value, orderId: input.orderId, createdAt: createdAt.value, fromAddress: { ...order.value.shippingAddress } };
      await shop.saveOrder({ ...order.value, returnLabel: label });
      return success(label);
    });
  }
}
