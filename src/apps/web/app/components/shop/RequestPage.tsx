import type { CorrectionEvidence } from "@shared/corrections";
import { CorrectionsPanel } from "../recipes/CorrectionsPanel";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  requestType,
  type Address,
  type Customer,
  type Order,
  type Request,
  type Shipment,
} from "@muscle-memory/shop-domain";
import {
  IconArrowLeft,
  IconCheck,
  IconMail,
  IconPackage,
  IconTruck,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dateText, INBOX_PATH, moneyText } from "@/lib/shop-workspace";

import type { SavedResult } from "./ActionForm";
import { ActivityTimeline } from "./ActivityTimeline";
import { OrderOperations } from "./OrderOperations";
import { ReplyForm, RequestControls, TagForm } from "./RequestControls";
import { RequestProcessingBanner } from "./RequestProcessingBanner";
import { TeachBar } from "./TeachBar";
import { CrystallizeRunControl } from "./CrystallizeRunControl";
import {
  QueryError,
  ShopMasthead,
  StatusChip,
  WorkspaceLoading,
} from "./WorkspaceParts";

export function AddressText({ address }: { address: Address }) {
  return (
    <address className="break-words text-sm not-italic leading-relaxed">
      {address.name}
      <br />
      {address.line1}
      {address.line2 && (
        <>
          <br />
          {address.line2}
        </>
      )}
      <br />
      {address.city}, {address.region} {address.postalCode}
      <br />
      {address.countryCode}
    </address>
  );
}

