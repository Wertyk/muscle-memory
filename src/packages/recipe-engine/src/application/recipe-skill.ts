import type { JsonObject, JsonValue, RecipeVersion } from "../domain/model.js";
import type { RuntimeSkill } from "./ports.js";

// Full character encoding preserves identity (underscores/case must not collide).
export const recipeSkillName = (id: string): string =>
  `recipe-${Array.from(id, char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;

function humanCondition(value: JsonValue): string {
  if (value === true) return "all requests";
  if (value === false) return "no requests";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const condition = value as JsonObject;
    const equals = condition["=="] ?? condition["==="];
    if (Array.isArray(equals) && equals.length === 2) {
      const [field, expected] = equals;
      if (field && typeof field === "object" && !Array.isArray(field) && typeof field.var === "string")
        return `${field.var.replace(/_/g, " ")} is ${String(expected).replace(/_/g, " ")}`;
    }
    if (Array.isArray(condition.and)) return condition.and.map(humanCondition).join(" and ");
    if (Array.isArray(condition.or)) return condition.or.map(humanCondition).join(" or ");
  }
  return `requests satisfying ${JSON.stringify(value)}`;
}

export function recipeSkill(version: RecipeVersion): RuntimeSkill {
  const inputs = new Set<string>(["requestId"]);
  const json = JSON.stringify(version);
  for (const match of json.matchAll(/trigger\.([A-Za-z_][A-Za-z0-9_.[\]-]*)/g)) inputs.add(match[1]!);
  const when = `${version.trigger.event}: ${humanCondition(version.trigger.match)}`;
  return {
    name: recipeSkillName(version.recipeId),
    description: `${version.name}. Handles ${when}. Run the active recipe with run-recipe, dryRun first.`,
    instructions: [
      `# ${version.name}`,
      `Handles ${when}.`,
      `Recipe ID: ${version.recipeId}. Published version: ${version.id} (v${version.version}).`,
      `Trigger condition (JSONLogic): ${JSON.stringify(version.trigger.match)}.`,
      `Inputs: trigger is the intake-shaped JSON payload; include ${[...inputs].join(", ")} where referenced.`,
      "Read the real request using the app actions and reuse its validated intake payload. Never invent missing fields; free text needs validated extracted fields first.",
      `Before every run, call get-recipe({recipeId:${JSON.stringify(version.recipeId)}}). Stop if it is not active; use the history snapshot whose id equals recipe.activeVersionId, not the latest draft or this publication's old version. Verify that the real trigger satisfies the saved trigger condition.`,
      "Call run-recipe({recipe: activeSnapshot, trigger, dryRun:true}) first. Inspect planned inputs and blocked steps; a blocked simulation is not proof of success. Extraction may spend tokens even in dry-run.",
      "If the operator requested execution and the preview is suitable, call run-recipe({recipe: activeSnapshot, trigger, dryRun:false}). Preserve recipe approval gates; never approve implicitly. Keep the run id; after a lost response inspect durable runs before starting another run.",
      `Run actions render chat cards automatically. Keep the entire reply to one or two sentences total: overall status and next step. Use the recipe name; omit request/run/version IDs, tag literals, step details and tool JSON. No headings, lists or tables. Example: "The ${version.name} dry-run and execution completed. Review the run cards for details."`,
    ].join("\n\n"),
  };
}
