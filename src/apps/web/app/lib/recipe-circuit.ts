import type { Binding, JsonValue } from "@muscle-memory/recipe-engine";

import {
  argumentLabel, atPath, bindingLabel, formulaLabel, isObject, stepLabel, valueSummary, wireSource, words,
  type PresentationContext, type WireSource,
} from "./recipe-presentation";

export const CIRCUIT_MIN_WIDTH = 920;
export const circuitTargetId = (path: readonly (string | number)[]) => JSON.stringify(path);
export interface CircuitSource {
  id: string;
  group: "Request" | "Step outputs" | "Constants";
  label: string;
  accessibleName?: string;
  producer?: { id: string; label: string; order: number };
  path?: string;
  value?: JsonValue;
  mode: WireSource;
}
export interface CircuitTarget {
  id: string;
  mode: WireSource;
  sourceIds: string[];
  stepOrder: number;
  formula?: string;
  fullFormula?: string;
}
export interface CircuitEdge {
  id: string;
  sourceId: string;
  targetId: string;
  mode: WireSource;
  stepOrder: number;
}
export interface RecipeCircuitModel {
  sources: CircuitSource[];
  targets: CircuitTarget[];
  edges: CircuitEdge[];
}
const normalizePath = (path: string) => path.replace(/\[(\d+)\]/g, ".$1");
export function circuitFieldLabel(path: string) {
  const parts = normalizePath(path).replace(/^trigger\.?|^steps\.[^.]+\.output\.?/, "")
    .replace(/items\.(\d+)/g, (_, index: string) => Number(index) === 0 ? "first item" : `item ${Number(index) + 1}`)
    .split(".").filter(Boolean).map(words);
  const label = parts.join(" · ") || "Output";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Collect references, never evaluate expressions or read live shop data. */
export function recipeCircuit(content: JsonValue, labels: Readonly<Record<string, string>> = {}): RecipeCircuitModel {
  const sources = new Map<string, CircuitSource>();
  const targets: CircuitTarget[] = [];
  const edges: CircuitEdge[] = [];
  const producers = new Map<string, NonNullable<CircuitSource["producer"]>>();
  let order = 0;
  const sourcePath = (path: string) => {
    path = normalizePath(path);
    if (!path.startsWith("trigger.") && !/^steps\.[^.]+\.output(?:\.|$)/.test(path)) return;
    const id = `path:${path}`;
    sources.set(id, { id, path, label: circuitFieldLabel(path),
      group: path.startsWith("trigger.") ? "Request" : "Step outputs",
      mode: path.startsWith("trigger.") ? "trigger" : "output" });
    return id;
  };
  const expressionSources = (expr: JsonValue, found: string[], depth = 0) => {
    if (depth > 32 || !expr || typeof expr !== "object") return;
    if (isObject(expr) && expr.var !== undefined) {
      const path = Array.isArray(expr.var) ? expr.var[0] : expr.var;
      if (typeof path === "string") {
        const id = sourcePath(path);
        if (id) found.push(id);
      }
    }
    Object.values(expr).forEach((child) => expressionSources(child, found, depth + 1));
  };
  const binding = (value: Binding, path: readonly (string | number)[], stepOrder: number) => {
    const id = circuitTargetId(path);
    const mode = wireSource(value);
    const inputs: string[] = [];
    if (value.mode === "path" && typeof value.path === "string") {
      const source = sourcePath(value.path);
      if (source) inputs.push(source);
    } else if (value.mode === "fixed") {
      const argsIndex = path.lastIndexOf("args");
      const label = argumentLabel(argsIndex >= 0 ? path.slice(argsIndex + 1).join(".") : String(path[path.length - 1]));
      const source = `fixed:${JSON.stringify([label, value.value])}`;
      if (!sources.has(source)) sources.set(source, { id: source, group: "Constants",
        label, value: value.value, mode: "constant" });
      inputs.push(source);
    } else if (value.mode === "template" && typeof value.template === "string") {
      for (const match of value.template.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const source = sourcePath(match[1]!.trim());
        if (source) inputs.push(source);
      }
    } else if (value.mode === "expr") expressionSources(value.expr, inputs);
    const sourceIds = [...new Set(inputs)];
    // A formula with no references still has a node; literals/approvals/handoffs do not.
    targets.push({ id, mode, sourceIds, stepOrder,
      ...(value.mode === "expr" ? { formula: formulaLabel(value.expr, labels), fullFormula: bindingLabel(value, labels) } : {}) });
    sourceIds.forEach((sourceId) => edges.push({ id: JSON.stringify([sourceId, id]), sourceId, targetId: id, mode, stepOrder }));
  };
  const tree = (value: JsonValue, path: readonly (string | number)[], stepOrder: number) => {
    if (!value || typeof value !== "object") return;
    if (isObject(value) && ["path", "fixed", "expr", "template"].includes(String(value.mode))) {
      binding(value as unknown as Binding, path, stepOrder);
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      // Match BindingFields' intentionally hidden empty reply variables.
      if (key === "variables" && isObject(child) && (!Object.keys(child).length ||
        (child.mode === "fixed" && isObject(child.value) && !Object.keys(child.value).length))) return;
      tree(child, [...path, Array.isArray(value) ? Number(key) : key], stepOrder);
    });
  };
  const steps = (value: JsonValue | undefined, path: readonly (string | number)[]) => {
    if (!Array.isArray(value)) return;
    value.forEach((step, index) => {
      if (!isObject(step)) return;
      const current = [...path, index];
      const stepOrder = order++;
      const stepId = String(step.id);
      producers.set(stepId, { id: stepId, order: stepOrder + 1,
        label: labels[stepId] ?? stepLabel({ kind: String(step.kind), action: typeof step.action === "string" ? step.action : null }) });
      if (step.kind === "action") tree(step.args ?? {}, [...current, "args"], stepOrder);
      if (step.kind === "extract") tree(step.text ?? null, [...current, "text"], stepOrder);
      if (step.kind === "branch") {
        binding({ mode: "expr", expr: step.condition ?? null }, [...current, "condition"], stepOrder);
        steps(step.then, [...current, "then"]);
        steps(step.else, [...current, "else"]);
      }
    });
  };
  if (isObject(content)) steps(content.steps, ["steps"]);
  return { sources: [...sources.values()].map((source) => {
    const producer = source.group === "Step outputs" ? producers.get(source.path?.split(".")[1] ?? "") : undefined;
    const heading = producer ? `${String(producer.order).padStart(2, "0")} ${producer.label}` : source.group;
    return { ...source, ...(producer ? { producer } : {}), accessibleName: `${heading} · ${source.label}`,
      mode: edges.find((edge) => edge.sourceId === source.id)?.mode ?? source.mode };
  }), targets, edges };
}

