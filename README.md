# Muscle Memory

**Show it once. Your app remembers.**

An entry for the [Builder.io Agent-Native Hackathon](https://www.builder.io/hackathon) (2026). A support operator handles a request once; Muscle Memory records the typed actions, turns them into a deterministic recipe with visible "wires", lets the agent crystallize and the operator approve, backtest and activate it, and then handles matching requests with **0 LLM tokens**. Unfamiliar work goes back to the agent.

- **Demo (Clips, public):** https://clips.agent-native.com/share/IgzNxnFLER7y
- **Full documentation:** [`src/README.md`](src/README.md): problem, how it works, architecture, shared actions, running locally, pre-existing vs built during the hackathon, AI tools, known limitations.
- **Demo video file:** [`src/docs/video/muscle-memory-demo.mp4`](src/docs/video/muscle-memory-demo.mp4)
- **Slides (PDF):** [`src/docs/slides/muscle-memory-slides.pdf`](src/docs/slides/muscle-memory-slides.pdf)

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | pnpm workspace: `apps/web` (the Agent-Native app), `packages/recipe-engine` and `packages/shop-domain` (pure TypeScript domain and application layers) |
| `src/apps/web/AGENTS.md`, `src/apps/web/.agents/skills/` | Runtime instructions and skills of the in-app agent, e.g. crystallize, Recipe Studio and running recipes |

This public repository mirrors the code history of the private working repository. Planning notes and development process records are not included, and author emails use the GitHub noreply address.
