# Shop domain

Pure TypeScript entities, policies, and application use-cases for Kiln & Co.
The package entrypoint exports all entities, `Result<T>`, policy functions,
ports, and use-case classes. Call `execute(input)` and handle the discriminated
`ok` result. Policy and input failures are typed `ShopError` values; storage
exceptions propagate to the infrastructure boundary.

## Data conventions

- Money uses non-negative safe integer `amountMinor` values and uppercase
  three-letter currency codes. Use `money()` when constructing values. USD
  amounts are cents. Policies validate money again before issuing refunds.
- IDs use kind-specific prefixes (`cus`, `prd`, `ord`, `shp`, `req`, `ref`,
  `rpl`, `lbl`) and lowercase alphanumeric suffixes, up to 31 characters.
  `parseShopId()` validates boundary input; generated IDs are also validated.
- Entities are readonly, JSON-serializable snapshots, with UTC ISO timestamps.
  Adapters must return detached snapshots and preserve line-item prices and
  quantities as purchased. `total` is the item/order value; `paid` is the actual
  payment and is the only basis for refundable balance.
- Requests preserve original structured fields or free text. Free text may
  have a known category or `null` until classified; wholesale requests need
  no order. `Request.orderId` and structured `fields.orderId`, when present,
  must agree when an intake adapter constructs a request.

## Policy behavior

- Omitting `IssueRefund.amount` refunds the remaining payment after prior
  refunds. Explicit amounts must be positive and in the payment's currency.
  Refunds do not require return eligibility: damage refunds and returns are
  separate operations.
- Return labels can first be issued for delivered orders through exactly
  30 elapsed days after `Order.deliveredAt`, inclusive. Existing labels are
  returned on repeat calls, even after that issuance window closes.
- Shipping-address changes require `Order.status === "unshipped"` and either
  no shipment or a pending shipment with no `shippedAt` timestamp. The customer
  address book is unaffected.
- `isWithinAutoRefundLimit()` exposes the inclusive USD 100 threshold for
  callers. Shop use-cases enforce payment limits; agent/recipe approval gates
  enforce approval rules.
- Replacement orders accept optional `items: [{ productId, quantity }]`, defaulting
  to all original lines. Selected products must exist on the original order,
  without duplicates, and quantities must be positive integers no greater than
  the ordered quantity. Empty selections and cancelled originals are rejected
  (`INVALID_INPUT` and `ORDER_CANCELLED`, respectively). Lines retain their
  original purchased unit prices; `total` is the sum for only the selected
  quantities. Shipping details and `replacementForOrderId` are retained, and
  replacements start unshipped with zero additional payment. They cannot refund
  the original payment.
- `SendReply` stores an outbound demo reply, recipient, original template,
  variables, and rendered body. Templates accept literal `{{variable}}`
  placeholders, including surrounding whitespace. There is no expression
  evaluation or recursive substitution; missing variables fail before a write.
- `Escalate` records a reason and timestamp and sets status `escalated`.
  Use it for the first escalation; `SetRequestStatus` preserves escalation
  history when reopening or resolving a request. Tags are trimmed and deduplicated.
- Return labels are synthetic demo records embedded in the order, not purchased
  carrier labels. Replies are stored demo replies, not external email delivery.

## Persistence adapter contract (TASK-6)

Implement `ShopRepository` and inject it into the use-case constructors.
Read-only use-cases accept the repository directly; mutations accept an object
with `shop`, and the `clock`/`ids` ports where needed. `Clock.now()` returns an
ISO timestamp, and `IdGenerator.next(kind)` returns a unique short identifier.

`transaction()` must provide atomic, serializable execution relative to other
mutations, including shipment changes. Commit an `ok` result; roll back an
error result or exception. This prevents competing refunds from exceeding
payment and prevents an address update racing with shipment dispatch. Database
adapters can use a transaction and appropriate locking/serialization. The
test-only in-memory adapter serializes callbacks and restores writes on failure.
Creation methods must enforce unique IDs; save methods update existing records.

`listRequests()` applies all supplied filters together (status, category,
customer, exact tag); category works for both request sources and excludes
unclassified free text when filtering by type. No shipment is represented by
`null`, distinct from a missing order, which returns `NOT_FOUND`.

No framework, DB, network, LLM, or environment dependencies belong here.
Actions and tracing decorators, database adapters, event emission, and external
delivery belong in the web app and use the same application entrypoints for
human operators, agents, and recipes.
