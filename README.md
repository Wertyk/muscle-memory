# Muscle Memory

**Show it once. Your app remembers.**

An entry for the [Builder.io Agent-Native Hackathon](https://www.builder.io/hackathon) (2026). A support operator handles a request once; Muscle Memory records the typed actions, turns them into a deterministic recipe with visible "wires", lets the agent crystallize and the operator approve, backtest and activate it, and then handles matching requests with **0 LLM tokens**. Unfamiliar work goes back to the agent.

- **Demo (Clips, public):** https://clips.agent-native.com/share/IgzNxnFLER7y
- **Full documentation:** [`src/README.md`](src/README.md): problem, how it works, architecture, shared actions, running locally, pre-existing vs built during the hackathon, AI tools, known limitations.
- **Demo video file:** [`src/docs/video/muscle-memory-demo.mp4`](src/docs/video/muscle-memory-demo.mp4)

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | pnpm workspace: `apps/web` (the Agent-Native app), `packages/recipe-engine` and `packages/shop-domain` (pure TypeScript domain and application layers) |
| `backlog/` | Backlog.md task records with acceptance criteria, implementation notes and review evidence for every change |
| `AGENTS.md`, `CLAUDE.md` | Instructions the coding agents followed during development |

This public repository mirrors the private working repository's history. Two things differ: the planning and research notes are not included, and author emails use the GitHub noreply address.
