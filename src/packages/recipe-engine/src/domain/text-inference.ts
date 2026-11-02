import { expressionPaths } from "./evaluation.js";
import { derivedTextSources, type Source } from "./inference-sources.js";
import type { BindingCandidate } from "./inference.js";
import type { Expression, JsonObject } from "./model.js";

export function textCandidates(value: string, sources: readonly Source[]): {
  values: readonly BindingCandidate[]; exhaustive: boolean; literals: readonly string[];
} {
  if (value.includes("{{") || value.includes("}}")) return { values: [], exhaustive: true, literals: [] };
  const tokens = new Map<string, Source[]>();
  for (const source of [...sources, ...derivedTextSources(sources)]) {
    if (typeof source.value !== "string" && typeof source.value !== "number") continue;
    const token = String(source.value);
    if (!token || !value.includes(token)) continue;
    const matches = tokens.get(token) ?? [];
    if (!matches.some(match => JSON.stringify(match.expr) === JSON.stringify(source.expr))) matches.push(source);
    tokens.set(token, matches);
  }
  for (const matches of tokens.values()) matches.sort((a, b) => {
    // Prefer a recorded amount result over a coincidentally equal item price.
    // Name proposals retain source ordering within the same rank.
    const money = (source: Source) => source.derived && "money" in (source.expr as JsonObject);
    const arrayMoney = (source: Source) => money(source) && /\[\d+\]/.test(source.path) ? 1 : 0;
    return (money(a) && money(b) ? arrayMoney(a) - arrayMoney(b) : 0) || a.rank - b.rank;
  });
  const ordered = [...tokens.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const parts: (string | { token: string })[] = [];
  const used = new Set<string>();
  let literal = "";
  for (let i = 0; i < value.length;) {
    const token = ordered.find(candidate => {
      if (!value.startsWith(candidate, i)) return false;
      const word = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);
      return !(word(candidate[0]) && word(value[i - 1])) && !(word(candidate[candidate.length - 1]) && word(value[i + candidate.length]));
    });
    if (token === undefined) { literal += value[i]!; i++; continue; }
    if (literal) { parts.push(literal); literal = ""; }
    parts.push({ token }); used.add(token); i += token.length;
  }
  if (literal) parts.push(literal);
  const literals = parts.filter((part): part is string => typeof part === "string");
  if (!used.size) return { values: [], exhaustive: true, literals };
  let assignments: ReadonlyMap<string, Source>[] = [new Map()];
  let exhaustive = true;
  for (const token of used) {
    const expanded: ReadonlyMap<string, Source>[] = [];
    for (const assignment of assignments) for (const source of tokens.get(token)!) {
      if (expanded.length < 64) expanded.push(new Map([...assignment, [token, source]]));
      else exhaustive = false;
    }
    assignments = expanded;
  }
  const values: BindingCandidate[] = [];
  for (const assignment of assignments) {
    const expressions: Expression[] = parts.map(part => typeof part === "string" ? part : assignment.get(part.token)!.expr);
    const simple = [...assignment.values()].every(source => typeof (source.expr as JsonObject).var === "string");
    if (!simple && expressions.length > 64) { exhaustive = false; continue; }
    const expr = { cat: expressions };
    values.push({ binding: simple
      ? { mode: "template", template: parts.map(part => typeof part === "string" ? part : `{{${(assignment.get(part.token)!.expr as JsonObject).var}}}`).join("") }
      : { mode: "expr", expr }, reason: "template", sourcePaths: [...new Set(expressionPaths(expr))] });
    if ([...assignment.values()].some(source => !source.exhaustive)) exhaustive = false;
  }
  return { values, exhaustive, literals };
}

/** A review warning, not fuzzy replacement: partial/case-changed detail names
 * remain literal. Two content words from a source label are enough to ask for review. */
export function requestSpecificFragments(literals: readonly string[], sources: readonly Source[]): readonly string[] {
  const words = (text: string) => text.toLowerCase().match(/[\p{L}]{3,}/gu) ?? [];
  const stop = new Set(["the", "and", "for", "your", "with", "from", "this", "that", "have", "was", "are"]);
  const labels = sources.filter(source => typeof source.value === "string" && /\.(?:name|title|subject)$/.test(source.path))
    .map(source => new Set(words(source.value as string).filter(word => !stop.has(word))));
  const fragments: string[] = [];
  for (const literal of literals) {
    const tokens = [...literal.matchAll(/[\p{L}]{3,}/gu)];
    for (const label of labels) {
      const matched = tokens.filter(token => label.has(token[0].toLowerCase()));
      if (new Set(matched.map(token => token[0].toLowerCase())).size < 2) continue;
      const first = matched[0]!; const last = matched[matched.length - 1]!;
      fragments.push(literal.slice(first.index, last.index! + last[0].length).slice(0, 256));
    }
    // A new proper label after a reference word also deserves review even when
    // it has no corresponding source label at all.
    for (const match of literal.matchAll(/\b(?:your|the|this|that)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Ll}+){0,2})/gu)) fragments.push(match[1]!.slice(0, 256));
  }
  return [...new Set(fragments)].slice(0, 8);
}
