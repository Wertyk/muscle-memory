import { actionErrorMessage } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { AgentToggleButton } from "@agent-native/toolkit/app/chat";
import type { RequestStatus } from "@muscle-memory/shop-domain";
import {
  IconAlertCircle,
  IconArrowRight,
  IconInbox,
  IconLoader2,
} from "@tabler/icons-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function StatusChip({ status }: { status: RequestStatus }) {
  const t = useT();
  return (
    <span className="shop-status" data-status={status}>
      <span aria-hidden="true" />
      {t(`shop.statuses.${status}`)}
    </span>
  );
}

export function PendingMark() {
  return (
    <IconLoader2
      className="size-4 motion-safe:animate-spin"
      aria-hidden="true"
    />
  );
}

export function WorkspaceLoading({ detail = false }: { detail?: boolean }) {
  const t = useT();
  return (
    <div
      className="shop-page"
      role="status"
      aria-label={t(detail ? "shop.loadingRequest" : "shop.loading")}
    >
      <ShopMasthead />
      <span className="sr-only">
        {t(detail ? "shop.loadingRequest" : "shop.loading")}
      </span>
      <Skeleton className="mb-8 h-12 w-2/3" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="mb-3 h-20 w-full" />
      ))}
    </div>
  );
}

export function QueryError({
  error,
  retry,
  stale = false,
}: {
  error: unknown;
  retry: () => void;
  stale?: boolean;
}) {
  const t = useT();
  return (
    <div className="shop-error" role="alert">
      <IconAlertCircle className="size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {t(stale ? "shop.refreshError" : "shop.loadError")}
        </p>
        <p className="mt-1 break-words text-xs">
          {actionErrorMessage(error) ?? t("shop.loadErrorHint")}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={retry}>
        {t("shop.retry")}
      </Button>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="shop-empty">
      <IconInbox
        className="mb-4 size-8 text-muted-foreground"
        strokeWidth={1.2}
        aria-hidden="true"
      />
      <h2 className="shop-serif text-2xl">{title}</h2>
      {children}
    </div>
  );
}

export function ShopMasthead({ children }: { children?: ReactNode }) {
  const t = useT();
  return (
    <div className="shop-masthead">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="shop-maker-mark" aria-hidden="true">
          k.
        </span>
        <span>{t("shop.studio")}</span>
        <IconArrowRight
          className="size-3 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-muted-foreground">{t("shop.support")}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <AgentToggleButton />
      </div>
    </div>
  );
}
