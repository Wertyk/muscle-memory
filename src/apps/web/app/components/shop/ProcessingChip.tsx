import { useT } from "@agent-native/core/client/i18n";
import type { ProcessingState } from "@shared/request-processing";

export function ProcessingChip({ state }: { state: ProcessingState | null }) {
  const t = useT();
  return (
    <span className="shop-status shop-processing" data-processing={state ?? "processing"}>
      <span aria-hidden="true" />
      {t(`shop.processingStates.${state ?? "processing"}`)}
    </span>
  );
}
