/* oxlint-disable unicorn/no-thenable -- Recipe branches have a non-callable `then` step array. */
import { z } from "zod";

import {
  expressionPaths,
  isBinding,
  pathSegments,
  templatePaths,
} from "../domain/evaluation.js";
import {
  immutableSnapshot,
  isIdentifier,
  isJsonValue,
  isSafeKey,
} from "../domain/json.js";
import type {
  Binding,
  BindingTree,
  Expression,
  JsonValue,
  RecipeVersion,
  Step,
} from "../domain/model.js";

export const expressionSchema = z.custom<Expression>(
  (value) => {
    try {
      expressionPaths(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid or unsupported JSONLogic expression", abort: true },
);

const approvalExpressionSchema = z.custom<Expression>(
  (value) => {
    try {
      expressionPaths(value, { allowInput: true });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid or unsupported approval expression", abort: true },
);

const pathSchema = z.string().refine(
  (value) => {
    try {
      pathSegments(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid or unsafe source path", abort: true },
);
const templateSchema = z.string().refine(
  (value) => {
    try {
      templatePaths(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid template placeholder", abort: true },
);
const jsonSchema = z.custom<JsonValue>(isJsonValue, {
  message: "Expected bounded finite JSON with safe keys",
  abort: true,
});
const keySchema = z.string().refine(isSafeKey, "Unsafe key");
const idSchema = z
  .string()
  .max(31)
  .refine(isIdentifier, "Expected a short readable identifier");

export const bindingSchema: z.ZodType<Binding> = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("fixed"), value: jsonSchema }),
  z.strictObject({ mode: z.literal("path"), path: pathSchema }),
  z.strictObject({ mode: z.literal("template"), template: templateSchema }),
  z.strictObject({ mode: z.literal("expr"), expr: expressionSchema }),
]);

const bindingTreeSchema: z.ZodType<BindingTree> = z.lazy(() =>
  z.union([
    bindingSchema,
    z.array(bindingTreeSchema),
    z.record(keySchema, bindingTreeSchema),
  ]),
);
const base = { id: idSchema, approval: approvalExpressionSchema.optional() };
const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      ...base,
      kind: z.literal("action"),
      action: z.string().min(1),
      args: z.record(keySchema, bindingTreeSchema),
    }),
    z.strictObject({
      ...base,
      kind: z.literal("extract"),
      text: bindingSchema,
      fields: z
        .record(
          keySchema,
          z.strictObject({
            type: z.enum(["string", "number", "boolean"]),
            required: z.boolean(),
            description: z.string().optional(),
          }),
        )
        .refine(
          (fields) => Object.keys(fields).length > 0,
          "Extract needs at least one typed field",
        ),
    }),
    z.strictObject({
      ...base,
      kind: z.literal("branch"),
      condition: expressionSchema,
      then: z.array(stepSchema),
      else: z.array(stepSchema),
    }),
    z.strictObject({
      ...base,
      kind: z.literal("handoff"),
      to: z.enum(["agent", "human"]),
      note: bindingSchema,
    }),
  ]),
);

function bindingPaths(tree: BindingTree): readonly string[] {
  if (isBinding(tree)) {
    switch (tree.mode) {
      case "fixed":
        return [];
      case "path":
        return [tree.path];
      case "expr":
        return expressionPaths(tree.expr);
      case "template":
        return templatePaths(tree.template);
    }
  }
  return Object.values(tree).flatMap(bindingPaths);
}

const rawRecipeSchema = z.strictObject({
  id: idSchema,
  recipeId: idSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1),
  trigger: z.strictObject({
    event: z.string().min(1),
    match: expressionSchema,
  }),
  steps: z.array(stepSchema).min(1),
});

/** Validate control-flow dependencies, then detach and recursively freeze this version. */
export const recipeVersionSchema = z
  .preprocess((value, ctx) => {
    if (!isJsonValue(value)) {
      ctx.addIssue({
        code: "custom",
        message: "Recipe must be bounded finite JSON with safe keys",
      });
      return z.NEVER;
    }
    return value;
  }, rawRecipeSchema)
  .superRefine((recipe, ctx) => {
    const ids = new Set<string>();
    const checkPaths = (
      paths: readonly string[],
      available: ReadonlySet<string>,
      location: readonly (string | number)[],
      inputRoots?: ReadonlySet<string>,
    ): void => {
      for (const path of paths) {
        const segments = pathSegments(path, {
          allowInput: Boolean(inputRoots),
        });
        if (segments[0] === "input" && !inputRoots?.has(segments[1]!))
          ctx.addIssue({
            code: "custom",
            path: [...location],
            message: `Step input is not available here: ${path}`,
          });
        if (segments[0] === "steps" && !available.has(segments[1]!))
          ctx.addIssue({
            code: "custom",
            path: [...location],
            message: `Step output is not available here: ${path}`,
          });
      }
    };
    const visit = (
      steps: readonly Step[],
      inherited: ReadonlySet<string>,
      location: readonly (string | number)[],
    ): void => {
      const available = new Set(inherited);
      steps.forEach((step, index) => {
        const here = [...location, index];
        if (ids.has(step.id))
          ctx.addIssue({
            code: "custom",
            path: [...here, "id"],
            message: "Step IDs must be globally unique",
          });
        ids.add(step.id);
        if (step.approval !== undefined) {
          const roots =
            step.kind === "action"
              ? Object.keys(step.args)
              : step.kind === "extract"
                ? ["text", "fields"]
                : step.kind === "handoff"
                  ? ["to", "note"]
                  : ["condition"];
          checkPaths(
            expressionPaths(step.approval, { allowInput: true }),
            available,
            [...here, "approval"],
            new Set(roots),
          );
        }
        switch (step.kind) {
          case "action":
            checkPaths(
              Object.values(step.args).flatMap(bindingPaths),
              available,
              [...here, "args"],
            );
            break;
          case "extract":
            checkPaths(bindingPaths(step.text), available, [...here, "text"]);
            break;
          case "handoff":
            checkPaths(bindingPaths(step.note), available, [...here, "note"]);
            break;
          case "branch":
            checkPaths(expressionPaths(step.condition), available, [
              ...here,
              "condition",
            ]);
            visit(step.then, available, [...here, "then"]);
            visit(step.else, available, [...here, "else"]);
            break;
        }
        // Branch/handoff steps have no data output. A branch's children may not execute.
        if (step.kind === "action" || step.kind === "extract")
          available.add(step.id);
      });
    };
    checkPaths(expressionPaths(recipe.trigger.match), new Set(), [
      "trigger",
      "match",
    ]);
    visit(recipe.steps, new Set(), ["steps"]);
  })
  .transform((recipe): RecipeVersion => immutableSnapshot(recipe));

export function parseRecipeVersion(value: unknown): RecipeVersion {
  return recipeVersionSchema.parse(value);
}
