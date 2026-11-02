import {
  setClientAppState,
} from "@agent-native/core/client/hooks";
import {
  parseRecipeVersion,
  RecipeStudio,
  type RecipeStudioStore,
  type StudioRecord,
  type JsonObject,
} from "@muscle-memory/recipe-engine";
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";
import { atPath, expressionLabel } from "@/lib/recipe-studio";
import { backtestRequestType } from "@/lib/recipe-backtests";
import type { ShopBacktestResult, ShopBacktestComparison } from "@shared/recipe-backtests";

import brokenPlatterDraft from "../../../server/fixtures/broken-platter-draft.json";
import { damagedItemFixture } from "../../../server/fixtures/intake-recipes";
import { RecipePage } from "./RecipePage";
import { RecipesPage } from "./RecipesPage";
const agent = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@agent-native/core/client/agent-chat", () => ({ sendToAgentChat: agent.send }));
vi.mock("@agent-native/core/client/hooks", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agent-native/core/client/hooks")>(),
  setClientAppState: vi.fn(async () => null),
}));
vi.mock("@agent-native/toolkit/app/chat", () => ({
  AgentToggleButton: () => <button>Agent sidebar</button>,
}));
vi.mock("@agent-native/core/client/i18n", () => ({
  useT:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const message = (messageKey: string) => messageKey
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          enUS,
        );
      const value = (typeof values.count === "number" ? message(`${key}_${values.count === 1 ? "one" : "other"}`) : undefined) ?? message(key);
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(values[name] ?? ""),
      );
    },
}));
let root: Root,
  node: HTMLDivElement,
  client: QueryClient,
  studio: RecipeStudio,
  record: StudioRecord;
