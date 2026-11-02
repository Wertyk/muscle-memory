import type {
  JsonValue,
  RecipeStudio,
} from "@muscle-memory/recipe-engine";

export type RecipeSummary = Awaited<ReturnType<RecipeStudio["list"]>>[number];
export type RecipeDetail = Awaited<ReturnType<RecipeStudio["get"]>>;
export type RecipeDraft = Awaited<ReturnType<RecipeStudio["getDraft"]>>;
export const RECIPES_PATH = "/recipes";
export const recipePath = (id: string) => `/recipes/${encodeURIComponent(id)}`;
export function recipeIdFromPath(path: string) {
  const match = path.match(/^\/recipes\/([^/]+)\/?$/)?.[1];
  try {
    return match ? decodeURIComponent(match) : undefined;
  } catch {
    return undefined;
  }
}
export { argumentLabel, atPath, bindingLabel, differenceLabel, expressionLabel, isObject, pathLabel, wireSource, words } from "./recipe-presentation";
export type { WireSource } from "./recipe-presentation";

export function replaceAtPath(
  content: JsonValue,
  path: readonly (string | number)[],
  value: JsonValue,
): JsonValue {
  if (!path.length) return value;
  const copy = structuredClone(content) as Record<string | number, JsonValue>;
  let target = copy;
  for (const key of path.slice(0, -1))
    target = target[key] as Record<string | number, JsonValue>;
  target[path[path.length - 1]!] = value;
  return copy as JsonValue;
}
