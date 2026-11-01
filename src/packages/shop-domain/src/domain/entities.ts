import type {
  CustomerId, OrderId, ProductId, RefundId, ReplyId, RequestId, ReturnLabelId, ShipmentId,
} from "./ids.js";
import type { Money } from "./money.js";

/** ISO-8601 timestamps in UTC, serialized by the application clock. */
export type Timestamp = string;

export interface Address {
  readonly name: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

export interface Customer {
  readonly id: CustomerId;
  readonly name: string;
  readonly email: string;
  readonly shippingAddress: Address;
}

export interface Product {
  readonly id: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly price: Money;
}

export interface OrderLineItem {
  readonly productId: ProductId;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: Money;
}

export interface ReplacementItemSelection {
  readonly productId: ProductId;
  readonly quantity: number;
}

export type OrderStatus = "unshipped" | "shipped" | "delivered" | "cancelled";

export interface ReturnLabel {
  readonly id: ReturnLabelId;
  readonly orderId: OrderId;
  readonly createdAt: Timestamp;
  readonly fromAddress: Address;
}

export interface Order {
  readonly id: OrderId;
  readonly customerId: CustomerId;
  readonly items: readonly OrderLineItem[];
  readonly total: Money;
  readonly paid: Money;
  readonly status: OrderStatus;
  readonly shippingAddress: Address;
  readonly createdAt: Timestamp;
  readonly deliveredAt: Timestamp | null;
  readonly replacementForOrderId: OrderId | null;
  readonly returnLabel: ReturnLabel | null;
}

export type ShipmentStatus = "pending" | "in_transit" | "delivered" | "exception" | "cancelled";

export interface Shipment {
  readonly id: ShipmentId;
  readonly orderId: OrderId;
  readonly status: ShipmentStatus;
  readonly carrier: string;
  readonly trackingNumber: string | null;
  readonly shippedAt: Timestamp | null;
  readonly deliveredAt: Timestamp | null;
  readonly estimatedDeliveryAt: Timestamp | null;
}

export const REQUEST_TYPES = [
  "damaged_item", "where_is_my_order", "return", "address_change", "wholesale_inquiry",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_STATUSES = ["open", "pending", "resolved", "escalated"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type StructuredRequestFields =
  | { readonly type: "damaged_item"; readonly orderId: OrderId; readonly productId: ProductId; readonly quantity: number; readonly description: string }
  | { readonly type: "where_is_my_order"; readonly orderId: OrderId }
  | { readonly type: "return"; readonly orderId: OrderId; readonly reason: string }
  | { readonly type: "address_change"; readonly orderId: OrderId; readonly address: Address }
  | { readonly type: "wholesale_inquiry"; readonly company: string; readonly message: string };

export type RequestContent =
  | { readonly source: "structured"; readonly fields: StructuredRequestFields }
  | { readonly source: "free_text"; readonly text: string; readonly type: RequestType | null };

export interface Escalation {
  readonly reason: string;
  readonly escalatedAt: Timestamp;
}

export interface Request {
  readonly id: RequestId;
  readonly customerId: CustomerId;
  readonly orderId: OrderId | null;
  readonly subject: string;
  readonly content: RequestContent;
  readonly status: RequestStatus;
  readonly tags: readonly string[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly escalation: Escalation | null;
}

export interface Refund {
  readonly id: RefundId;
  readonly orderId: OrderId;
  readonly amount: Money;
  readonly reason: string;
  readonly createdAt: Timestamp;
}

export interface Reply {
  readonly id: ReplyId;
  readonly requestId: RequestId;
  readonly customerId: CustomerId;
  readonly to: string;
  readonly template: string;
  readonly variables: Readonly<Record<string, string | number>>;
  readonly body: string;
  readonly createdAt: Timestamp;
}

export interface RequestFilter {
  readonly status?: RequestStatus;
  readonly type?: RequestType;
  readonly customerId?: CustomerId;
  readonly tag?: string;
}

export function requestType(request: Request): RequestType | null {
  return request.content.source === "structured" ? request.content.fields.type : request.content.type;
}
