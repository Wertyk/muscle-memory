import {
  buildRequestTrigger, parseRecipeVersion, type JsonObject, type MatchReason, type MatchRequest, type RequestMatch,
  type RunRecipe, type RunRepository,
} from "@muscle-memory/recipe-engine";
import type { CreateRequestInput, Request, RequestId } from "@muscle-memory/shop-domain";
import { eq } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { requestProcessing } from "../db/schema.js";
import { RequestCreatedEvents } from "./request-created-events.js";
import { assertRunLockActive, withRunLock } from "./run-lock.js";

const fallback = parseRecipeVersion({
  id: "ver_intake_handoff", recipeId: "recipe_intake_handoff", version: 1, name: "Intake agent handoff",
  trigger: { event: "request.created", match: true },
  steps: [{ id: "intake_handoff", kind: "handoff", to: "agent", note: { mode: "path", path: "trigger.intakeReason" } }],
});

interface IntakeDependencies {
  readonly create: (input: CreateRequestInput) => Promise<Request>;
  readonly get: (id: RequestId) => Promise<Request | null>;
  readonly matcher: (request: Request) => MatchRequest;
  readonly executor: (runId: string) => { readonly runRecipe: RunRecipe; readonly runs: RunRepository };
  readonly nextRunId: () => string;
}

/** Framework orchestration adapter. Matching itself belongs to MatchRequest;
 * shop validation/mutations belong to the shop's application use-cases/actions. */
export class RequestIntake {
  readonly events: RequestCreatedEvents;
  constructor(private readonly db: ShopDb, private readonly deps: IntakeDependencies) {
    this.events = new RequestCreatedEvents(async (id) => { await this.process(id); });
  }

  async create(input: CreateRequestInput): Promise<Request> {
    const created = await this.deps.create(input);
    await this.events.emit(created.id);
    return (await this.deps.get(created.id))!;
  }

  process(requestId: RequestId): Promise<void> {
    // Separate namespace from run locks. No rollbackable transaction surrounds
    // extraction, shop actions, run checkpoint commits or handoff delivery.
    return withRunLock(`intake:${requestId}`, async () => {
      const request = await this.deps.get(requestId);
      if (!request) throw new Error("Request not found.");
      assertRunLockActive();
      const [saved] = await this.db.select().from(requestProcessing).where(eq(requestProcessing.requestId, requestId));
      const runId = saved?.runId ?? this.deps.nextRunId();
      let match: RequestMatch;
      const context = buildRequestTrigger({}, { requestId: request.id, customerId: request.customerId, subject: request.subject });
      if (saved?.match) {
        match = saved.match;
      } else if (saved) {
        // A worker died during matching. Never repeat a possibly consumed model
        // call; hand off explicitly. Unknown usage remains unknown in this case.
        match = { recipe: null, trigger: context, tokens: { input: 0, output: 0 }, reason: "extraction_failed" };
      } else {
        await this.db.insert(requestProcessing).values({ requestId, runId });
        match = await this.deps.matcher(request).execute({
          event: "request.created", context,
          content: request.content.source === "structured"
            ? { source: "structured", fields: request.content.fields as unknown as JsonObject }
            : { source: "free_text", text: request.content.text },
        });
      }
      assertRunLockActive();
      await this.db.update(requestProcessing).set({ match }).where(eq(requestProcessing.requestId, requestId));
      const executor = this.deps.executor(runId);
      const existing = await executor.runs.get(runId);
      if (existing) {
        // Resumes running checkpoints/pending handoff; never approves a gate.
        await executor.runRecipe.resume({ runId });
      } else {
        await executor.runRecipe.execute({
          recipe: match.recipe ?? fallback,
          trigger: match.recipe ? match.trigger : { ...match.trigger, intakeReason: handoffNote(match.reason) },
        });
      }
    });
  }
}

function handoffNote(reason: MatchReason): string {
  switch (reason) {
    case "no_match": return "No active recipe matches this request.";
    case "extraction_failed": return "Request extraction was incomplete, failed or interrupted. Review the original request.";
    case "ambiguous": return "Multiple active recipes match this request; agent review required.";
    case "matching_failed": return "Recipe matching failed; agent review required.";
    case "matched": return "Request requires agent review.";
  }
}
