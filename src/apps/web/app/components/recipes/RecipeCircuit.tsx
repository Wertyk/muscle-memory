import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useRecipePresentation } from "@/hooks/use-recipe-presentation";
import {
  CIRCUIT_MIN_WIDTH, circuitHighlightReducer, circuitPaths, circuitSelection,
  circuitSourceExample, emptyCircuitHighlight, recipeCircuit, type CircuitPoint, type CircuitSource,
} from "@/lib/recipe-circuit";
import type { RecipeDraft } from "@/lib/recipe-studio";

import { RecipeCircuitContext } from "./RecipeCircuitContext";
import { WireLegend } from "./RecipeField";
import "./recipe-circuit.css";

const nodeId = (target: EventTarget | null) => target instanceof Element
  ? target.closest<HTMLElement>("[data-circuit-node]")?.dataset.circuitNode ?? null : null;
const delay = (stepOrder: number): CSSProperties => ({ "--circuit-delay": `${stepOrder * 40}ms` }) as CSSProperties;

/** Geometry stays in DOM/SVG attributes. React only owns content, the breakpoint and interaction. */
export function RecipeCircuit({ draft, labels, loadKey, children }: {
  draft: RecipeDraft;
  labels: Readonly<Record<string, string>>;
  loadKey: string;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const schedule = useRef<() => void>(() => {});
  const [wide, setWide] = useState(false);
  const [highlight, dispatch] = useReducer(circuitHighlightReducer, emptyCircuitHighlight);
  const presentation = useRecipePresentation();
  const model = useMemo(() => recipeCircuit(draft.content, labels), [draft.content, labels]);
  const selection = circuitSelection(model, highlight);
  const targets = useMemo(() => new Map(model.targets.map((target) => [target.id, target])), [model]);
  const sourceOrder = useMemo(() => {
    const orders = new Map<string, number>();
    model.edges.forEach((edge) => { if (!orders.has(edge.sourceId)) orders.set(edge.sourceId, edge.stepOrder); });
    return orders;
  }, [model]);
  const current = useRef({ model, loadKey });
  current.current = { model, loadKey };
  const entered = useRef(new Set<string>());

  useLayoutEffect(() => {
    const root = container.current!;
    let frame = 0;
    let disposed = false;
    let isWide = false;
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const bounds = root.getBoundingClientRect();
      const nextWide = bounds.width >= CIRCUIT_MIN_WIDTH;
      if (nextWide !== isWide) {
        isWide = nextWide;
        root.dataset.circuitReady = "false";
        setWide(nextWide);
        return; // Measure the new layout after React has installed/removed its ports.
      }
      if (!isWide) return;
      const svg = root.querySelector<SVGSVGElement>(".recipe-circuit-wires");
      if (!svg) return;
      const centre = (element: Element): CircuitPoint | undefined => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        return { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top };
      };
      const sources = new Map<string, CircuitPoint>();
      const arguments_ = new Map<string, CircuitPoint>();
      root.querySelectorAll<HTMLElement>("[data-circuit-source-port]").forEach((port) => {
        const point = centre(port);
        if (point) sources.set(port.dataset.circuitSourcePort!, point);
      });
      root.querySelectorAll<HTMLElement>("[data-circuit-target-port]").forEach((port) => {
        const point = centre(port);
        if (point) arguments_.set(port.dataset.circuitTargetPort!, point);
      });
      const rail = root.querySelector<HTMLElement>(".recipe-circuit-sources")!.getBoundingClientRect();
      const steps = root.querySelector<HTMLElement>(".recipe-circuit-steps")!.getBoundingClientRect();
      const formulas = new Map<string, { input: CircuitPoint; output: CircuitPoint }>();
      const pills = root.querySelectorAll<HTMLElement>("[data-circuit-formula]");
      // Position pills from target centres, then read their real input/output port centres once.
      pills.forEach((pill) => {
        const point = arguments_.get(pill.dataset.circuitFormula!);
        if (pill.hidden === Boolean(point)) pill.hidden = !point;
        if (point) {
          pill.style.left = `${steps.left - bounds.left - 4 - pill.getBoundingClientRect().width / 2}px`;
          pill.style.top = `${point.y}px`;
        }
      });
      pills.forEach((pill) => {
        if (pill.hidden) return;
        const input = centre(pill.querySelector("[data-formula-input]")!);
        const output = centre(pill.querySelector("[data-formula-output]")!);
        if (input && output) formulas.set(pill.dataset.circuitFormula!, { input, output });
      });
      const laneStart = rail.right - bounds.left + 8;
      const laneEnd = Math.max(laneStart, Math.min(steps.left - bounds.left - 12, ...[...formulas.values()].map((pill) => pill.input.x - 8)));
      const paths = new Map(circuitPaths(current.current.model, { sources, targets: arguments_, formulas }, { left: laneStart, right: laneEnd })
        .map((path) => [path.id, path]));
      // No viewBox: SVG units stay CSS pixels while a sidebar resize is in flight.
      // Scaling an old viewBox to the new width would move otherwise stationary endpoints.
      svg.setAttribute("width", String(bounds.width));
      svg.setAttribute("height", String(bounds.height));
      root.querySelectorAll<SVGPathElement>("[data-circuit-path]").forEach((path) => {
        const d = paths.get(path.dataset.circuitPath!)?.d;
        if (d) path.setAttribute("d", d);
        else path.removeAttribute("d");
      });
      root.querySelectorAll<SVGCircleElement>("[data-circuit-junction]").forEach((dot) => {
        const point = paths.get(dot.dataset.circuitJunction!)?.junction;
        dot.setAttribute("visibility", point ? "visible" : "hidden");
        if (point) { dot.setAttribute("cx", String(point.x)); dot.setAttribute("cy", String(point.y)); }
      });
      if (!entered.current.has(current.current.loadKey)) {
        entered.current.add(current.current.loadKey);
        root.querySelectorAll(".recipe-circuit-wire, .recipe-circuit-port, .recipe-circuit-junction").forEach((element) => element.setAttribute("data-enter", ""));
      }
      root.dataset.circuitReady = "true";
    };
    const requestMeasure = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(measure);
    };
    schedule.current = requestMeasure;
    const resize = new ResizeObserver(requestMeasure);
    resize.observe(root);
    const mutation = new MutationObserver(requestMeasure);
    // Exclude attributes we write ourselves, so geometry/highlights never cause measurement loops.
    mutation.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "data-state"] });
    void document.fonts?.ready.then(requestMeasure);
    requestMeasure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);
  useLayoutEffect(() => { schedule.current(); }, [model, wide]);
  useLayoutEffect(() => { dispatch({ type: "clear" }); }, [loadKey]);
  useEffect(() => {
    if (!highlight.pinned) return;
    const clear = (event: KeyboardEvent) => { if (event.key === "Escape") dispatch({ type: "clear" }); };
    document.addEventListener("keydown", clear);
    return () => document.removeEventListener("keydown", clear);
  }, [highlight.pinned]);
  const renderSources = (rows: readonly CircuitSource[]) => rows.map((source) => {
    const example = circuitSourceExample(source, presentation);
    const active = selection.nodes.has(source.id);
    const mode = active ? targets.get(selection.id ?? "")?.mode ?? source.mode : source.mode;
    return <button key={`${loadKey}:${source.id}`} type="button" className="recipe-circuit-source" data-source={mode}
      data-circuit-node={source.id} data-highlighted={active} aria-pressed={highlight.pinned === source.id}
      aria-label={`${source.accessibleName ?? `${source.group} · ${source.label}`}${example !== undefined ? ` · ${example}` : ""}`}
      style={delay(sourceOrder.get(source.id) ?? 0)} onClick={() => dispatch({ type: "pin", id: source.id })}>
      <span className="recipe-circuit-source-label" title={source.label}>{source.label}</span>
      {example !== undefined && <code title={example}>{example}</code>}
      <span className="recipe-circuit-port" data-circuit-source-port={source.id} aria-hidden="true" />
    </button>;
  });

  return (
    <RecipeCircuitContext.Provider value={{ wide, loadKey, targets, activeNodes: selection.nodes }}>
      <div ref={container} className="recipe-circuit" data-wide={wide} data-circuit-active={Boolean(selection.id)}
        style={{ "--circuit-gutter": `${Math.max(110, Math.min(160, model.sources.length * 7 + 80))}px` } as CSSProperties}
        onPointerOver={(event) => {
          if (nodeId(event.target) !== nodeId(event.relatedTarget)) dispatch({ type: "hover", id: nodeId(event.target) });
        }}
        onPointerOut={(event) => {
          if (nodeId(event.target) !== nodeId(event.relatedTarget)) dispatch({ type: "hover", id: nodeId(event.relatedTarget) });
        }}
        onFocus={(event) => dispatch({ type: "focus", id: nodeId(event.target) })}
        onBlur={(event) => dispatch({ type: "focus", id: rootContains(event.currentTarget, event.relatedTarget) ? nodeId(event.relatedTarget) : null })}
        onKeyDown={(event) => { if (event.key === "Escape") dispatch({ type: "clear" }); }}
      >
        <div className="recipe-circuit-legend"><WireLegend /></div>
        {wide && <aside className="recipe-circuit-sources" aria-label="Recipe sources">
          {(["Request", "Step outputs", "Constants"] as const).map((group) => {
            const rows = model.sources.filter((source) => source.group === group);
            const producers = [...new Map(rows.map((source) => [source.producer?.id, source.producer]))]
              .sort(([, first], [, second]) => (first?.order ?? Infinity) - (second?.order ?? Infinity));
            return rows.length > 0 && <section key={group}>
              <h3>{group}</h3>
              {group === "Step outputs" ? producers.map(([id, producer]) => {
                const fields = rows.filter((source) => source.producer?.id === id);
                return <div key={id ?? "unknown"} className="recipe-circuit-output-group">
                  {producer && <h4>{String(producer.order).padStart(2, "0")} {producer.label}</h4>}
                  {renderSources(fields)}
                </div>;
              }) : renderSources(rows)}
            </section>;
          })}
        </aside>}
        <div className="recipe-circuit-steps">{children}</div>
        {wide && <>
          <svg key={loadKey} className="recipe-circuit-wires" aria-hidden="true" focusable="false">
            {model.sources.map((source) => <path key={`trunk:${source.id}`} className="recipe-circuit-wire" data-circuit-path={`trunk:${source.id}`}
              data-source={selection.nodes.has(source.id) ? targets.get(selection.id ?? "")?.mode ?? source.mode : source.mode}
              data-highlighted={selection.nodes.has(source.id)} pathLength={1} style={delay(sourceOrder.get(source.id) ?? 0)} />)}
            {model.edges.map((edge) => <path key={edge.id} className="recipe-circuit-wire" data-circuit-path={edge.id}
              data-source={edge.mode} data-highlighted={selection.edges.has(edge.id)} pathLength={1} style={delay(edge.stepOrder)} />)}
            {model.targets.filter((target) => target.formula !== undefined).map((target) => <path key={`formula:${target.id}`}
              className="recipe-circuit-wire" data-circuit-path={`formula:${target.id}`} data-source="formula"
              data-highlighted={selection.nodes.has(target.id)} pathLength={1} style={delay(target.stepOrder)} />)}
            {model.edges.map((edge) => <circle key={`junction:${edge.id}`} className="recipe-circuit-junction" data-circuit-junction={edge.id}
              data-source={edge.mode} data-highlighted={selection.edges.has(edge.id)} r={1.5} style={delay(edge.stepOrder)} />)}
          </svg>
          {model.targets.filter((target) => target.formula !== undefined).map((target) => <span key={`${loadKey}:${target.id}`}
            className="recipe-circuit-formula" data-circuit-formula={target.id} data-source="formula"
            data-highlighted={selection.nodes.has(target.id)} aria-hidden="true" title={target.fullFormula} style={delay(target.stepOrder)}>
            <span className="recipe-circuit-port" data-formula-input="" />
            <span>{target.formula}</span>
            <span className="recipe-circuit-port" data-formula-output="" />
          </span>)}
        </>}
      </div>
    </RecipeCircuitContext.Provider>
  );
}
const rootContains = (root: HTMLElement, target: EventTarget | null) => target instanceof Node && root.contains(target);