let savedRun: Record<string, unknown> | null;
let demonstrationSteps: JsonObject[];
let agentSource: boolean;
let calls: { name: string; input: Record<string, unknown>; method: string }[];
let backtestResult: (input: { recipe: string; requestType: string }) => Promise<ShopBacktestResult>;
let compareResult: (input: { baseline: string; candidate: string; requestType: string }) => Promise<ShopBacktestComparison>;
function report(recipeVersionId: string): ShopBacktestResult {
  return {
    recipeVersionId, readData: "current", limitations: ["Uses current shop data."],
    summary: { total: 10, sameOutcome: 8, differentOutcome: 2, notHandled: 0, nonOutcomeOnly: 1, tokens: { input: 40, output: 20 }, totalTokens: 60, unknownUsageCases: 0,
      requestExtractionTokens: { input: 40, output: 20 }, recipeExtractionTokens: { input: 0, output: 0 } },
    cases: Array.from({ length: 10 }, (_, index) => ({
      caseId: `req_00${31 + index}`, status: index < 7 || index === 9 ? "identical" : "different",
      reasons: [{ code: index < 7 ? "identical" : "different", message: index < 7 ? "Intended mutations match the historical outcome" : "Intended mutations differ from the historical outcome" }],
      historicalMutations: [{ action: index === 7 ? "create-replacement-order" : "issue-refund", input: { amount: { amountMinor: 38000, currency: "USD" } } }],
      intendedMutations: [{ action: "issue-refund", input: { amount: { amountMinor: 19000, currency: "USD" } } }],
      diff: index < 7 ? [] : index === 7 ? [{ kind: "changed", classification: "outcome", path: "/0/action", historical: "create-replacement-order", intended: "issue-refund" }]
        : index === 8 ? [{ kind: "changed", classification: "outcome", path: "/0/input/amount/amountMinor", historical: 38000, intended: 19000 }]
          : [{ kind: "changed", classification: "wording", path: "/1/input/body", historical: "Please send packaging photos", intended: "Your refund is on its way" }],
      run: null,
    })),
  };
}
async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    check();
  });
}
function button(text: string) {
  const value = [...node.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!value) throw new Error(`Missing button ${text}`);
  return value;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function fill(value: string) {
  await act(async () => {
    const element = node.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "form textarea, form input",
    )!;
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function choose(label: string, value: string) {
  const trigger = document.querySelector<HTMLElement>(
    `[role="combobox"][aria-label="${label}"]`,
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await settle(() =>
    expect(document.querySelector('[role="listbox"]')).not.toBeNull(),
  );
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.trim() === value);
  if (!option) throw new Error(`Missing option ${value}`);
  await click(option);
}
async function mount(path = `/recipes/${damagedItemFixture.recipeId}`) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/recipes" element={<RecipesPage />} />
            <Route path="/recipes/:recipeId" element={<RecipePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle(() => expect(node.querySelector("h1")).not.toBeNull());
}
beforeEach(() => {
  savedRun = null;
  demonstrationSteps = [];
  vi.mocked(setClientAppState).mockClear();
  backtestResult = async ({ recipe }) => report(recipe);
  compareResult = async ({ baseline, candidate }) => ({
    baseline: report(baseline),
    candidate: { ...report(candidate), summary: { ...report(candidate).summary, sameOutcome: 0, differentOutcome: 10, nonOutcomeOnly: 0 } },
    summary: { tokens: { input: 40, output: 20 }, totalTokens: 60, unknownUsageCases: 0, sharedRequestExtractionTokens: { input: 40, output: 20 } },
    cases: report(baseline).cases.map((item) => ({ caseId: item.caseId, baselineStatus: item.status, candidateStatus: "different", changed: true, nonOutcomeOnly: false,
      diff: [{ kind: "changed", classification: "outcome", path: "/0/input/amount/amountMinor", historical: 19000, intended: 38000 }] })),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  record = {
    recipe: {
      id: damagedItemFixture.recipeId,
      name: damagedItemFixture.name,
      status: "draft",
      activeVersionId: null,
    },
    versions: [damagedItemFixture],
    draft: null,
    runs: [],
  };
  const store: RecipeStudioStore = {
    list: async () => [record],
    get: async () => record,
    transaction: async (_id, work) =>
      work({
        get: async () => record,
        saveDraft: async (draft) => {
          record = { ...record, draft };
        },
        saveRecipe: async (recipe) => {
          record = { ...record, recipe };
        },
        saveVersion: async (version) => {
          record = { ...record, versions: [...record.versions, version] };
        },
      }),
  };
  studio = new RecipeStudio(store, () => "ver_ui2");
  calls = [];
  agent.send.mockClear();
  agentSource = false;
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url, "http://localhost");
      const name = parsed.pathname.split("/").pop()!;
      const method = init.method ?? "GET";
      if (name === "get-actions-batch")
        return Response.json({}, { status: 404 });
      const input =
        method === "GET"
          ? Object.fromEntries(parsed.searchParams)
          : JSON.parse(String(init.body ?? "{}"));
      calls.push({ name, input, method });
      try {
        let result: unknown;
        switch (name) {
          case "list-recipe-runs":
            result = savedRun ? [{ id: savedRun.id, createdAt: savedRun.createdAt }] : [];
            break;
          case "get-recipe-run":
            result = savedRun;
            break;
          case "list-recipes":
            result = await studio.list();
            break;
          case "get-recipe":
            result = await studio.get(input.recipeId);
            break;
          case "get-recipe-draft":
            result = input.versionId ? { demonstrationId: "demo_ui", draft: record.versions[0] } : await studio.getDraft(input.recipeId);
            break;
          case "get-demonstration":
            result = { id: "demo_ui", steps: demonstrationSteps, source: agentSource ? { kind: "agent_run", threadId: "thread_ui", runIds: ["run_ui"] } : { kind: "teach" }, trigger: { type: "damaged_item", requestId: "req_0001", orderId: "ord_1001", productId: "prod_platter" } };
            break;
          case "update-recipe-draft":
            result = await studio.update(input);
            break;
          case "save-recipe-version":
            result = await studio.save(input);
            break;
          case "activate-recipe":
            result = await studio.activate(input);
            break;
          case "deactivate-recipe":
            result = await studio.deactivate(input.recipeId);
            break;
          case "retry-recipe-skill":
            result = await studio.syncSkill(input.recipeId);
            break;
          case "backtest-recipe":
            result = await backtestResult(input);
            break;
          case "compare-recipe-versions":
            result = await compareResult(input);
            break;
          default:
            return Response.json({ error: name }, { status: 404 });
        }
        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          { status: 409 },
        );
      }
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  node.remove();
  vi.unstubAllGlobals();
});
describe("Recipe Studio UI", () => {
  it("shows a failed discovery sync and retries through the shared action", async () => {
    let retryable = true;
    const get = studio.get.bind(studio);
    vi.spyOn(studio, "get").mockImplementation(async id => ({ ...await get(id), skillPublication: {
      status: retryable ? "failed" : "published", versionId: damagedItemFixture.id,
      retryable, message: retryable ? "Retry discovery sync" : null,
    } }));
    vi.spyOn(studio, "syncSkill").mockImplementation(async () => {
      retryable = false;
      return { status: "published", versionId: damagedItemFixture.id, retryable: false, message: null };
    });
    await mount();
    expect(node.textContent).toContain("Agent recipe discovery needs to sync");
    await click(button("Retry discovery sync"));
    await settle(() => expect(node.textContent).not.toContain("Agent recipe discovery needs to sync"));
    expect(calls.some(call => call.name === "retry-recipe-skill" && call.input.recipeId === damagedItemFixture.recipeId)).toBe(true);
  });
  it("delegates crystallization with the draft, ambiguity and request context through agent chat only", async () => {
    record = { ...record, draft: {
      ...(await studio.getDraft(record.recipe.id)),
      ambiguities: [{ kind: "request-specific-text", stepId: "reply", argumentPath: "template", fragments: ["Ember serving platter"], candidates: [] }],
    } };
    await mount(`/recipes/${record.recipe.id}`);
    await settle(() => expect(button("Crystallize with agent").disabled).toBe(false));
    const before = calls.length;
    await click(button("Crystallize with agent"));
    expect(agent.send).toHaveBeenCalledTimes(1);
    const sent = agent.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ submit: true, openSidebar: true, message: expect.stringContaining("at most two questions") });
    expect(sent.message).not.toMatch(/productId|refund|get-customer|shipping recipient/);
    expect(JSON.parse(sent.context)).toMatchObject({
      workflow: "crystallize", recipeId: record.recipe.id, draftId: record.versions[0]!.id,
      revision: 0, ambiguityCount: 1, demonstrationId: "demo_ui",
      request: { requestId: "req_0001", type: "damaged_item", productId: "prod_platter" },
      ambiguities: [expect.objectContaining({ kind: "request-specific-text", question: expect.stringContaining("Ember serving platter") })],
    });
    expect(calls).toHaveLength(before);
    expect(calls.every(call => ["get-recipe", "get-recipe-draft", "get-demonstration", "list-recipe-runs", "get-recipe-run"].includes(call.name))).toBe(true);
  });
  it("offers unresolved ambiguities above the circuit and scrolls to and focuses their existing panel", async () => {
    record = { ...record, draft: { ...(await studio.getDraft(record.recipe.id)),
      ambiguities: [{ kind: "request-specific-text", stepId: "reply", argumentPath: "template", fragments: ["Maya"] }],
    } };
    await mount();
    const notice = node.querySelector<HTMLElement>(".recipe-circuit-ambiguity-notice")!;
    expect(notice.textContent).toContain("1 ambiguity to review");
    expect(Boolean(notice.compareDocumentPosition(node.querySelector(".recipe-legend")!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    const panel = node.querySelector<HTMLElement>("#recipe-ambiguities")!;
    panel.scrollIntoView = vi.fn();
    const before = calls.length;
    await click(button("Review ambiguities"));
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("aria-label")).toBe("Ambiguities");
    expect(calls).toHaveLength(before);
  });
  it.each([false, true])("shows the stored source provenance in Studio (agent=%s)", async isAgent => {
    agentSource = isAgent;
    await mount(`/recipes/${record.recipe.id}`);
    await settle(() => expect(node.textContent).toContain(isAgent ? "Learned from an agent run · thread thread_ui" : "Learned from Teach · demo_ui"));
  });
  it("lists status/version/runs/result and links into the detail route", async () => {
    await mount("/recipes");
    expect(node.textContent).toContain("Not run yet");
    expect(node.textContent).toContain("v1");
    await click(
      node.querySelector<HTMLAnchorElement>(
        `a[href="/recipes/${damagedItemFixture.recipeId}"]`,
      )!,
    );
    await settle(() =>
      expect(node.textContent).toContain("When to use this recipe"),
    );
    expect(node.textContent).toContain("Issue refund");
    expect(node.textContent).toContain("50%");
    expect(
      node.querySelectorAll('[data-source="formula"]').length,
    ).toBeGreaterThan(0);
    expect(
      node.querySelectorAll('[data-source="trigger"]').length,
    ).toBeGreaterThan(0);
    expect(button("Run backtest").disabled).toBe(false);
    expect(node.textContent).not.toContain("TASK-");
  });
  it("opens the accepted stored broken-platter draft and labels all derived bindings readably", async () => {
    const version = parseRecipeVersion(brokenPlatterDraft);
    record = {
      ...record,
      recipe: { ...record.recipe, id: version.recipeId, name: version.name },
      versions: [version],
    };
    await mount(`/recipes/${version.recipeId}`);
    expect(node.textContent).toContain(
      "50% × unit price of the line matching productId",
    );
    expect(node.textContent).toContain("First name · recipient");
    expect(node.querySelector(".recipe-message")?.textContent).toContain(
      "We have refunded Refund amount, half of its price",
    );
    expect(node.querySelector(".recipe-message")?.textContent).not.toContain(
      " + ",
    );
    expect(
      node.querySelector(".recipe-message .recipe-inline-wire"),
    ).not.toBeNull();
    expect(
      node.querySelector('button[aria-label="Edit variables"]'),
    ).toBeNull();
    expect(
      [...node.querySelectorAll("button")].some(
        (button) => button.textContent === "Agent sidebar",
      ),
    ).toBe(false);
    expect(node.textContent).toContain("Ember serving platter");
    expect(node.textContent).not.toContain("[object Object]");
    expect(button("Save new version").disabled).toBe(false);
    expect(record.versions[0]).toEqual(version);
  });
  it("edits a constant via action transport, saves an immutable v2 and activates that selected version", async () => {
    await mount();
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Reason"]',
      )!,
    );
    await fill('"A kinder refund reason"');
    await submit();
    await settle(() =>
      expect(node.textContent).toContain("A kinder refund reason"),
    );
    expect(
      calls.find((call) => call.name === "update-recipe-draft"),
    ).toMatchObject({ method: "POST", input: { expectedRevision: 0 } });
    await click(button("Save new version"));
    await settle(() => expect(node.textContent).toContain("v2"));
    expect(record.versions[0]).toEqual(damagedItemFixture);
    expect(record.recipe.status).toBe("draft");
    await click(button("Activate v2"));
    await settle(() => expect(record.recipe.activeVersionId).toBe("ver_ui2"));
    expect(
      calls.some(
        (call) =>
          call.name === "activate-recipe" && call.input.versionId === "ver_ui2",
      ),
    ).toBe(true);
  });
  it("renders event, approval and binding history in the card vocabulary", async () => {
    const version = parseRecipeVersion(brokenPlatterDraft);
    const steps = structuredClone(version.steps) as any[];
    const initial = parseRecipeVersion({ ...version, steps });
    record = {
      ...record,
      recipe: { ...record.recipe, id: initial.recipeId, name: initial.name },
      versions: [initial],
    };
    const draft = await studio.getDraft(initial.recipeId);
    const edited = structuredClone(draft.content) as any;
    edited.steps[1].approval = { ">": [{ var: "input.amount.amountMinor" }, 10000] };
    edited.steps[1].args.reason = { mode: "template", template: "Damage to {{trigger.productId}}" };
    edited.steps[1].args.orderId = { mode: "path", path: "steps.step_2.output.id" };
    edited.steps[1].args.amount.amountMinor.expr["*"][1] = 0.25;
    await studio.update({ recipeId: initial.recipeId, expectedRevision: draft.revision, content: edited });
    await studio.save({ recipeId: initial.recipeId, expectedRevision: draft.revision + 1 });
    await mount(`/recipes/${initial.recipeId}`);
    const history = node.querySelector(".recipe-history > li")!;
    const details = history.querySelector("details")!;
    await act(async () => { details.open = true; });
    expect(history.querySelector("p")?.textContent).toContain("A customer request arrives");
    expect(history.querySelector("p")?.textContent).not.toContain("request.created");
    const diff = history.querySelector(".recipe-diff")!;
    expect(diff.textContent).toContain("Never → When refund amount > $100.00");
    expect(diff.textContent).not.toContain("10000");
    expect(diff.querySelectorAll("li")).toHaveLength(4);
    expect(diff.textContent).toContain("Trigger field");
    expect(diff.textContent).toContain("Step output");
    expect(diff.textContent).toContain("Constant");
    expect(diff.textContent).toContain("Formula");
    expect(diff.textContent).toContain("Template");
    expect(diff.textContent).toContain("25% × unit price");
  });
  it("uses the latest run currency in money cards, history and separate short ambiguity choices", async () => {
    const version = parseRecipeVersion(brokenPlatterDraft);
    const initial = { ...version, id: "ver_initial", version: 1 };
    const steps = structuredClone(version.steps) as any[];
    steps[1].approval = { ">": [{ var: "input.amount.amountMinor" }, 10000] };
    const candidate = parseRecipeVersion({ ...version, id: "ver_candidate", version: 2, steps });
    const keyed = steps[1].args.amount.amountMinor;
    const first = { mode: "expr", expr: { "*": [0.5, { var: "steps.step_2.output.items[0].unitPrice.amountMinor" }] } };
    const entry = { stepId: "step_6", argumentPath: "amount.amountMinor", kind: "multiple-candidates", candidates: [
      { binding: keyed }, { binding: first }, { binding: { mode: "fixed", value: 14000 } },
    ] };
    record = { ...record, recipe: { ...record.recipe, id: version.recipeId }, versions: [initial, candidate],
      draft: { recipeId: version.recipeId, revision: 0, baseVersionId: candidate.id, content: { name: candidate.name, trigger: candidate.trigger, steps: steps }, ambiguities: [entry] },
    };
    demonstrationSteps = [{ id: "step_6", input: { amount: { amountMinor: 14000, currency: "GBP" } }, output: null }];
    savedRun = { id: "run_latest", createdAt: 20, trigger: {}, steps: [{ stepId: "step_6", input: { amount: { amountMinor: 14000, currency: "EUR" } }, output: null }] };
    await mount(`/recipes/${version.recipeId}`);
    await settle(() => expect(node.querySelector(".recipe-diff")?.textContent).toContain("Never → When refund amount > €100.00"));
    const panel = node.querySelector('[aria-label="Ambiguities"]')!;
    expect([...panel.querySelectorAll(".recipe-ambiguities > li > ul > li")].map((item) => item.textContent)).toEqual([
      "50% of the item's unit price", "50% of the first item's unit price", "a fixed €140.00",
    ]);
    expect(panel.querySelector("p")?.textContent).not.toContain("unitPrice");
    expect(panel.querySelector("pre")?.textContent).toContain("steps.step_2.output.items[0].unitPrice.amountMinor");
    expect(node.querySelector('[aria-label="Issue refund"] .recipe-approval')?.textContent).toContain("When refund amount > €100.00");
    expect(node.textContent).not.toContain("in unit price → currency");
    expect(record.draft!.ambiguities).toEqual([entry]);
  });
  it("uses the stored name, and carries an edited name through save, active history and the list", async () => {
    const initial = { ...damagedItemFixture, name: "Draft: damaged_item" };
    record = { ...record, recipe: { ...record.recipe, name: initial.name }, versions: [initial] };
    await mount();
    expect(node.querySelector("h1")?.textContent).toBe(initial.name);
    expect(node.querySelector(".recipe-history summary")?.textContent).toContain(initial.name);
    await click(node.querySelector<HTMLButtonElement>('button[aria-label="Edit Name"]')!);
    await fill("Damaged platter care");
    await submit();
    await settle(() => expect(node.querySelector("h1")?.textContent).toBe("Damaged platter care"));
    await click(button("Save new version"));
    await settle(() => expect(record.versions[1]?.name).toBe("Damaged platter care"));
    expect(record.versions[0]).toEqual(initial);
    expect(node.querySelector(".recipe-history summary")?.textContent).toContain("Damaged platter care");
    await click(button("Activate v2"));
    await settle(() => expect(node.querySelector(".recipe-history summary")?.textContent).toContain("Damaged platter care · Active"));
    await click(node.querySelector<HTMLAnchorElement>('a[href="/recipes"]')!);
    await settle(() => expect(node.querySelector(".recipe-table tbody th")?.textContent).toContain("Damaged platter care"));
    expect(node.querySelector(".recipe-table")?.textContent).not.toContain("Draft: damaged_item");
  });
  it("renders extract/handoff steps and edits templates through the shared draft action", async () => {
    record = {
      ...record,
      versions: [
        {
          ...damagedItemFixture,
          steps: [
            ...damagedItemFixture.steps,
            {
              id: "extract_extra",
              kind: "extract",
              text: { mode: "template", template: "{{trigger.subject}}" },
              fields: { sentiment: { type: "string", required: true } },
            },
            {
              id: "handoff_extra",
              kind: "handoff",
              to: "human",
              note: {
                mode: "template",
                template: "Review {{trigger.requestId}}",
              },
            },
          ],
        },
      ],
    };
    await mount();
    expect(node.textContent).toContain("Extract text");
    expect(node.textContent).toContain("consumes model tokens");
    expect(
      node.querySelectorAll('.recipe-message[data-source="template"]'),
    ).toHaveLength(2);
    await click(
      node.querySelector<HTMLButtonElement>('button[aria-label="Edit Text"]')!,
    );
    await fill("Summary: {{trigger.subject}}");
    await submit();
    await settle(() =>
      expect(node.textContent).toContain("Summary: subject · Request"),
    );
    expect(atPath(record.draft!.content, ["steps", 2, "text"])).toEqual({
      mode: "template",
      template: "Summary: {{trigger.subject}}",
    });
    expect(
      calls.filter((call) => call.method === "POST").map((call) => call.name),
    ).toEqual(["update-recipe-draft"]);
  });
  it("edits formulas and per-step approval conditions without executing a recipe", async () => {
    await mount();
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Refund amount"]',
      )!,
    );
    await fill(
      '{"ceil":[{"*":[{"var":"steps.order.output.items[0].unitPrice.amountMinor"},0.25]}]}',
    );
    await submit();
    await settle(() => expect(node.textContent).toContain("25%"));
    const refund = node.querySelector('article[aria-label="Issue refund"]')!;
    await click(
      refund.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Ask for approval"]',
      )!,
    );
    await choose("Approval policy", "Never");
    await submit();
    await settle(() =>
      expect(
        atPath(record.draft!.content, ["steps", 1, "then", 0, "approval"]),
      ).toBe(false),
    );
    expect(
      calls
        .filter((call) => call.method === "POST")
        .every((call) => call.name === "update-recipe-draft"),
    ).toBe(true);
  });
  it("asks plain-language ambiguity questions and counts identity duplicates only under collapsed Minor", async () => {
    const version = parseRecipeVersion(brokenPlatterDraft);
    record = {
      ...record,
      recipe: { ...record.recipe, id: version.recipeId, name: version.name },
      versions: [version],
    };
    const base = await studio.getDraft(version.recipeId);
    const entries = [
      {
        stepId: "step_6",
        argumentPath: "amount.amountMinor",
        kind: "constant-or-variable",
        candidates: [],
      },
      {
        stepId: "step_7",
        argumentPath: "template",
        kind: "request-specific-text",
        fragments: ["Ember serving platter"],
        candidates: [],
      },
      {
        stepId: "step_6",
        argumentPath: "orderId",
        kind: "multiple-candidates",
        candidates: [
          {
            reason: "exact-match",
            binding: { mode: "path", path: "trigger.orderId" },
          },
          {
            reason: "exact-match",
            binding: { mode: "path", path: "steps.step_2.output.id" },
          },
          { reason: "constant", binding: { mode: "fixed", value: "ord_1001" } },
        ],
      },
    ];
    record = { ...record, draft: { ...base, ambiguities: entries } };
    await mount(`/recipes/${version.recipeId}`);
    const panel = node.querySelector('[aria-label="Ambiguities"]')!;
    expect(panel.querySelector(".recipe-count")?.textContent).toBe("2");
    const questions = [
      ...panel.querySelectorAll(".recipe-ambiguities > li > p"),
    ].map((item) => item.textContent);
    expect(questions).toContain(
      "Is 50% of the item price a rule or a one-off?",
    );
    expect(questions).toContain(
      "Mentions “Ember serving platter”; should it change per request?",
    );
    expect(panel.textContent).toContain("Refund amount");
    expect(panel.textContent).toContain("Save reply");
    const minor = panel.querySelector<HTMLDetailsElement>(".recipe-minor")!;
    expect(minor.open).toBe(false);
    expect(minor.querySelector("summary")?.textContent).toBe("Minor (1)");
    expect(panel.querySelector("pre")?.textContent).toContain(
      "constant-or-variable",
    );
    expect(record.draft!.ambiguities).toEqual(entries);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("authors dollar approval conditions with structured controls and preserves an Advanced fallback", async () => {
    const version = parseRecipeVersion(brokenPlatterDraft);
    record = {
      ...record,
      recipe: { ...record.recipe, id: version.recipeId, name: version.name },
      versions: [version],
    };
    await mount(`/recipes/${version.recipeId}`);
    const refund = node.querySelector('article[aria-label="Issue refund"]')!;
    await click(
      refund.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Ask for approval"]',
      )!,
    );
    expect(
      node.querySelector('[role="combobox"][aria-label="Approval policy"]')
        ?.textContent,
    ).toContain("Never");
    expect(node.querySelector("details[open] textarea")).toBeNull();
    await choose("Approval policy", "When");
    expect(
      node.querySelector('[role="combobox"][aria-label="Argument to check"]')
        ?.textContent,
    ).toContain("Refund amount");
    await fill("100.25");
    await submit();
    await settle(() =>
      expect(atPath(record.draft!.content, ["steps", 1, "approval"])).toEqual({
        ">": [{ var: "input.amount.amountMinor" }, 10025],
      }),
    );
    expect(refund.textContent).toContain("When refund amount > $100.25");
    await click(
      refund.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Ask for approval"]',
      )!,
    );
    await choose("Approval policy", "Always");
    await submit();
    await settle(() =>
      expect(atPath(record.draft!.content, ["steps", 1, "approval"])).toBe(
        true,
      ),
    );
    await click(
      refund.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Ask for approval"]',
      )!,
    );
    const advanced = node.querySelector<HTMLDetailsElement>("form details")!;
    await act(async () => {
      advanced.open = true;
      advanced.dispatchEvent(new Event("toggle"));
    });
    await fill('{"<":[{"var":"input.amount.amountMinor"},5000]}');
    await submit();
    await settle(() =>
      expect(atPath(record.draft!.content, ["steps", 1, "approval"])).toEqual({
        "<": [{ var: "input.amount.amountMinor" }, 5000],
      }),
    );
    expect(
      calls
        .filter((call) => call.method === "POST")
        .every((call) => call.name === "update-recipe-draft"),
    ).toBe(true);
  });
  it("shows JSON and DSL errors inline and disables saving an invalid draft", async () => {
    await mount();
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Only when"]',
      )!,
    );
    await fill('{"eval":');
    await submit();
    await settle(() => expect(node.textContent).toContain("Enter valid JSON"));
    expect(calls.some((call) => call.name === "update-recipe-draft")).toBe(
      false,
    );
    await fill('{"eval":["unsafe"]}');
    await submit();
    await settle(() => expect(node.textContent).toContain("Fix these fields"));
    expect(button("Save new version").disabled).toBe(true);
    expect(node.textContent).toContain("trigger.match");
  });
  it("reflects agent updates through action query invalidation and preserves source ambiguity entries", async () => {
    await mount();
    const draft = await studio.getDraft(record.recipe.id);
    await studio.update({
      recipeId: record.recipe.id,
      expectedRevision: draft.revision,
      content: { ...draft.content, name: "Agent edited care" } as JsonObject,
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["action"] });
    });
    await settle(() =>
      expect(node.querySelector("h1")?.textContent).toBe("Agent edited care"),
    );
  });
});
describe("Recipe Studio historical backtests", () => {
  it("stays idle through load/refetch and allows activation with an honest nudge", async () => {
    await mount();
    expect(node.textContent).toContain("No backtest shown for this version");
    expect(node.textContent).toContain("Resolved Damaged item requests");
    expect(node.textContent).toContain("may spend tokens");
    expect(node.querySelector('[aria-label="Backtest before activating v1"]')?.textContent).toContain("You can still activate without one");
    await act(async () => { await client.invalidateQueries({ queryKey: ["action"] }); });
    expect(calls.some((call) => call.name === "backtest-recipe" || call.name === "compare-recipe-versions")).toBe(false);
    expect(vi.mocked(setClientAppState).mock.calls.slice(-1)[0]?.[1]).toBeNull();
    await click(button("Activate v1"));
    await settle(() => expect(record.recipe.activeVersionId).toBe(damagedItemFixture.id));
  });
  it("runs once on click, shows counts/diffs/links/tokens, and keeps evidence tied to the tested saved version", async () => {
    let finish!: (value: ShopBacktestResult) => void;
    backtestResult = () => new Promise((resolve) => { finish = resolve; });
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(button("Running backtest…").disabled).toBe(true));
    await click(button("Running backtest…"));
    expect(calls.filter((call) => call.name === "backtest-recipe")).toEqual([
      { name: "backtest-recipe", method: "GET", input: { recipe: damagedItemFixture.id, requestType: "damaged_item" } },
    ]);
    await act(async () => finish(report(damagedItemFixture.id)));
    await settle(() => expect(node.textContent).toContain("8 same outcome · 2 different outcome · 0 not handled"));
    expect(node.textContent).toContain("60 tokens spent");
    expect(node.textContent).toContain("$380.00");
    expect(node.textContent).toContain("$190.00");
    expect(node.textContent).toContain("Create replacement");
    expect(node.textContent).toContain("Please send packaging photos");
    expect(node.textContent).toContain("1 differs only in wording or tags");
    const wordingCase = node.querySelector('a[href="/requests/req_0040"]')?.closest("li");
    expect(wordingCase?.textContent).toContain("Same outcome; only wording or tags differ");
    expect(wordingCase?.textContent).toContain("Wording difference");
    expect(wordingCase?.querySelector("details")?.open).toBe(true);
    expect(node.querySelector('a[href="/requests/req_0039"]')).not.toBeNull();
    expect(node.querySelector('[aria-label="Backtest before activating v1"]')?.textContent).toContain("8 same outcome · 2 different outcome");
    expect(setClientAppState).toHaveBeenLastCalledWith(expect.stringMatching(/^recipe-backtest:/), expect.objectContaining({
      recipeId: record.recipe.id, source: "backtest", requestType: "damaged_item", totalTokens: 60,
      reports: [expect.objectContaining({ recipeVersionId: damagedItemFixture.id, version: 1, summary: expect.objectContaining({ sameOutcome: 8, nonOutcomeOnly: 1 }) })],
    }), expect.any(Object));
    await click(button("Save new version"));
    await settle(() => expect(node.querySelector('[aria-label="Backtest before activating v2"]')?.textContent).toContain("Run a backtest for this version"));
    expect(node.querySelector('[aria-label="Backtest before activating v1"]')?.textContent).toContain("8 same outcome · 2 different outcome");
    expect(node.querySelector('[aria-label="Backtest version"]')?.textContent).toContain("v2");
    expect(node.textContent).toContain("No backtest shown for this version");
    await choose("Backtest version", `v1 · ${damagedItemFixture.name}`);
    expect(node.querySelector(".recipe-backtest-cases")?.textContent).toContain("req_0039");
    await click(node.querySelector<HTMLAnchorElement>('a[href="/recipes"]')!);
    await settle(() => expect(setClientAppState).toHaveBeenLastCalledWith(expect.stringMatching(/^recipe-backtest:/), null, expect.any(Object)));
  });
  it("formats whole money, removed item lists and added operations in backtest diffs", async () => {
    backtestResult = async ({ recipe }) => {
      const result = report(recipe);
      const item = result.cases[7]!;
      return { ...result, cases: [{ ...item,
        diff: [
          { kind: "added", classification: "outcome", path: "/0/input/amount", intended: { currency: "USD", amountMinor: 2100 } },
          { kind: "removed", classification: "outcome", path: "/0/input/items", historical: [{ productId: "prd_0016", quantity: 1 }] },
          { kind: "added", classification: "outcome", path: "/1", intended: { action: "tag-request", input: { requestId: "req_0038", tag: "replacement" } } },
        ],
        run: { trigger: {}, steps: [{ stepId: "order", input: {}, output: { items: [{ productId: "prd_0016", name: "Chalk Plate", quantity: 1 }] } }] } as any,
      }] };
    };
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(node.querySelector(".recipe-backtest-cases")?.textContent).toContain("$21.00"));
    const diff = node.querySelector(".recipe-backtest-cases .recipe-diff")!;
    expect(diff.textContent).toContain("Refund amount");
    expect(diff.textContent).toContain("Chalk Plate × 1");
    expect(diff.textContent).toContain("Add tag “replacement”");
    expect(diff.textContent).not.toContain("amountMinor");
    expect(diff.textContent).not.toContain("productId");
    expect(diff.textContent).not.toContain("requestId");
  });
  it("shows tag bookkeeping as a grouped transition without changing the customer outcome", async () => {
    backtestResult = async ({ recipe }) => {
      const result = report(recipe);
      return { ...result, summary: { ...result.summary, nonOutcomeOnly: 2 }, cases: result.cases.map((item, index) => index ? item : {
        ...item, historicalMutations: [
          { action: "tag-request", input: { requestId: item.caseId, tag: "damaged_item" } },
          { action: "tag-request", input: { requestId: item.caseId, tag: "handled" } },
        ], intendedMutations: [{ action: "tag-request", input: { requestId: item.caseId, tag: "damaged" } }],
        diff: [
          { kind: "changed", classification: "bookkeeping", path: "/0/input/tag", historical: "damaged_item", intended: "damaged" },
          { kind: "removed", classification: "bookkeeping", path: "/1", historical: { action: "tag-request", input: { requestId: item.caseId, tag: "handled" } } },
        ],
      }) };
    };
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(node.textContent).toContain("2 differ only in wording or tags"));
    const item = node.querySelector('a[href="/requests/req_0031"]')?.closest("li");
    expect(item?.textContent).toContain("Same outcome");
    expect(item?.textContent).toContain("Tags · Bookkeeping difference");
    expect(item?.querySelector("del")?.textContent).toBe("damaged_item, handled");
    expect(item?.querySelector("ins")?.textContent).toBe("damaged");
    expect(item?.querySelector("details")?.open).toBe(true);
    const previous = backtestResult;
    backtestResult = async (input) => {
      const result = await previous(input);
      return { ...result, cases: result.cases.map((entry, index) => index ? entry : { ...entry,
        intendedMutations: [{ action: "tag-request", input: { requestId: "req_0002", tag: "damaged" } }],
        diff: [...entry.diff, { kind: "changed", classification: "bookkeeping", path: "/0/input/requestId", historical: entry.caseId, intended: "req_0002" }],
      }) };
    };
    await click(button("Run backtest"));
    await settle(() => expect(node.querySelector('a[href="/requests/req_0031"]')?.closest("li")?.querySelector("ins")?.textContent).toBe("req_0002: damaged"));
  });
  it("renders a partial report with unknown total usage and retains it in the shown summary", async () => {
    backtestResult = async ({ recipe }) => {
      const result = report(recipe);
      return { ...result, summary: { ...result.summary, sameOutcome: 7, notHandled: 1, unknownUsageCases: 1, totalTokens: null,
        tokens: { input: 32, output: 16 } }, cases: result.cases.map((item, index) => index ? item : {
        ...item, status: "not_handled", run: null, diff: [], intendedMutations: [],
        reasons: [{ code: "reconstruction-failed", message: "Couldn't reconstruct this request from its message: missing quantity. Extraction usage is unknown." }],
      }) };
    };
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(node.textContent).toContain("7 same outcome · 2 different outcome · 1 not handled"));
    expect(node.textContent).toContain("missing quantity");
    expect(node.textContent).toContain("48 known tokens · requests with unknown usage: 1");
    expect(node.textContent).not.toContain("60 tokens spent");
    expect(setClientAppState).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ totalTokens: null,
      reports: [expect.objectContaining({ summary: expect.objectContaining({ unknownUsageCases: 1, totalTokens: null }) })],
    }), expect.any(Object));
  });
  it("keeps customer diff labels and currency aligned when tags preceded the refund in the original trace", async () => {
    backtestResult = async ({ recipe }) => {
      const result = report(recipe);
      const tag = { action: "tag-request", input: { requestId: "req_0039", tag: "handled" } };
      return { ...result, cases: [{ ...result.cases[8]!,
        historicalMutations: [tag, { action: "issue-refund", input: { amount: { amountMinor: 38000, currency: "EUR" } } }],
        intendedMutations: [tag, { action: "issue-refund", input: { amount: { amountMinor: 19000, currency: "EUR" } } }],
      }] };
    };
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(node.querySelector(".recipe-diff")?.textContent).toContain("€380.00"));
    expect(node.querySelector(".recipe-diff")?.textContent).toContain("€190.00");
    expect(node.querySelector(".recipe-diff")?.textContent).toContain("Refund amount");
  });
  it("shows a retryable error without inventing a report, spending totals, or retrying automatically", async () => {
    backtestResult = async () => { throw new Error("Request req_0039 could not be reconstructed: Extraction is not configured."); };
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(node.querySelector('[role="alert"]')?.textContent).toContain("No new report was produced"));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Request req_0039 could not be reconstructed: Extraction is not configured.");
    expect(node.querySelector('[role="alert"]')?.textContent?.match(/extraction may have spent tokens/gi)).toHaveLength(1);
    expect(node.textContent).not.toContain("60 tokens spent");
    expect(node.querySelector(".recipe-backtest-cases")).toBeNull();
    expect(calls.filter((call) => call.name === "backtest-recipe")).toHaveLength(1);
    backtestResult = async ({ recipe }) => report(recipe);
    await click(button("Run backtest"));
    await settle(() => expect(node.querySelector(".recipe-backtest-cases")).not.toBeNull());
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });
  it("explains not-handled mutation-output dependencies plainly while preserving real counts", async () => {
    backtestResult = async ({ recipe }) => {
      const value = report(recipe);
      return { ...value, summary: { ...value.summary, sameOutcome: 0, differentOutcome: 0, notHandled: 10, nonOutcomeOnly: 0 }, cases: value.cases.map((item) => ({
        ...item, status: "not_handled", reasons: [{ code: "blocked", message: "Depends on an unavailable dry-run output", blockedBy: ["refund"] }],
      })) };
    };
    await mount();
    await click(button("Run backtest"));
    await settle(() => expect(node.textContent).toContain("0 same outcome · 0 different outcome · 10 not handled"));
    expect(node.textContent).toContain("Backtests skip real changes, so that result is unavailable");
    expect(node.querySelector(".recipe-backtest-cases")?.textContent).toContain("Not handled");
    expect(button("Activate v1").disabled).toBe(false);
  });
  it("defaults comparison to active vs latest, shows paired outcomes and shared tokens, and never auto-runs it", async () => {
    const second = parseRecipeVersion({ ...damagedItemFixture, id: "ver_active", version: 2 });
    const latest = parseRecipeVersion({ ...damagedItemFixture, id: "ver_latest", version: 3 });
    record = { ...record, recipe: { ...record.recipe, status: "active", activeVersionId: second.id }, versions: [damagedItemFixture, second, latest] };
    await mount();
    expect(node.querySelector('[aria-label="Baseline version"]')?.textContent).toContain("v2");
    expect(node.querySelector('[aria-label="Candidate version"]')?.textContent).toContain("v3");
    const comparison = node.querySelector<HTMLDetailsElement>(".recipe-backtest-comparison")!;
    await act(async () => { comparison.open = true; });
    expect(calls.some((call) => call.name === "compare-recipe-versions")).toBe(false);
    await click(button("Compare versions"));
    await settle(() => expect(comparison.textContent).toContain("v2 → v3 on the same requests"));
    expect(calls.find((call) => call.name === "compare-recipe-versions")).toEqual({ name: "compare-recipe-versions", method: "GET", input: { baseline: second.id, candidate: latest.id, requestType: "damaged_item" } });
    expect(comparison.textContent).toContain("10 of 10 request outcomes changed");
    expect(comparison.textContent).toContain("60 combined tokens spent · shared request extraction counted once");
    expect(comparison.textContent).toContain("Same outcome → Different outcome");
    expect(comparison.textContent).toContain("$190.00");
    expect(comparison.textContent).toContain("$380.00");
    expect(comparison.querySelector('a[href="/requests/req_0031"]')).not.toBeNull();
    expect(node.querySelector('[aria-label="Backtest before activating v3"]')?.textContent).toContain("0 same outcome · 10 different outcome");
    expect(setClientAppState).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ source: "comparison", totalTokens: 60, reports: expect.arrayContaining([
      expect.objectContaining({ recipeVersionId: second.id }), expect.objectContaining({ recipeVersionId: latest.id }),
    ]) }), expect.any(Object));
    await choose("Baseline version", `v1 · ${damagedItemFixture.name}`);
    expect(comparison.textContent).not.toContain("v2 → v3 on the same requests");
    expect(calls.filter((call) => call.name === "compare-recipe-versions")).toHaveLength(1);
  });
  it("shows wording-only version changes and retains their text without counting an outcome change", async () => {
    const second = parseRecipeVersion({ ...damagedItemFixture, id: "ver_wording", version: 2 });
    record = { ...record, versions: [damagedItemFixture, second] };
    compareResult = async ({ baseline, candidate }) => ({
      baseline: report(baseline), candidate: report(candidate),
      summary: { tokens: { input: 40, output: 20 }, totalTokens: 60, unknownUsageCases: 0, sharedRequestExtractionTokens: { input: 40, output: 20 } },
      cases: [{ caseId: "req_0040", baselineStatus: "identical", candidateStatus: "identical", changed: false, nonOutcomeOnly: true,
        diff: [{ kind: "changed", classification: "wording", path: "/1/input/body", historical: "Earlier reply words", intended: "Revised reply words" }] }],
    });
    await mount();
    await click(button("Compare versions"));
    const comparison = node.querySelector<HTMLDetailsElement>(".recipe-backtest-comparison")!;
    await settle(() => expect(comparison.textContent).toContain("0 of 1 request outcomes changed · 1 differs only in wording or tags"));
    expect(comparison.textContent).toContain("8 same outcome · 2 different outcome · 0 not handled — 1 differs only in wording or tags");
    expect(comparison.textContent).toContain("Same outcome → Same outcome · Only wording or tags changed");
    expect(comparison.textContent).toContain("Wording difference");
    expect(comparison.textContent).toContain("Earlier reply words");
    expect(comparison.textContent).toContain("Revised reply words");
  });
  it("handles comparison pending/error and disallows mismatched cohorts or identical version choices", async () => {
    const second = parseRecipeVersion({ ...damagedItemFixture, id: "ver_other", version: 2 });
    record = { ...record, versions: [damagedItemFixture, second] };
    let reject!: (error: Error) => void;
    compareResult = () => new Promise((_, fail) => { reject = fail; });
    await mount();
    await click(button("Compare versions"));
    await settle(() => expect(button("Comparing versions…").disabled).toBe(true));
    await act(async () => reject(new Error("Could not compare these versions")));
    await settle(() => expect(node.querySelector('[role="alert"]')?.textContent).toContain("Could not compare"));
    expect(node.textContent).not.toContain("combined tokens spent");
    await choose("Baseline version", `v2 · ${second.name}`);
    expect(button("Compare versions").disabled).toBe(true);
    expect(node.textContent).toContain("select two different versions");
    record = { ...record, versions: [...record.versions, parseRecipeVersion({ ...second, id: "ver_return", version: 3,
      trigger: { event: "request.created", match: { "===": [{ var: "trigger.type" }, "return"] } },
    })] };
    await act(async () => { await client.invalidateQueries({ queryKey: ["action"] }); });
    await choose("Candidate version", `v3 · ${second.name}`);
    expect(button("Compare versions").disabled).toBe(true);
    expect(node.textContent).toContain("same explicit request type");
  });
  it("requires an explicit trigger cohort rather than asking the operator or guessing", async () => {
    record = { ...record, versions: [parseRecipeVersion({ ...damagedItemFixture, trigger: { event: "request.created", match: true } })] };
    await mount();
    expect(button("Run backtest").disabled).toBe(true);
    expect(node.textContent).toContain("Set an explicit request type");
    const type = { "===": [{ var: "trigger.type" }, "damaged_item"] };
    expect(backtestRequestType({ and: [type, { ">": [{ var: "trigger.quantity" }, 0] }] })).toBe("damaged_item");
    expect(backtestRequestType({ "==": ["return", { var: "trigger.type" }] })).toBe("return");
    expect(backtestRequestType({ or: [type, { "===": [{ var: "trigger.type" }, "return"] }] })).toBeUndefined();
  });
});
describe("readable safe expression display", () => {
  it("renders find, scale/rounding, firstWord, money, cat and every existing allowlisted operator without executing expressions", () => {
    const price = {
      find: [
        { var: "steps.order.output.items" },
        "productId",
        { var: "trigger.productId" },
        "unitPrice.amountMinor",
      ],
    };
    expect(expressionLabel({ round: [{ "*": [price, 0.5] }] })).toContain(
      "50% × unit price of the line matching productId",
    );
    expect(
      expressionLabel({
        cat: [
          "Hi ",
          { firstWord: [{ var: "steps.customer.output.name" }] },
          { money: [10000, "USD", "symbol"] },
        ],
      }),
    ).toContain("First name");
    expect(expressionLabel({ money: [10000, "USD"] })).toBe(
      "$ amount of 10000",
    );
    expect(expressionLabel({ floor: [price] })).toContain("Round down(");
    expect(expressionLabel({ ceil: [price] })).toContain("Round up(");
    for (const op of [
      "==",
      "!=",
      "===",
      "!==",
      "<",
      "<=",
      ">",
      ">=",
      "+",
      "-",
      "*",
      "/",
      "%",
      "min",
      "max",
      "and",
      "or",
      "!",
      "!!",
      "if",
      "cat",
      "in",
    ])
      expect(expressionLabel({ [op]: [1, 2, 3] })).not.toContain(
        "[object Object]",
      );
  });
});
