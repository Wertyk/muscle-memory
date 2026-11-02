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
            result = await studio.getDraft(input.recipeId);
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
    expect(node.textContent).toContain("Reserved for TASK-18");
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
    expect(node.textContent).toContain("First name of");
    expect(node.textContent).toContain("Money amount of");
    expect(node.textContent).toContain("Ember serving platter");
    expect(node.textContent).not.toContain("[object Object]");
    expect(button("Save new version").disabled).toBe(false);
    expect(record.versions[0]).toEqual(version);
  });
  it("edits a constant via action transport, saves an immutable v2 and activates that selected version", async () => {
    await mount();
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit reason"]',
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
      node.querySelectorAll('.recipe-wire[data-source="template"]'),
    ).toHaveLength(2);
    await click(
      node.querySelector<HTMLButtonElement>('button[aria-label="Edit Text"]')!,
    );
    await fill("Summary: {{trigger.subject}}");
    await submit();
    await settle(() =>
      expect(node.textContent).toContain("Summary: {{trigger.subject}}"),
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
    const formulaField = node
      .querySelector('.recipe-wire[data-source="formula"]')!
      .closest(".recipe-field")!;
    await click(formulaField.querySelector<HTMLButtonElement>("button")!);
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
    await fill("false");
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
