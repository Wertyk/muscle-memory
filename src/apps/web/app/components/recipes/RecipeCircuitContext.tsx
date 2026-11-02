import { createContext, useContext } from "react";

import { circuitTargetId, type CircuitTarget } from "@/lib/recipe-circuit";

export const RecipeCircuitContext = createContext<{
  wide: boolean;
  loadKey: string;
  targets: ReadonlyMap<string, CircuitTarget>;
  activeNodes: ReadonlySet<string>;
}>({ wide: false, loadKey: "", targets: new Map(), activeNodes: new Set() });

export const useRecipeCircuit = () => useContext(RecipeCircuitContext);
export function useCircuitTarget(path: readonly (string | number)[]) {
  const context = useRecipeCircuit();
  const target = context.wide ? context.targets.get(circuitTargetId(path)) : undefined;
  return { target, loadKey: context.loadKey, active: target ? context.activeNodes.has(target.id) : false };
}
