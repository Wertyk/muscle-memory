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

import brokenPlatterDraft from "../../../server/fixtures/broken-platter-draft.json";
import { damagedItemFixture } from "../../../server/fixtures/intake-recipes";
import { RecipePage } from "./RecipePage";
import { RecipesPage } from "./RecipesPage";
const agent = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@agent-native/core/client/agent-chat", () => ({ sendToAgentChat: agent.send }));
vi.mock("@agent-native/toolkit/app/chat", () => ({
  AgentToggleButton: () => <button>Agent sidebar</button>,
}));
vi.mock("@agent-native/core/client/i18n", () => ({
  useT:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          enUS,
        );
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
let calls: { name: string; input: Record<string, unknown>; method: string }[];
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
            result = { id: "demo_ui", trigger: { type: "damaged_item", requestId: "req_0001", orderId: "ord_1001", productId: "prod_platter" } };
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
    expect(calls.every(call => ["get-recipe", "get-recipe-draft", "get-demonstration"].includes(call.name))).toBe(true);
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
    expect(node.querySelector(".recipe-backtest-slot")?.textContent).toContain("Coming soon");
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
    steps[1].args.amount.currency = { mode: "fixed", value: "USD" };
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
    expect(diff.textContent).toContain("Never → When refund amount > $100");
    expect(diff.textContent).not.toContain("10000");
    expect(diff.querySelectorAll("li")).toHaveLength(4);
    expect(diff.textContent).toContain("Trigger field");
    expect(diff.textContent).toContain("Step output");
    expect(diff.textContent).toContain("Constant");
    expect(diff.textContent).toContain("Formula");
    expect(diff.textContent).toContain("Template");
    expect(diff.textContent).toContain("25% × unit price");
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
