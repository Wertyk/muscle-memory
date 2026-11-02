import { actionErrorMessage, callAction } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { BacktestCaseResult, ClassifiedDifference, JsonValue, Mutation, Run } from "@muscle-memory/recipe-engine";
import type { RequestType } from "@muscle-memory/shop-domain";
import { useRef, useState } from "react";
import { Link } from "react-router";

import type { ShopBacktestComparison, ShopBacktestResult } from "@shared/recipe-backtests";
import { isBookkeepingTag } from "@shared/shop-mutation-comparison";
import { PendingMark } from "@/components/shop/WorkspaceParts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { backtestRequestType } from "@/lib/recipe-backtests";
import { moneyLabel } from "@/lib/recipe-money";
import { argumentLabel, atPath, isObject, type RecipeDetail } from "@/lib/recipe-studio";
import { actionLabel, backtestComparisonLabel, backtestSummary, mutationSummary, presentationContext, valueSummary } from "@/lib/recipe-presentation";
import { useRecipePresentation } from "@/hooks/use-recipe-presentation";

type Version = RecipeDetail["history"][number]["version"];
export type RememberBacktests = (reports: readonly ShopBacktestResult[], type: RequestType, source: "backtest" | "comparison", totalTokens: number | null) => void;

export function BacktestSummary({ summary }: { summary: ShopBacktestResult["summary"] }) {
  const t = useT();
  return <p className="recipe-backtest-summary">
    {backtestSummary(summary, t)}
    <span className="block text-muted-foreground">{summary.totalTokens === null
      ? t("recipes.backtests.tokensUnknown", { known: summary.tokens.input + summary.tokens.output, count: summary.unknownUsageCases })
      : t("recipes.backtests.tokens", { count: summary.totalTokens })}</span>
  </p>;
}

function VersionSelect({ label, value, versions, onChange, disabled }: {
  label: string; value: string; versions: readonly Version[]; onChange: (id: string) => void; disabled: boolean;
}) {
  return <div className="grid min-w-0 gap-1.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{versions.map((version) =>
        <SelectItem key={version.id} value={version.id}>v{version.version} · {version.name}</SelectItem>,
      )}</SelectContent>
    </Select>
  </div>;
}

/** Backtest-specific evidence display; use Studio's existing labels and money formatting. */
function OutcomeDiff({ diff, before, after, run }: {
  diff: readonly ClassifiedDifference[]; before: readonly Mutation[]; after: readonly Mutation[]; run?: Run | null | undefined;
}) {
  const t = useT();
  const source = useRecipePresentation();
  const presentation = run ? presentationContext(run) : source;
  const customerBefore = before.filter((mutation) => !isBookkeepingTag(mutation));
  const customerAfter = after.filter((mutation) => !isBookkeepingTag(mutation));
  const tagTargets = new Set([...before, ...after].filter((mutation) => mutation.action === "tag-request").map((mutation) => mutation.input.requestId));
  const tags = (mutations: readonly Mutation[]) => mutations.filter((mutation) => mutation.action === "tag-request")
    .map((mutation) => typeof mutation.input.tag === "string" ? tagTargets.size > 1 ? `${mutation.input.requestId}: ${mutation.input.tag}` : mutation.input.tag : null)
    .filter((tag) => tag !== null).join(", ") || t("recipes.backtests.absent");
  function valueLabel(value: JsonValue | undefined, path: string[], mutations: readonly Mutation[]) {
    if (value === undefined) return t("recipes.backtests.absent");
    if (path[path.length - 1] === "amountMinor" && typeof value === "number") {
      const mutation = mutations[Number(path[0])];
      const currency = mutation && atPath(mutation.input, [...path.slice(2, -1), "currency"]);
      return moneyLabel(value, currency, presentation);
    }
    if (path[path.length - 1] === "action" && typeof value === "string") return actionLabel(value, t);
    if (isObject(value) && typeof value.action === "string")
      return mutationSummary(value.action, value.input ?? null, presentation, t);
    return valueSummary(value, presentation);
  }
  return <ul className="recipe-diff">
    {diff.some((entry) => entry.classification === "bookkeeping") && <li>
      <strong>{t("recipes.backtests.tags")}</strong> · {t("recipes.backtests.classification.bookkeeping")}
      <div className="recipe-diff-transition"><del>{tags(before)}</del><span aria-hidden="true"> → </span><ins>{tags(after)}</ins></div>
    </li>}
    {diff.filter((entry) => entry.classification !== "bookkeeping").map((difference, index) => {
      const path = difference.path.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      const historical = difference.kind === "added" ? undefined : difference.historical;
      const intended = difference.kind === "removed" ? undefined : difference.intended;
      const action = customerAfter[Number(path[0])]?.action ?? customerBefore[Number(path[0])]?.action ?? "";
      const field = path[1] === "input" ? argumentLabel(path.slice(2).join("."), action) : t("recipes.backtests.operation");
      return <li key={index}>
        <strong>{field}</strong> · {t(`recipes.backtests.classification.${difference.classification}`)}
        <div className="recipe-diff-transition">
          <del>{valueLabel(historical, path, customerBefore)}</del>
          <span aria-hidden="true"> → </span>
          <ins>{valueLabel(intended, path, customerAfter)}</ins>
        </div>
      </li>;
    })}
  </ul>;
}

