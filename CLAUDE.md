@AGENTS.md

# Echo project guide for Claude Code

Echo is a Next.js 16 app that traces a claim through web pages, groups matching assertions, proposes source relationships, and synthesizes an answer from candidate root pages. Read `README.md` for the current behavior and `HANDOFF_TO_CLAUDE.md` for the transfer steps. Treat `PROJECT_PLAN.md` and `DEMO_PRETEST.md` as working notes, not verified findings.

## Where to work

- `src/lib/echo/pipeline.ts`: Tavily retrieval, Claude grouping and judgment, answer synthesis, server cache.
- `src/lib/echo/daily-budget.ts` and `remote-budget.ts`: the app's Anthropic spending guard.
- `src/lib/echo/types.ts`, `portable.ts`, `compare.ts`, `graph.ts`, `wording.ts`: trace data, import/export, comparison, graph inspection, and visible wording clues.
- `src/app/api/analyze/route.ts`: streamed analysis endpoint.
- `src/app/echo-workbench.tsx` and `globals.css`: product UI.
- `scripts/check-*.mjs`: offline checks with no paid provider calls.

## Working rules

- Before changing Next.js code, read the relevant installed guide under `node_modules/next/dist/docs/`, as required by `AGENTS.md`.
- Keep API keys and the budget ledger in ignored local files. Use `.env.example` to see variable names; do not print, paste into chat, or commit values from `.env.local` or `.echo/`.
- The app's $2 Pacific-day Anthropic guard applies to Echo's API calls. It does not limit Claude Code usage or other tools. Do not run live provider calls just to check a code change; use mocked checks first.
- Before a handoff, run `npm ci`, `npm run lint`, all `npm run check:*` scripts, and `npm run build`. Run paid live analysis only when explicitly requested.
- Preserve the distinction between confirmed derived links, dashed uncertain links, and independent roots. A citation identifies a supplied source, not proof of a claim.
- Inspect `git status` before editing. Make small local commits after verified changes. Do not push, deploy, publish, or replace the user's event-day repo without the user's instruction.

## First session

Read `HANDOFF_TO_CLAUDE.md` first (current state, money rules, open items), then `README.md` and `git log -5 --oneline`; inspect the actual files before changing them. Tell the user what is already built, what is still unverified, and which action you propose next. Never run paid live traces without Lucas explicitly asking; never push or add a remote.
