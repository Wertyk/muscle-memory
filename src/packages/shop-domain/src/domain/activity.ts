import type { RequestStatus } from "./entities.js";
import type { OrderId, ReturnLabelId } from "./ids.js";
import type { Money } from "./money.js";

interface ActivityEntry {
  readonly id: string;
  readonly at: string;
}

/** Read model of durable shop records; no framework audit or session-only results. */
export type RequestActivity = ActivityEntry &
  (
    | { readonly kind: "request_received" }
    | { readonly kind: "order_placed"; readonly orderId: OrderId }
    | { readonly kind: "dispatched"; readonly carrier: string }
    | { readonly kind: "delivered" }
    | { readonly kind: "reply"; readonly bodyExcerpt: string }
    | {
        readonly kind: "refund";
        readonly amount: Money;
        readonly reason: string;
      }
    | {
        readonly kind: "replacement";
        readonly orderId: OrderId;
        readonly items: readonly {
          readonly name: string;
          readonly quantity: number;
        }[];
      }
    | { readonly kind: "return_label"; readonly labelId: ReturnLabelId }
    | {
        readonly kind: "recorded_state";
        readonly status: RequestStatus;
        readonly tags: readonly string[];
      }
    | { readonly kind: "escalation"; readonly reason: string }
  );
