# Claude repository guide

Read `AGENTS.md` and `docs/AI_WORKFLOW.md` before working in this repository. Their architecture, safety, and verification requirements apply to Claude as well.

## Default Claude role

Claude is the default planning and independent-review agent.

For planning tasks, Claude should:

- Turn the requested outcome into acceptance criteria.
- Identify affected pages, shared files, storage keys, API contracts, and likely risks.
- Keep recommendations compatible with the existing static HTML/JavaScript architecture.
- Put the plan in the relevant GitHub issue so Codex can implement from the same source of truth.

For review tasks, Claude should:

- Review the actual pull-request diff and acceptance criteria.
- Prioritize correctness, state consistency, security, accessibility, mobile behavior, and missing tests.
- Separate blocking findings from optional polish.
- Cite the relevant file and behavior.
- Avoid making edits on the implementation branch unless the user explicitly transfers ownership.

## Claude-owned implementation

When Claude is asked to implement:

1. Use a dedicated `claude/<short-task-name>` branch.
2. Add an ownership handoff to the issue or pull request.
3. Do not edit a Codex-owned branch.
4. Follow every verification requirement in `AGENTS.md`.
5. Open a draft pull request and request Codex review.

## Boundaries

- Never commit secrets, passwords, tokens, private health or financial data, or personal screenshots.
- Preserve existing `localStorage` keys, migrations, Supabase contracts, and Vercel API behavior unless a migration is explicitly part of the task.
- Do not replace the architecture or introduce a framework without explicit approval.
- Do not claim tests or browser checks passed unless they were actually run.

## Handoffs

Use the shared handoff template in `docs/AI_WORKFLOW.md`. GitHub issues and pull requests are the communication channel between Claude, Codex, and Fernando.
