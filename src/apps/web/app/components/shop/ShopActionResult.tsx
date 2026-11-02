import { useT } from "@agent-native/core/client/i18n";
import { IconCheck, IconX } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";

import type { SavedResult } from "./ActionForm";

export function ShopActionResult({ result, onDismiss }: {
  result: SavedResult | null;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className="shop-action-result-slot" role="status" aria-live="polite" aria-atomic="true" hidden={!result}>
      {result && (
        <div className="shop-saved-result shop-action-result">
          <IconCheck className="size-4 shrink-0" aria-hidden="true" />
          <p title={`${result.title} · ${result.detail}`}>
            <strong>{result.title}</strong><span> · {result.detail}</span>
          </p>
          <Button size="xs" variant="ghost" aria-label={t("shop.close")} onClick={onDismiss}>
            <IconX className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
