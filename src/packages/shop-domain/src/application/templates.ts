import { failure, invalidInput, success, type Result } from "../domain/index.js";

/** Literal {{variable}} substitution only; no evaluation or recursive expansion. */
export function renderReplyTemplate(
  template: string,
  variables: Readonly<Record<string, string | number>>,
): Result<string> {
  if (!template.trim()) return invalidInput("template", "Reply template is required");
  const token = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  if (/[{}]/.test(template.replace(token, ""))) {
    return invalidInput("template", "Use {{variable}} placeholders with simple variable names");
  }
  for (const match of template.matchAll(token)) {
    const variable = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(variables, variable)) return failure({ code: "MISSING_TEMPLATE_VARIABLE", variable });
    const value = variables[variable];
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      return invalidInput(`variables.${variable}`, "Expected text or a finite number");
    }
  }
  return success(template.replace(token, (_match, variable: string) => String(variables[variable])));
}
