import type { Mutation } from "@muscle-memory/recipe-engine";

/** Only the known tag input is internal bookkeeping; extra fields stay exact. */
export function isBookkeepingTag(mutation: Mutation): boolean {
  return mutation.action === "tag-request" && Object.keys(mutation.input).length === 2 &&
    typeof mutation.input.requestId === "string" && typeof mutation.input.tag === "string" && mutation.input.tag.trim().length > 0;
}
