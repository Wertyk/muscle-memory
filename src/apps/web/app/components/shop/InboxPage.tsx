import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  REQUEST_STATUSES,
  REQUEST_TYPES,
  requestType,
  type Customer,
  type Request,
} from "@muscle-memory/shop-domain";
import { IconArrowUpRight, IconFilter } from "@tabler/icons-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router";
import { PROCESSING_STATES, type RequestProcessing } from "@shared/request-processing";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ageText, dateText, requestPath } from "@/lib/shop-workspace";
import { DemoIntakeControl } from "./DemoIntakeControl";
import { InboxHandling } from "../kiln/InboxHandling";
import { inboxOutcome, newArrivalIds } from "@/lib/kiln";

import {
  EmptyState,
  PendingMark,
  QueryError,
  ShopMasthead,
  StatusChip,
  WorkspaceLoading,
} from "./WorkspaceParts";

function CustomerName({ id }: { id: string }) {
  const t = useT();
  const query = useActionQuery<Customer>("get-customer", { customerId: id });
  if (query.isError)
    return (
      <span className="inline-flex items-center gap-1">
        <span>{t("shop.customerUnavailable")}</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void query.refetch()}
          aria-label={t("shop.retryCustomer")}
        >
          ↻
        </Button>
      </span>
    );
  return <span>{query.data?.name ?? id}</span>;
}

export function InboxPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const beforeIntake = useRef<readonly string[]>([]);
  const revealed = useRef<string[]>([]);
  const [arrivals, setArrivals] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!arrivals.length) return;
    const timer = setTimeout(() => setArrivals([]), 1500 + arrivals.length * 60);
    return () => clearTimeout(timer);
  }, [arrivals]);
  const status = REQUEST_STATUSES.find(
    (value) => value === params.get("status"),
  );
  const type = REQUEST_TYPES.find((value) => value === params.get("type"));
  const processing = PROCESSING_STATES.find((value) => value === params.get("processing"));
  const processingQuery = useActionQuery<readonly RequestProcessing[]>(
    "list-request-processing", {}, { placeholderData: (previous) => previous },
  );
  const query = useActionQuery<readonly Request[]>(
    "list-requests",
    {
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    { placeholderData: (previous) => previous },
  );
  function filter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === "all") next.delete(key);
      else next.set(key, value);
      return next;
    });
  }
  if (query.isPending || (processing && processingQuery.isPending)) return <WorkspaceLoading />;
  if (query.isError && !query.data)
    return (
      <div className="shop-page">
        <ShopMasthead />
        <QueryError error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  const processingById = new Map((processingQuery.data ?? []).map((row) => [row.requestId, row]));
  const requests = [...(query.data ?? [])].filter(
    (request) => !processing || processingById.get(request.id)?.state === processing,
  ).sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return (
    <div className="shop-page">
      <ShopMasthead />
      <header className="shop-page-heading">
        <h1 className="shop-serif">{t("shop.inbox")}</h1>
        <span
          className="flex items-center gap-2 text-sm tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {(query.isFetching || processingQuery.isFetching) && (
            <>
              <PendingMark />
              <span className="sr-only">{t("shop.updating")}</span>
            </>
          )}
          {t("shop.requestCount", { count: requests.length })}
        </span>
      </header>
      <DemoIntakeControl filters={{ status, type, processing }}
        onStart={() => { beforeIntake.current = (query.data ?? []).map(request => request.id); }}
        onArrived={(incoming, rows) => {
          const visible = incoming.filter(request => (!status || request.status === status) && (!type || requestType(request) === type) &&
            (!processing || rows.find(row => row.requestId === request.id)?.state === processing)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
          setArrivals(newArrivalIds(beforeIntake.current, visible.map(request => request.id), revealed.current));
          revealed.current = [...revealed.current, ...incoming.map(request => request.id)];
        }} />
      <div className="shop-filters">
        <IconFilter
          className="hidden size-4 text-muted-foreground sm:block"
          aria-hidden="true"
        />
        <Select
          value={status ?? "all"}
          onValueChange={(value) => filter("status", value)}
        >
          <SelectTrigger
            aria-label={t("shop.statusFilter")}
            className="w-full sm:w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("shop.allStatuses")}</SelectItem>
            {REQUEST_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`shop.statuses.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={type ?? "all"}
          onValueChange={(value) => filter("type", value)}
        >
          <SelectTrigger
            aria-label={t("shop.typeFilter")}
            className="w-full sm:w-52"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("shop.allTypes")}</SelectItem>
            {REQUEST_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`shop.types.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={processing ?? "all"} onValueChange={(value) => filter("processing", value)}>
          <SelectTrigger aria-label={t("shop.processingFilter")} className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("shop.allProcessing")}</SelectItem>
            {PROCESSING_STATES.map((value) => (
              <SelectItem key={value} value={value}>{t(`shop.processingStates.${value}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(status || type || processing) && (
          <Button size="sm" variant="ghost" onClick={() => setParams({})}>
            {t("shop.clearFilters")}
          </Button>
        )}
      </div>
      {query.isError && (
        <QueryError
          error={query.error}
          stale
          retry={() => void query.refetch()}
        />
      )}
      {processingQuery.isError && (
        <QueryError error={processingQuery.error} stale={Boolean(processingQuery.data)} retry={() => void processingQuery.refetch()} />
      )}
      {processingQuery.isPending && <p role="status" className="mb-4 text-xs text-muted-foreground">{t("shop.loadingProcessing")}</p>}
      {requests.length === 0 ? (
        !(processing && processingQuery.isError) && <EmptyState
          title={t(
            status || type || processing ? "shop.noRequestsFiltered" : "shop.noRequests",
          )}
        >
          {!(status || type || processing) && (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("shop.noRequestsHint")}
            </p>
          )}
        </EmptyState>
      ) : (
        <div className="shop-inbox-list" aria-busy={query.isFetching || processingQuery.isFetching}>
          <div className="shop-inbox-columns" aria-hidden="true">
            <span>{t("shop.request")}</span>
            <span>Handled by</span>
            <span>{t("shop.status")}</span>
            <span>{t("shop.received")}</span>
          </div>
          <ul>
            {requests.map((request) => (
              <li key={request.id} className="shop-inbox-row"
                data-arrival={arrivals.includes(request.id) ? request.id : undefined}
                data-handler={processingById.has(request.id) ? inboxOutcome(processingById.get(request.id)!) : undefined}
                style={arrivals.includes(request.id) ? { "--arrival-index": arrivals.indexOf(request.id) } as CSSProperties : undefined}>
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="shop-type-label">
                      {t(`shop.types.${requestType(request) ?? "unknown"}`)}
                    </span>
                    <span className="font-mono text-[11px]">{request.id}</span>
                  </div>
                  <Link
                    className="shop-request-link"
                    to={requestPath(request.id)}
                  >
                    <span>{request.subject}</span>
                    <IconArrowUpRight
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </Link>
                  <div className="mt-1.5 text-xs text-muted-foreground">
                    <CustomerName id={request.customerId} />
                    <span className="mx-2" aria-hidden="true">
                      ·
                    </span>
                    {t(
                      request.content.source === "free_text"
                        ? "shop.email"
                        : "shop.form",
                    )}
                  </div>
                </div>
                <div className="kiln-row-handling">{processingById.has(request.id) && <InboxHandling row={processingById.get(request.id)!} />}</div>
                <div className="kiln-row-status"><StatusChip status={request.status} /></div>
                <time
                  className="shop-inbox-age"
                  dateTime={request.createdAt}
                  title={dateText(request.createdAt)}
                >
                  {ageText(request.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
