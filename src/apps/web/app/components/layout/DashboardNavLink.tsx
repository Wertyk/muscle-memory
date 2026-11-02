import { useT } from "@agent-native/core/client/i18n";
import { IconChartLine } from "@tabler/icons-react";
import { Link, useLocation } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function DashboardNavLink({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const active = useLocation().pathname === "/dashboard";
  const link = (
    <Link
      to="/dashboard"
      aria-current={active ? "page" : undefined}
      aria-label={t("dashboard.nav")}
      className={cn(
        "flex items-center text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active && "bg-sidebar-accent",
        collapsed
          ? "size-8 justify-center rounded-md"
          : "mb-3 h-10 w-full gap-3 rounded-lg px-3 text-sm font-medium",
      )}
    >
      <IconChartLine className="size-4 shrink-0" strokeWidth={1.8} />
      <span className={collapsed ? "sr-only" : "truncate"}>
        {t("dashboard.nav")}
      </span>
    </Link>
  );
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{t("dashboard.nav")}</TooltipContent>
    </Tooltip>
  ) : (
    <div className="px-2">{link}</div>
  );
}