export function circuitSourceExample(source: CircuitSource, context: PresentationContext): string | undefined {
  if (source.value !== undefined) {
    const summary = valueSummary(source.value, context);
    if (!summary.includes("{{")) return summary;
    const variables = new Set(typeof source.value === "string" ? [...source.value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!.trim()) : []);
    return variables.size ? `Message template · ${variables.size} variable${variables.size === 1 ? "" : "s"}` : "Message template";
  }
  // The last snapshot is the demonstration when loaded; do not replace its history with a live read.
  for (const snapshot of [...(context.snapshots ?? [])].reverse()) {
    const values: JsonValue = { trigger: snapshot.trigger,
      steps: Object.fromEntries(snapshot.steps.map((step) => [step.id, { output: step.output }])) };
    const value = source.path ? atPath(values, normalizePath(source.path).split(".")) : undefined;
    if (value !== undefined) return valueSummary(value, context);
  }
}

export interface CircuitPoint { x: number; y: number }
export interface CircuitPorts {
  sources: ReadonlyMap<string, CircuitPoint>;
  targets: ReadonlyMap<string, CircuitPoint>;
  formulas: ReadonlyMap<string, { input: CircuitPoint; output: CircuitPoint }>;
}
export interface CircuitGutter { left: number; right: number }
/** Lower rail rows get nearer lanes: upper horizontal leads do not cut through lower buses.
 * Keep 7px pitch when space permits; compress only to fit dense recipes before the pills. */
