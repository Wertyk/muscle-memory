import { describe, expect, it } from "vitest";

import { renderProofCard } from "./mechanism-ui";

describe("custom native chat renderer (offline)", () => {
  it("dispatches through the public AgentKit widget and renders the structured result safely", async () => {
    const html = await renderProofCard(
      {
        id: "tool_7",
        name: "task3-proof-card",
        input: { label: "unused" },
        status: "completed",
        output: {
          label: "<script>no injection</script>",
          actionName: "task3-proof-card",
        },
      },
      {
        id: "widget_7",
        kind: "muscle-memory.task3-proof",
        data: { toolCallId: "tool_7" },
      },
    );
    expect(html).toContain('data-task3-card="rendered"');
    expect(html).toContain("&lt;script&gt;no injection&lt;/script&gt;");
    expect(html).toContain("task3-proof-card");
    expect(html).not.toContain("<script>");
  });
});
