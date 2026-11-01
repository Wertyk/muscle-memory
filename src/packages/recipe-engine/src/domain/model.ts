export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

/** A validated expression in the documented, allowlisted JSONLogic subset. */
export type Expression = JsonValue;

export type Binding =
  | { readonly mode: "fixed"; readonly value: JsonValue }
  | { readonly mode: "path"; readonly path: string }
  | { readonly mode: "template"; readonly template: string }
  | { readonly mode: "expr"; readonly expr: Expression };

/** Nested action arguments retain their object/array shape, with bindings at leaves. */
export type BindingTree = Binding | readonly BindingTree[] | { readonly [key: string]: BindingTree };

interface StepBase {
  readonly id: string;
  readonly approval?: Expression | undefined;
}
export interface ActionStep extends StepBase {
  readonly kind: "action";
  readonly action: string;
  readonly args: Readonly<Record<string, BindingTree>>;
}
export interface ExtractField {
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description?: string | undefined;
}
export interface ExtractStep extends StepBase {
  readonly kind: "extract";
  readonly text: Binding;
  readonly fields: Readonly<Record<string, ExtractField>>;
}
export interface BranchStep extends StepBase {
  readonly kind: "branch";
  readonly condition: Expression;
  readonly then: readonly Step[];
  readonly else: readonly Step[];
}
export interface HandoffStep extends StepBase {
  readonly kind: "handoff";
  readonly to: "agent" | "human";
  readonly note: Binding;
}
export type Step = ActionStep | ExtractStep | BranchStep | HandoffStep;

export interface RecipeVersion {
  readonly id: string;
  readonly recipeId: string;
  readonly version: number;
  readonly name: string;
  readonly trigger: { readonly event: string; readonly match: Expression };
  readonly steps: readonly Step[];
}

/** Mutable catalog metadata; executable versions remain immutable. */
export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly status: "draft" | "active";
  readonly activeVersionId: string | null;
}

/** Minimal successful-trace projection; capture adapters can retain extra metadata. */
export interface TraceStep {
  readonly id: string;
  readonly action: string;
  readonly input: JsonObject;
  readonly output: JsonValue;
}
export interface Trace {
  readonly id: string;
  readonly steps: readonly TraceStep[];
}
export interface BindingContext {
  readonly trigger: JsonValue;
  readonly steps: Readonly<Record<string, { readonly output: JsonValue }>>;
}
