import { ActionInputValidationError } from "@agent-native/core/action";
import { z } from "zod";

/** Keep the original validator/tool metadata; add syntax diagnostics and the
 * parsing fallback core needs for unions and JSON refs. */
export function jsonContainerInput<T extends z.ZodType>(schema: T, parameter: string, kind: "object" | "array" | "object-or-array" = "object", preserveLiteralStrings = false) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return kind !== "object" ? parsed : value;
      if (parsed !== null && typeof parsed === "object" && Object.getPrototypeOf(parsed) === Object.prototype) {
        return kind !== "array" ? parsed : value;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (preserveLiteralStrings && schema.safeParse(value).success) return value;
      // V8 sometimes embeds the input in its error; keep the reason, not that copy.
      const reason = error.message.replace(/, (?:\.\.\.)?"[\s\S]* is not valid JSON$/, "");
      const reportedPosition = /position (\d+)/.exec(reason);
      const position = reportedPosition ? Number(reportedPosition[1]) : reason.includes("end of JSON input") ? value.length : undefined;
      const start = Math.max(0, Math.min((position ?? 0) - 40, value.length - 80));
      const excerpt = JSON.stringify(value.slice(start, start + 80));
      const location = reportedPosition ? "" : position === undefined ? "; position not reported by JSON.parse" : ` at position ${position}`;
      const container = kind === "object-or-array" ? "object or array" : kind;
      // Throw the framework's validation error so it does not append a raw Received preview.
      throw new ActionInputValidationError(`Invalid action parameters — ${parameter}: ${parameter} was sent as a string, but it is not valid JSON (${reason}${location}, near ${excerpt}). Send ${parameter} as a JSON ${container}, not a string.`, [parameter]);
    }
    return value;
  }, schema);
}
