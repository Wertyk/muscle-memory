import { useT } from "@agent-native/core/client/i18n";
import type { Run } from "@muscle-memory/recipe-engine";
import { IconPlayerPause, IconPlayerPlay, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-react";
import { useEffect, useMemo, useReducer, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { canReplay, initialReplayState, replaySteps, transitionReplay, type ReplayEvent } from "@/lib/ghost-replay";
import { presentationContext, valueSummary } from "@/lib/recipe-presentation";

import { ReplayWorkspace } from "./ReplayWorkspace";
import "./ghost-replay.css";

function useReducedMotion() {
  // Start without motion for SSR/hydration and browsers without matchMedia.
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function ReplayButton({ run }: { run: Run }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!canReplay(run)) return null;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" variant="outline" size="sm"><IconPlayerPlay />{t("runs.replay.open")}</Button></DialogTrigger>
    {open && <GhostReplay key={run.id} run={run} onExit={() => setOpen(false)} />}
  </Dialog>;
}

export function GhostReplay({ run, onExit }: { run: Run; onExit: () => void }) {
  const t = useT();
  // Freeze the selected checkpoint for this playback, even if the parent refetches.
  const [checkpoint] = useState(run);
  const steps = useMemo(() => replaySteps(checkpoint, t), [checkpoint, t]);
  const reduced = useReducedMotion();
  const [state, dispatch] = useReducer((state: typeof initialReplayState, event: ReplayEvent) => transitionReplay(state, event, steps, reduced), initialReplayState);
  const step = steps[state.index];
  const phase = step?.phases[reduced ? 0 : state.phase] ?? step?.phases[0];
  useEffect(() => {
    if (state.status !== "playing") return;
    const timer = window.setTimeout(() => dispatch("tick"), phase?.target && phase.view !== "workspace" ? 2400 : 1600);
    return () => window.clearTimeout(timer);
  }, [state, phase, reduced]);
  useEffect(() => { if (state.status === "closed") onExit(); }, [state.status, onExit]);
  const context = presentationContext(checkpoint);
  return <DialogContent className="ghost-replay" overlayClassName="ghost-replay-overlay" hideClose motion="instant" data-reduced-motion={reduced}>
    <header className="ghost-toolbar">
      <div className="min-w-0"><DialogTitle className="break-words">{t("runs.replay.title")} · {checkpoint.recipe.name}</DialogTitle><DialogDescription className="mt-1">{t("runs.replay.readOnly")}</DialogDescription></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="icon" aria-label={t("runs.replay.previous")} disabled={state.index === 0} onClick={() => dispatch("previous")}><IconPlayerSkipBack /></Button>
        <Button type="button" variant="outline" disabled={!steps.length} onClick={() => dispatch(state.status === "playing" ? "pause" : "play")}>
          {state.status === "playing" ? <IconPlayerPause /> : <IconPlayerPlay />}{t(state.status === "playing" ? "runs.replay.pause" : state.status === "ended" ? "runs.replay.restart" : "runs.replay.play")}
        </Button>
        <Button type="button" variant="outline" size="icon" aria-label={t("runs.replay.next")} disabled={state.status === "ended" || !steps.length} onClick={() => dispatch("next")}><IconPlayerSkipForward /></Button>
        <Button type="button" variant="ghost" onClick={() => dispatch("exit")}>{t("runs.replay.exit")}</Button>
      </div>
    </header>
    <div className="ghost-caption" role="status" aria-live="polite" aria-atomic="true">
      {state.status === "ended" && <p className="mb-2 font-medium">{t("runs.replay.end")}</p>}
      {step && <>
        <p className="text-xs text-muted-foreground">{t("runs.replay.progress", { current: state.index + 1, count: steps.length })}</p>
        <h3 className="mt-1 font-medium">{step.phases[0]?.target ? step.name : step.caption}</h3>
        <ul className="mt-2 space-y-1 text-sm">{step.values.map((value) => <li className="break-words" key={value.path}>{value.label} · {value.value}{value.source && <span className="text-muted-foreground"> · {value.source}</span>}</li>)}</ul>
        {step.saved.output !== null && <p className="mt-2 break-words text-xs text-muted-foreground">{t("runs.output")} · {valueSummary(step.saved.output, context)}</p>}
      </>}
      {reduced && <p className="mt-2 text-xs text-muted-foreground">{t("runs.replay.reducedMotion")}</p>}
    </div>
    {!reduced && step && phase && <ReplayWorkspace run={checkpoint} step={step} phase={phase} />}
  </DialogContent>;
}
