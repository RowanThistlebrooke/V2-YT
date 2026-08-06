# Codex repository guide

## Purpose

This repository is Fernando's personal dashboard. It is primarily a set of standalone HTML and JavaScript applications deployed on Vercel.

## Architecture

- Standalone pages live in root-level `.html` files.
- Shared visual tokens and components live in `design-system.css`.
- Shared navigation and quick actions live in `topbar.js`.
- Cross-device synchronization lives in `sync.js` and Supabase-backed code.
- Serverless integrations live under `api/`.
- Tests live under `tests/` and run with `npm test`.
- Much of the client state is stored in browser `localStorage`. Treat existing keys and migrations as compatibility contracts.

## Working rules

1. Read `docs/AI_WORKFLOW.md` before starting implementation.
2. Use a dedicated `codex/<short-task-name>` branch for Codex-owned implementation. Never implement on `main`.
3. One agent owns implementation for a task. Do not edit a branch currently owned by Claude unless the user explicitly transfers ownership.
4. Keep changes focused. Do not rewrite unrelated pages or convert the project to a framework unless explicitly requested.
5. Reuse the shared design system and existing patterns before introducing page-specific styling.
6. Preserve desktop and mobile behavior.
7. Do not rename or remove persisted data keys, change storage formats, or alter Supabase/API contracts without documenting a migration.
8. Never commit passwords, tokens, API keys, private health data, financial data, or personal screenshots.
9. Treat generated predictions and health/financial summaries as estimates. Make their inputs, confidence, and empty states clear.

## Verification

For code changes:

- Run `npm test`.
- Test the affected page at a desktop viewport.
- Test the affected page at a narrow mobile viewport.
- Check the browser console for new warnings or errors.
- Verify navigation, persistent state, empty states, and destructive controls affected by the change.
- Record the checks and any limitations in the pull request.

## Default Codex role

Codex is the default implementation and browser-verification agent. It may also review Claude-owned pull requests when asked. A review must cite concrete files and behavior, distinguish blockers from suggestions, and avoid editing the reviewed branch unless ownership is transferred.

## Handoffs

Use the handoff template in `docs/AI_WORKFLOW.md`. Put the latest handoff in the GitHub issue or pull-request description so both agents and the user share the same source of truth.