function CaseReasons({ item }: { item: BacktestCaseResult }) {
  const t = useT();
  return <ul className="my-2 grid gap-1 text-xs text-muted-foreground">
    {item.reasons.filter((reason) => !["different", "wording", "bookkeeping"].includes(reason.code) || item.diff.length === 0).map((reason, index) =>
      <li key={index}>{reason.code === "blocked" ? t("recipes.backtests.blocked") : reason.message}</li>,
    )}
    {item.status === "different" && item.diff.length > 0 && <li>{t("recipes.backtests.differentReason")}</li>}
    {item.status === "identical" && item.diff.length > 0 && <li>{t("recipes.backtests.nonOutcomeOnlyReason")}</li>}
    {item.status !== "identical" && item.diff.some((entry) => entry.classification === "wording") && <li>{t("recipes.backtests.wordingReason")}</li>}
    {item.status !== "identical" && item.diff.some((entry) => entry.classification === "bookkeeping") && <li>{t("recipes.backtests.bookkeepingReason")}</li>}
  </ul>;
}

function RequestLink({ id }: { id: string }) {
  return <Link className="underline underline-offset-2" to={`/requests/${encodeURIComponent(id)}`}>{id}</Link>;
}

function BacktestCases({ report }: { report: ShopBacktestResult }) {
  const t = useT();
  const cases = [...report.cases].sort((a, b) => Number(a.status === "identical") - Number(b.status === "identical"));
  return <>
    <p className="mt-3 text-xs text-muted-foreground">{t("recipes.backtests.recordedVsRecipe")}</p>
    <ul className="recipe-backtest-cases">
      {cases.map((item) => <li key={item.caseId}>
        <RequestLink id={item.caseId} />
        <span className="text-muted-foreground"> · {t(`recipes.backtests.status.${item.status}`)}</span>
        <details open={item.status !== "identical" || item.diff.length > 0}>
          <summary>{t("recipes.backtests.reasonAndDiff")}</summary>
          <CaseReasons item={item} />
          <OutcomeDiff diff={item.diff} before={item.historicalMutations} after={item.intendedMutations} run={item.run} />
        </details>
      </li>)}
    </ul>
  </>;
}

