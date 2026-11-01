import {
  ID_PREFIXES, requestType, type Address, type Customer, type CustomerId, type IdKind,
  type Order, type OrderId, type Product, type ProductId, type Refund, type Reply,
  type Request, type RequestFilter, type RequestId, type Result, type Shipment,
} from "../src/domain/index.js";
import type { Clock, IdGenerator, ShopRecords, ShopRepository } from "../src/application/ports.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FixedClock implements Clock {
  constructor(public timestamp = "2026-11-02T12:00:00.000Z") {}
  now(): string { return this.timestamp; }
}

export class SequentialIds implements IdGenerator {
  private sequence = 100;
  next(kind: IdKind): string {
    return `${ID_PREFIXES[kind]}_${++this.sequence}`;
  }
}

/** Test-only adapter: detached snapshots, serialized transactions, rollback on errors. */
export class InMemoryShop implements ShopRepository {
  customers = new Map<CustomerId, Customer>();
  products = new Map<ProductId, Product>();
  orders = new Map<OrderId, Order>();
  requests = new Map<RequestId, Request>();
  shipments = new Map<OrderId, Shipment>();
  refunds: Refund[] = [];
  replies: Reply[] = [];
  private pending: Promise<unknown> = Promise.resolve();

  async listRequests(filter: RequestFilter): Promise<readonly Request[]> {
    return clone([...this.requests.values()].filter((request) =>
      (!filter.status || request.status === filter.status) &&
      (!filter.type || requestType(request) === filter.type) &&
      (!filter.customerId || request.customerId === filter.customerId) &&
      (!filter.tag || request.tags.includes(filter.tag)),
    ));
  }
  async getRequest(id: RequestId): Promise<Request | null> { return clone(this.requests.get(id) ?? null); }
  async saveRequest(request: Request): Promise<void> { this.requests.set(request.id, clone(request)); }
  async getCustomer(id: CustomerId): Promise<Customer | null> { return clone(this.customers.get(id) ?? null); }
  async getProduct(id: ProductId): Promise<Product | null> { return clone(this.products.get(id) ?? null); }
  async getOrder(id: OrderId): Promise<Order | null> { return clone(this.orders.get(id) ?? null); }
  async createOrder(order: Order): Promise<void> {
    if (this.orders.has(order.id)) throw new Error("Duplicate order ID");
    await this.saveOrder(order);
  }
  async saveOrder(order: Order): Promise<void> { this.orders.set(order.id, clone(order)); }
  async getShipmentForOrder(orderId: OrderId): Promise<Shipment | null> { return clone(this.shipments.get(orderId) ?? null); }
  async listRefundsForOrder(orderId: OrderId): Promise<readonly Refund[]> {
    return clone(this.refunds.filter((refund) => refund.orderId === orderId));
  }
  async createRefund(refund: Refund): Promise<void> {
    if (this.refunds.some((existing) => existing.id === refund.id)) throw new Error("Duplicate refund ID");
    this.refunds.push(clone(refund));
  }
  async createReply(reply: Reply): Promise<void> {
    if (this.replies.some((existing) => existing.id === reply.id)) throw new Error("Duplicate reply ID");
    this.replies.push(clone(reply));
  }

  transaction<T>(work: (records: ShopRecords) => Promise<Result<T>>): Promise<Result<T>> {
    const operation = this.pending.then(async () => {
      const orders = new Map(clone([...this.orders]));
      const requests = new Map(clone([...this.requests]));
      const refunds = clone(this.refunds);
      const replies = clone(this.replies);
      const rollback = () => { this.orders = orders; this.requests = requests; this.refunds = refunds; this.replies = replies; };
      try {
        const result = await work(this);
        if (!result.ok) rollback();
        return result;
      } catch (error) {
        rollback();
        throw error;
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}

export const address: Address = {
  name: "Avery Reed", line1: "12 Clay Lane", city: "Portland", region: "OR",
  postalCode: "97201", countryCode: "US",
};

export const customer: Customer = { id: "cus_0001", name: "Avery Reed", email: "avery@example.test", shippingAddress: address };
export const product: Product = { id: "prd_0001", sku: "MUG-SAND", name: "Sand mug", price: { amountMinor: 4_000, currency: "USD" } };
export const order: Order = {
  id: "ord_1042", customerId: customer.id,
  items: [{ productId: product.id, name: product.name, quantity: 2, unitPrice: product.price }],
  total: { amountMinor: 8_000, currency: "USD" }, paid: { amountMinor: 8_000, currency: "USD" },
  status: "delivered", shippingAddress: address, createdAt: "2026-10-10T12:00:00.000Z",
  deliveredAt: "2026-10-15T12:00:00.000Z", replacementForOrderId: null, returnLabel: null,
};
export const request: Request = {
  id: "req_0007", customerId: customer.id, orderId: order.id, subject: "Broken mug",
  content: { source: "structured", fields: { type: "damaged_item", orderId: order.id, productId: product.id, quantity: 1, description: "Handle broke in transit" } },
  status: "open", tags: [], createdAt: "2026-11-01T12:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z", escalation: null,
};
export const shipment: Shipment = {
  id: "shp_1042", orderId: order.id, status: "delivered", carrier: "Demo Parcel", trackingNumber: "TRACK1042",
  shippedAt: "2026-10-11T12:00:00.000Z", deliveredAt: order.deliveredAt, estimatedDeliveryAt: order.deliveredAt,
};

export function setup() {
  const shop = new InMemoryShop();
  shop.customers.set(customer.id, clone(customer));
  shop.products.set(product.id, clone(product));
  shop.orders.set(order.id, clone(order));
  shop.requests.set(request.id, clone(request));
  shop.shipments.set(order.id, clone(shipment));
  const clock = new FixedClock();
  const ids = new SequentialIds();
  return { shop, clock, ids };
}