function OriginalContent({
  request,
  order,
}: {
  request: Request;
  order: Order | undefined;
}) {
  const t = useT();
  if (request.content.source === "free_text")
    return <p className="shop-message-body">{request.content.text}</p>;
  const fields = request.content.fields;
  const product =
    fields.type === "damaged_item"
      ? order?.items.find((item) => item.productId === fields.productId)
      : undefined;
  return (
    <dl className="shop-form-fields">
      {"orderId" in fields && (
        <div>
          <dt>{t("shop.order")}</dt>
          <dd className="font-mono">{fields.orderId}</dd>
        </div>
      )}
      {fields.type === "damaged_item" && (
        <>
          <div>
            <dt>{t("shop.product")}</dt>
            <dd>
              {product?.name ?? fields.productId} ·{" "}
              {t("shop.quantity", { count: fields.quantity })}
              {product && (
                <span className="mt-1 block font-mono text-xs text-muted-foreground">
                  {fields.productId}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("shop.description")}</dt>
            <dd>{fields.description}</dd>
          </div>
        </>
      )}
      {fields.type === "return" && (
        <div>
          <dt>{t("shop.reason")}</dt>
          <dd>{fields.reason}</dd>
        </div>
      )}
      {fields.type === "address_change" && (
        <div>
          <dt>{t("shop.requestedAddress")}</dt>
          <dd>
            <AddressText address={fields.address} />
          </dd>
        </div>
      )}
      {fields.type === "wholesale_inquiry" && (
        <>
          <div>
            <dt>{t("shop.company")}</dt>
            <dd>{fields.company}</dd>
          </div>
          <div>
            <dt>{t("shop.message")}</dt>
            <dd>{fields.message}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

function CustomerPanel({ id }: { id: string }) {
  const t = useT();
  const customer = useActionQuery<Customer>(
    "get-customer",
    { customerId: id },
    { resources: ["shop"] },
  );
  return (
    <section className="shop-panel">
      <h2>{t("shop.customer")}</h2>
      {customer.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : customer.isError && !customer.data ? (
        <QueryError
          error={customer.error}
          retry={() => void customer.refetch()}
        />
      ) : (
        <>
          {customer.isError && (
            <QueryError
              stale
              error={customer.error}
              retry={() => void customer.refetch()}
            />
          )}
          <p className="font-medium">{customer.data?.name}</p>
          <p className="mt-1 break-all text-sm text-muted-foreground">
            {customer.data?.email}
          </p>
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            {id}
          </p>
        </>
      )}
    </section>
  );
}

function OrderPanel({
  order,
  request,
  onSaved,
}: {
  order: Order;
  request: Request;
  onSaved: (result: SavedResult) => void;
}) {
  const t = useT();
  return (
    <section className="shop-panel">
      <div className="shop-section-heading">
        <h2>
          <IconPackage className="size-4" aria-hidden="true" />
          {t("shop.order")}
        </h2>
        <OrderOperations order={order} request={request} onSaved={onSaved} />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{order.id}</span>
        <span className="shop-tag">
          {t(`shop.orderStatuses.${order.status}`)}
        </span>
      </div>
      <ul className="shop-order-items">
        {order.items.map((item) => (
          <li key={item.productId}>
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("shop.quantity", { count: item.quantity })} ·{" "}
                {moneyText(item.unitPrice)}
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums">
              {moneyText({
                amountMinor: item.quantity * item.unitPrice.amountMinor,
                currency: item.unitPrice.currency,
              })}
            </span>
          </li>
        ))}
      </ul>
      <dl className="shop-order-totals">
        <div>
          <dt>{t("shop.total")}</dt>
          <dd>{moneyText(order.total)}</dd>
        </div>
        <div>
          <dt>{t("shop.paid")}</dt>
          <dd>{moneyText(order.paid)}</dd>
        </div>
      </dl>
      <details className="shop-disclosure mt-5">
        <summary>{t("shop.shippingAddress")}</summary>
        <div className="mt-3">
          <AddressText address={order.shippingAddress} />
        </div>
      </details>
      {order.returnLabel && (
        <p className="shop-inline-note mt-4">
          {t("shop.labelId", { id: order.returnLabel.id })}
        </p>
      )}
    </section>
  );
}

export function RequestPage({ requestId }: { requestId: string }) {
  const t = useT();
  const [saved, setSaved] = useState<SavedResult | null>(null);
  const query = useActionQuery<Request & CorrectionEvidence>(
    "get-request",
    { requestId },
    { resources: ["shop"] },
  );
  const request = query.data;
  const order = useActionQuery<Order>(
    "get-order",
    { orderId: request?.orderId ?? "" },
    { enabled: Boolean(request?.orderId), resources: ["shop"] },
  );
  const shipment = useActionQuery<{
    orderStatus: string;
    shipment: Shipment | null;
  }>(
    "get-shipment-status",
    { orderId: request?.orderId ?? "" },
    { enabled: Boolean(request?.orderId), resources: ["shop"] },
  );
  if (query.isPending) return <WorkspaceLoading detail />;
  if (!request)
    return (
      <div className="shop-page">
        <ShopMasthead />
        <Button asChild variant="ghost">
          <Link to={INBOX_PATH}>
            <IconArrowLeft />
            {t("shop.back")}
          </Link>
        </Button>
        <QueryError error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <div className="shop-page shop-request-page">
      <ShopMasthead />
      <Link className="shop-back-link" to={INBOX_PATH}>
        <IconArrowLeft className="size-4" aria-hidden="true" />
        {t("shop.back")}
      </Link>
      {query.isError && (
        <QueryError
          stale
          error={query.error}
          retry={() => void query.refetch()}
        />
      )}
      <header className="shop-request-heading">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            {request.id}
          </span>
          <span className="shop-type-label">
            {t(`shop.types.${requestType(request) ?? "unknown"}`)}
          </span>
          <StatusChip status={request.status} />
        </div>
        <h1 className="shop-serif">{request.subject}</h1>
        <div className="mt-5">
          <RequestControls request={request} onSaved={setSaved} />
        </div>
      </header>
      <RequestProcessingBanner requestId={requestId} />
      <CorrectionsPanel corrections={request.corrections} />
      <CrystallizeRunControl request={request} />
      <TeachBar key={request.id} request={request} order={order.data} />
      <div role="status" aria-live="polite">
        {saved && (
          <div className="shop-saved-result">
            <IconCheck className="size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{saved.title}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {saved.detail}
              </p>
            </div>
            <Button
              className="ms-auto shrink-0"
              size="xs"
              variant="ghost"
              aria-label={t("shop.close")}
              onClick={() => setSaved(null)}
            >
              ×
            </Button>
          </div>
        )}
      </div>
      <div className="shop-request-grid">
        <div className="shop-conversation">
          <section className="shop-panel shop-original-message">
            <div className="shop-section-heading">
              <h2>
                <IconMail className="size-4" aria-hidden="true" />
                {t(
                  request.content.source === "free_text"
                    ? "shop.message"
                    : "shop.formSubmission",
                )}
              </h2>
              <time
                dateTime={request.createdAt}
                className="text-xs text-muted-foreground"
              >
                {dateText(request.createdAt)}
              </time>
            </div>
            <OriginalContent request={request} order={order.data} />
            <div className="mt-6">
              <TagForm request={request} onSaved={setSaved} />
            </div>
          </section>
          <ReplyForm request={request} onSaved={setSaved} />
          <ActivityTimeline requestId={requestId} />
        </div>
        <aside className="shop-order-sidebar">
          <CustomerPanel id={request.customerId} />
          {!request.orderId ? (
            <section className="shop-panel">
              <h2>{t("shop.noOrder")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("shop.noOrderHint")}
              </p>
            </section>
          ) : (
            <>
              {order.isPending ? (
                <section className="shop-panel">
                  <Skeleton className="h-44 w-full" />
                </section>
              ) : !order.data ? (
                <QueryError
                  error={order.error}
                  retry={() => void order.refetch()}
                />
              ) : (
                <>
                  {order.isError && (
                    <QueryError
                      stale
                      error={order.error}
                      retry={() => void order.refetch()}
                    />
                  )}
                  <OrderPanel
                    order={order.data}
                    request={request}
                    onSaved={setSaved}
                  />
                </>
              )}
              <section className="shop-panel">
                <h2>
                  <IconTruck className="size-4" aria-hidden="true" />
                  {t("shop.shipment")}
                </h2>
                {shipment.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : !shipment.data ? (
                  <QueryError
                    error={shipment.error}
                    retry={() => void shipment.refetch()}
                  />
                ) : (
                  <>
                    {shipment.isError && (
                      <QueryError
                        stale
                        error={shipment.error}
                        retry={() => void shipment.refetch()}
                      />
                    )}
                    {shipment.data.shipment ? (
                      <>
                        <p className="text-sm font-medium">
                          {t(
                            `shop.shipmentStatuses.${shipment.data.shipment.status}`,
                          )}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {shipment.data.shipment.carrier}
                        </p>
                        <dl className="shop-form-fields mt-4">
                          {shipment.data.shipment.trackingNumber && (
                            <div>
                              <dt>{t("shop.tracking")}</dt>
                              <dd className="break-all font-mono text-xs">
                                {shipment.data.shipment.trackingNumber}
                              </dd>
                            </div>
                          )}
                          {shipment.data.shipment.estimatedDeliveryAt && (
                            <div>
                              <dt>{t("shop.estimate")}</dt>
                              <dd>
                                {dateText(
                                  shipment.data.shipment.estimatedDeliveryAt,
                                )}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("shop.noShipment")}
                      </p>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
