import type {
  Customer, CustomerId, IdKind, Order, OrderId, Product, ProductId, Refund, Reply,
  Request, RequestFilter, RequestId, Result, Shipment,
} from "../domain/index.js";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(kind: IdKind): string;
}

/** Records available inside a transaction; adapters return detached snapshots. */
export interface ShopRecords {
  listRequests(filter: RequestFilter): Promise<readonly Request[]>;
  getRequest(id: RequestId): Promise<Request | null>;
  saveRequest(request: Request): Promise<void>;
  getCustomer(id: CustomerId): Promise<Customer | null>;
  getProduct(id: ProductId): Promise<Product | null>;
  getOrder(id: OrderId): Promise<Order | null>;
  createOrder(order: Order): Promise<void>;
  saveOrder(order: Order): Promise<void>;
  getShipmentForOrder(orderId: OrderId): Promise<Shipment | null>;
  listRefundsForOrder(orderId: OrderId): Promise<readonly Refund[]>;
  createRefund(refund: Refund): Promise<void>;
  createReply(reply: Reply): Promise<void>;
}

export interface ShopRepository extends ShopRecords {
  getRequestActivityRecords(requestId: RequestId): Promise<RequestActivityRecords | null>;
  /**
   * Atomic, serializable with competing writes (including shipment changes).
   * Commit only an ok result; roll back an error result or exception. Unique IDs
   * must be enforced by create methods. Never retry callbacks with side effects.
   */
  transaction<T>(work: (records: ShopRecords) => Promise<Result<T>>): Promise<Result<T>>;
}

export interface RequestActivityRecords {
  readonly request: Request;
  readonly order: Order | null;
  readonly shipment: Shipment | null;
  readonly replies: readonly Reply[];
  readonly refunds: readonly Refund[];
  readonly replacements: readonly Order[];
}

export interface ShopDependencies {
  readonly shop: ShopRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