export function RecipeBacktestPanel({ detail, reports, remember }: {
  detail: RecipeDetail;
  reports: Readonly<Record<string, ShopBacktestResult>>;
  remember: RememberBacktests;
}) {
  const t = useT();
  const versions = detail.history.map((entry) => entry.version);
  const latest = versions[versions.length - 1];
  const [selectedId, select] = useState<string>();
  const selected = versions.find((version) => version.id === selectedId) ?? latest;
  const [baselineId, setBaseline] = useState<string>();
  const [candidateId, setCandidate] = useState<string>();
  const baseline = versions.find((version) => version.id === (baselineId ?? detail.recipe.activeVersionId)) ?? versions[0];
  const candidate = versions.find((version) => version.id === candidateId) ?? latest;
  const requestType = selected && backtestRequestType(selected.trigger.match);
  const baselineType = baseline && backtestRequestType(baseline.trigger.match);
  const candidateType = candidate && backtestRequestType(candidate.trigger.match);
  const busy = useRef(false);
  const [pending, setPending] = useState<"backtest" | "comparison">();
  const [failure, setFailure] = useState<{ source: "backtest" | "comparison"; message: string }>();
  const [comparison, setComparison] = useState<ShopBacktestComparison>();
  const report = selected && reports[selected.id];
  const paired = comparison?.baseline.recipeVersionId === baseline?.id && comparison?.candidate.recipeVersionId === candidate?.id ? comparison : undefined;
  async function run(source: "backtest" | "comparison") {
    if (busy.current) return;
    busy.current = true;
    setPending(source);
    setFailure(undefined);
    try {
      if (source === "backtest" && selected && requestType) {
        const result = await callAction<ShopBacktestResult>("backtest-recipe", { recipe: selected.id, requestType }, { method: "GET" });
        remember([result], requestType, source, result.summary.totalTokens);
      } else if (source === "comparison" && baseline && candidate && baselineType && baselineType === candidateType) {
        const result = await callAction<ShopBacktestComparison>("compare-recipe-versions", { baseline: baseline.id, candidate: candidate.id, requestType: baselineType }, { method: "GET" });
        setComparison(result);
        remember([result.baseline, result.candidate], baselineType, source, result.summary.totalTokens);
      }
    } catch (error) {
      setFailure({ source, message: actionErrorMessage(error) ?? t("recipes.backtests.failed") });
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }
  function error(source: "backtest" | "comparison") {
    return failure?.source === source && <p role="alert" className="shop-form-error mt-3">
      {failure.message} {t("recipes.backtests.failureHint")}
    </p>;
  }
  return <section className="recipe-panel" aria-labelledby="recipe-backtest-title">
    <h2 id="recipe-backtest-title" className="shop-serif">{t("recipes.backtest")}</h2>
    <p className="mb-3 text-xs text-muted-foreground">{t("recipes.backtests.costHint")}</p>
    {selected && <VersionSelect label={t("recipes.backtests.version")} value={selected.id} versions={versions} onChange={(id) => {
      select(id);
      const previous = reports[id];
      const type = versions.find((version) => version.id === id)?.trigger.match;
      const cohort = type !== undefined && backtestRequestType(type);
      if (previous && cohort) remember([previous], cohort, "backtest", previous.summary.totalTokens);
    }} disabled={Boolean(pending)} />}
    <p className="my-3 text-xs">{requestType ? t("recipes.backtests.cohort", { type: t(`shop.types.${requestType}`) }) : t("recipes.backtests.unknownType")}</p>
    <Button variant="outline" size="sm" disabled={Boolean(pending) || !requestType} onClick={() => void run("backtest")}>
      {pending === "backtest" && <PendingMark />}
      {t(pending === "backtest" ? "recipes.backtests.running" : "recipes.backtests.run")}
    </Button>
    <div role="status" aria-live="polite">{report ? <>
      <p className="mt-3 text-xs text-muted-foreground">{t("recipes.backtests.lastReport", { version: selected?.version })}</p>
      <BacktestSummary summary={report.summary} />
    </> : <p className="mt-3 text-xs text-muted-foreground">{t("recipes.backtests.idle")}</p>}</div>
    {error("backtest")}
    {report && <BacktestCases report={report} />}
    <details className="recipe-backtest-comparison">
      <summary>{t("recipes.backtests.compare")}</summary>
      <div className="mt-3 grid gap-3">
        {baseline && <VersionSelect label={t("recipes.backtests.baseline")} value={baseline.id} versions={versions} onChange={setBaseline} disabled={Boolean(pending)} />}
        {candidate && <VersionSelect label={t("recipes.backtests.candidate")} value={candidate.id} versions={versions} onChange={setCandidate} disabled={Boolean(pending)} />}
        {baseline?.id === candidate?.id && <p className="text-xs text-muted-foreground">{t("recipes.backtests.twoVersions")}</p>}
        {baselineType !== candidateType && <p className="text-xs text-muted-foreground">{t("recipes.backtests.sameType")}</p>}
        <Button variant="outline" size="sm" disabled={Boolean(pending) || !baselineType || baselineType !== candidateType || baseline?.id === candidate?.id} onClick={() => void run("comparison")}>
          {pending === "comparison" && <PendingMark />}
          {t(pending === "comparison" ? "recipes.backtests.comparing" : "recipes.backtests.runComparison")}
        </Button>
      </div>
      {error("comparison")}
      {paired && <div className="mt-3" aria-live="polite">
        <p className="text-xs">{t("recipes.backtests.paired", { baseline: baseline?.version, candidate: candidate?.version })}</p>
        <p className="my-2 text-xs">{t("recipes.backtests.changed", { changed: paired.cases.filter((item) => item.changed).length, nonOutcomeOnly: paired.cases.filter((item) => item.nonOutcomeOnly).length, count: paired.cases.filter((item) => item.nonOutcomeOnly).length, total: paired.cases.length })}</p>
        <p className="text-xs">{paired.summary.totalTokens === null
          ? t("recipes.backtests.tokensUnknown", { known: paired.summary.tokens.input + paired.summary.tokens.output, count: paired.summary.unknownUsageCases })
          : t("recipes.backtests.combinedTokens", { count: paired.summary.totalTokens })}</p>
        <p className="mt-2 text-xs">v{baseline?.version}</p><BacktestSummary summary={paired.baseline.summary} />
        <p className="mt-2 text-xs">v{candidate?.version}</p><BacktestSummary summary={paired.candidate.summary} />
        <ul className="recipe-backtest-cases">
          {paired.cases.map((item) => {
            const before = paired.baseline.cases.find((entry) => entry.caseId === item.caseId);
            const after = paired.candidate.cases.find((entry) => entry.caseId === item.caseId);
            return <li key={item.caseId}>
              <RequestLink id={item.caseId} />
              <p className="my-1">{t(`recipes.backtests.status.${item.baselineStatus}`)} → {t(`recipes.backtests.status.${item.candidateStatus}`)} · {backtestComparisonLabel(item, t)}</p>
              <details><summary>{t("recipes.backtests.reasonAndDiff")}</summary>
                {before && <><p>v{baseline?.version}</p><CaseReasons item={before} /></>}
                {after && <><p>v{candidate?.version}</p><CaseReasons item={after} /></>}
                <OutcomeDiff diff={item.diff} before={before?.intendedMutations ?? []} after={after?.intendedMutations ?? []} run={after?.run ?? before?.run} />
              </details>
            </li>;
          })}
        </ul>
      </div>}
    </details>
    <p className="mt-3 text-xs text-muted-foreground">{t("recipes.backtests.currentData")}</p>
    {report && <details className="mt-3 text-xs text-muted-foreground">
      <summary>{t("recipes.backtests.limitations")}</summary>
      <ul className="mt-2 grid gap-2">{report.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
    </details>}
  </section>;
}
