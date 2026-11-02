// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MakerMark } from "./MakerMark";
import { DataText } from "./DataText";
import { CostTag } from "./CostTag";
import type { RecipeOutcome } from "@/lib/kiln";

const outcome: RecipeOutcome = { status: "completed", mode: "execute", recipeName: "Bowl care", version: 2, tokens: 20 };
const render = (node: React.ReactNode) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(node);
  return container;
};

describe("MakerMark", () => {
  it("names the actual recipe version and measured extraction + execution tokens", () => {
    const element = render(<MakerMark outcome={outcome} />);
    expect(element.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Handled by recipe Bowl care v2, 20 LLM tokens");
    expect(element.querySelectorAll("circle")).toHaveLength(2);
    expect(element.querySelectorAll("textPath")).toHaveLength(0);
    const large = render(<MakerMark outcome={outcome} size="large" />);
    expect(large.textContent).toContain("V2 · 20 TOKENS");
    expect(large.querySelector(".kiln-stamp-cost")?.textContent).not.toBe("V2 · 0 TOKENS");
  });
  it("uses distinct circular paths and truncates long visible names while retaining the accessible name", () => {
    const name = "A very long bowl care recipe with many specific instructions";
    const element = render(<><MakerMark outcome={{ ...outcome, recipeName: name, tokens: 0 }} size="large" /><MakerMark outcome={outcome} size="medium" /></>);
    expect(element.textContent).toContain("…");
    expect(element.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(name);
    const ids = [...element.querySelectorAll("path[id]")].map(path => path.id);
    expect(new Set(ids).size).toBe(4);
    expect(element.textContent).toContain("V2 · 0 TOKENS");
  });
  it("does not stamp pending, failed, handed-off or dry-run work", () => {
    for (const status of ["running", "awaiting_approval", "handed_off", "failed", "aborted"])
      expect(renderToStaticMarkup(<MakerMark outcome={{ ...outcome, status }} />)).toBe("");
    expect(renderToStaticMarkup(<MakerMark outcome={{ ...outcome, mode: "dry-run" }} />)).toBe("");
  });
  it("keeps unmeasured usage distinct from zero", () => {
    const element = render(<MakerMark outcome={{ ...outcome, tokens: null }} size="large" />);
    expect(element.textContent).toContain("UNMEASURED");
    expect(element.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("unknown LLM tokens");
  });
});

describe("CostTag", () => {
  it("formats zero-token recipe and compact measured agent cost", () => {
    expect(render(<CostTag tokens={0} durationMs={17} />).textContent).toBe("0 tokens · 17 ms");
    const agent = render(<CostTag handler="agent" tokens={95_000} durationMs={7500} />);
    expect(agent.textContent).toBe("95K tokens · 7.5 s");
    expect(agent.querySelector("[data-handler]")?.getAttribute("data-handler")).toBe("agent");
  });
  it("retains exact usage as a tooltip and omits unknown durations", () => {
    const element = render(<CostTag tokens={95_123} durationMs={null} />);
    expect(element.querySelector("span")?.title).toBe("95,123 LLM tokens");
    expect(element.textContent).toBe("95K tokens");
    expect(render(<CostTag tokens={null} />).textContent).toBe("Tokens unmeasured");
  });
});

describe("data typography", () => {
  it("retains narrative text and marks IDs and money as data figures", () => {
    const element = render(<DataText text="Refund $140.00 for ord_1042 on req_0001." />);
    expect(element.textContent).toBe("Refund $140.00 for ord_1042 on req_0001.");
    expect([...element.querySelectorAll(".kiln-data")].map(span => span.textContent)).toEqual(["$140.00", "ord_1042", "req_0001"]);
  });
});
