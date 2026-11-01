import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { RequestActivity } from "@muscle-memory/shop-domain";
import {
  IconClipboardCheck,
  IconCreditCardRefund,
  IconFlag,
  IconInbox,
  IconMessage,
  IconPackage,
  IconPackageExport,
  IconShoppingBag,
  IconTicket,
  IconTruck,
} from "@tabler/icons-react";

import { Skeleton } from "@/components/ui/skeleton";
import { dateText, moneyText } from "@/lib/shop-workspace";

import { QueryError, StatusChip } from "./WorkspaceParts";

const icons = {
  request_received: IconInbox,
  order_placed: IconShoppingBag,
  dispatched: IconTruck,
  delivered: IconPackage,
  reply: IconMessage,
  refund: IconCreditCardRefund,
  replacement: IconPackageExport,
  return_label: IconTicket,
  recorded_state: IconClipboardCheck,
  escalation: IconFlag,
};

function ActivityDetail({ item }: { item: RequestActivity }) {
  switch (item.kind) {
    case "reply":
      return <p className="shop-activity-excerpt">{item.bodyExcerpt}</p>;
    case "refund":
      return (
        <p className="shop-activity-detail">
          <strong className="font-medium text-foreground">
            {moneyText(item.amount)}
          </strong>{" "}
          · {item.reason}
        </p>
      );
    case "replacement":
      return (
        <>
          <p className="shop-activity-detail">
            {item.items
              .map((line) => `${line.name} × ${line.quantity}`)
              .join(", ")}
          </p>
          <p className="shop-activity-id">{item.orderId}</p>
        </>
      );
    case "return_label":
      return <p className="shop-activity-id">{item.labelId}</p>;
    case "order_placed":
      return <p className="shop-activity-id">{item.orderId}</p>;
    case "dispatched":
      return <p className="shop-activity-detail">{item.carrier}</p>;
    case "escalation":
      return <p className="shop-activity-detail">{item.reason}</p>;
    case "recorded_state":
      return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusChip status={item.status} />
          {item.tags.map((tag) => (
            <span className="shop-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      );
    default:
      return null;
  }
}

export function ActivityTimeline({ requestId }: { requestId: string }) {
  const t = useT();
  const query = useActionQuery<readonly RequestActivity[]>(
    "get-request-activity",
    { requestId },
  );
  return (
    <section
      className="shop-panel shop-timeline"
      aria-label={t("shop.activity")}
      aria-busy={query.isFetching}
    >
      <div className="shop-section-heading">
        <h2>{t("shop.activity")}</h2>
      </div>
      {query.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <>
          {query.isError && (
            <QueryError
              error={query.error}
              retry={() => void query.refetch()}
              stale={Boolean(query.data)}
            />
          )}
          <ol>
            {query.data?.map((item) => {
              const Icon = icons[item.kind];
              return (
                <li key={item.id}>
                  <span className="shop-activity-icon" aria-hidden="true">
                    <Icon className="size-4" strokeWidth={1.6} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {t(`shop.activityKinds.${item.kind}`)}
                    </p>
                    <ActivityDetail item={item} />
                    <time
                      className="mt-1.5 block text-xs text-muted-foreground"
                      dateTime={item.at}
                    >
                      {dateText(item.at)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
