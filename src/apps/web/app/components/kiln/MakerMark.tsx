import { useId } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isRecipeOutcome, type RecipeOutcome } from "@/lib/kiln";
import { formatTokens } from "../shop/dashboard-format";

export function MakerMark({ outcome, size = "compact" }: {
  outcome: RecipeOutcome;
  size?: "compact" | "medium" | "large";
}) {
  const id = useId().replace(/:/g, "");
  if (!isRecipeOutcome(outcome)) return null;
  const name = `Handled by recipe ${outcome.recipeName} v${outcome.version}, ${outcome.tokens ?? "unknown"} LLM tokens`;
  const letters = [...outcome.recipeName.trim()];
  const arcName = letters.length > 22 ? `${letters.slice(0, 21).join("").trimEnd()}…` : letters.join("");
  const stamp = <span className="kiln-maker" data-size={size} role="img" aria-label={name} tabIndex={0}>
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <path id={`${id}-name`} d="M 15,55 A 35,35 0 1,1 85,55" />
        <path id={`${id}-cost`} d="M 13,55 A 38,38 0 0,0 87,55" />
      </defs>
      <circle cx="50" cy="50" r="46" className="kiln-stamp-outer" />
      <circle cx="50" cy="50" r="42" className="kiln-stamp-inner" />
      {size !== "compact" && <>
        <text className="kiln-stamp-name"><textPath href={`#${id}-name`} startOffset="50%" textAnchor="middle">{arcName}</textPath></text>
        <text className="kiln-stamp-cost"><textPath href={`#${id}-cost`} startOffset="50%" textAnchor="middle">{`V${outcome.version} · ${outcome.tokens === null ? "UNMEASURED" : `${formatTokens(outcome.tokens, "en-US")} TOKENS`}`}</textPath></text>
      </>}
      <path className="kiln-stamp-glyph" d="M 35 65 V 37 L 50 53 L 65 37 V 65 M 32 68 H 68 M 43 31 H 57" />
    </svg>
  </span>;
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>{stamp}</TooltipTrigger><TooltipContent>{name}</TooltipContent></Tooltip></TooltipProvider>;
}