export function circuitLanes(sources: ReadonlyMap<string, CircuitPoint>, gutter: CircuitGutter) {
  const sorted = [...sources].sort(([a, first], [b, second]) => second.y - first.y || a.localeCompare(b));
  const pitch = Math.min(7, Math.max(0, gutter.right - gutter.left) / Math.max(1, sorted.length - 1));
  return new Map(sorted.map(([id], index) => [id, gutter.left + index * pitch]));
}
/** Orthogonal segments with quadratic, 6px corner fillets; retain fractional port centres. */
export function circuitRoundedPath(points: readonly CircuitPoint[], radius = 6) {
  if (!points.length) return "";
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]!, corner = points[index]!, after = points[index + 1]!;
    const incoming = Math.abs(corner.x - before.x) + Math.abs(corner.y - before.y);
    const outgoing = Math.abs(after.x - corner.x) + Math.abs(after.y - corner.y);
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const start = { x: corner.x - Math.sign(corner.x - before.x) * r, y: corner.y - Math.sign(corner.y - before.y) * r };
    const end = { x: corner.x + Math.sign(after.x - corner.x) * r, y: corner.y + Math.sign(after.y - corner.y) * r };
    d += ` L ${start.x} ${start.y} Q ${corner.x} ${corner.y} ${end.x} ${end.y}`;
  }
  const end = points[points.length - 1]!;
  return `${d} L ${end.x} ${end.y}`;
}
export interface CircuitPath {
  id: string;
  kind: "trunk" | "branch" | "formula";
  d: string;
  junction?: CircuitPoint;
}

/** All coordinates are port centres in container space, including fractional pixels. */
export function circuitPaths(model: RecipeCircuitModel, ports: CircuitPorts, gutter: CircuitGutter) {
  const paths: CircuitPath[] = [];
  const lanes = circuitLanes(ports.sources, gutter);
  for (const source of model.sources) {
    const port = ports.sources.get(source.id);
    const lane = lanes.get(source.id);
    if (!port || lane === undefined) continue;
    const joins: CircuitPoint[] = [];
    for (const edge of model.edges.filter((edge) => edge.sourceId === source.id)) {
      const target = ports.formulas.get(edge.targetId)?.input ?? ports.targets.get(edge.targetId);
      if (!target) continue;
      const direction = Math.sign(target.y - port.y);
      const radius = Math.min(6, Math.abs(target.y - port.y) / 2, Math.max(0, target.x - lane) / 2);
      const junction = { x: lane, y: target.y - direction * radius };
      joins.push(junction);
      const d = direction && radius ? `M ${lane} ${junction.y} Q ${lane} ${target.y} ${lane + radius} ${target.y} L ${target.x} ${target.y}`
        : `M ${lane} ${target.y} L ${target.x} ${target.y}`;
      paths.push({ id: edge.id, kind: "branch", d, junction });
    }
    if (!joins.length) continue;
    const min = Math.min(port.y, ...joins.map((point) => point.y));
    const max = Math.max(port.y, ...joins.map((point) => point.y));
    const d = min < port.y && max > port.y
      ? `M ${port.x} ${port.y} L ${lane} ${port.y} M ${lane} ${min} L ${lane} ${max}`
      : circuitRoundedPath([port, { x: lane, y: port.y }, { x: lane, y: min < port.y ? min : max }]);
    paths.push({ id: `trunk:${source.id}`, kind: "trunk", d });
  }
  for (const target of model.targets) {
    const formula = ports.formulas.get(target.id);
    const port = ports.targets.get(target.id);
    if (formula && port) paths.push({ id: `formula:${target.id}`, kind: "formula", d: `M ${formula.output.x} ${formula.output.y} L ${port.x} ${port.y}` });
  }
  return paths;
}

export interface CircuitHighlight { hovered: string | null; focused: string | null; pinned: string | null }
export const emptyCircuitHighlight: CircuitHighlight = { hovered: null, focused: null, pinned: null };
export type CircuitHighlightEvent = { type: "hover" | "focus" | "pin"; id: string | null } | { type: "clear" };
export function circuitHighlightReducer(state: CircuitHighlight, event: CircuitHighlightEvent): CircuitHighlight {
  if (event.type === "clear") return emptyCircuitHighlight;
  const key = event.type === "hover" ? "hovered" : event.type === "focus" ? "focused" : "pinned";
  if (key === "pinned" && state.pinned === event.id) return emptyCircuitHighlight;
  return { ...state, [key]: event.id };
}
export function circuitSelection(model: RecipeCircuitModel, state: CircuitHighlight) {
  const candidate = state.pinned ?? state.focused ?? state.hovered;
  const id = model.sources.some((source) => source.id === candidate) || model.targets.some((target) => target.id === candidate) ? candidate : null;
  const edges = model.edges.filter((edge) => edge.sourceId === id || edge.targetId === id);
  const nodes = new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId]));
  if (id) nodes.add(id);
  return { id, nodes, edges: new Set(edges.map((edge) => edge.id)) };
}
