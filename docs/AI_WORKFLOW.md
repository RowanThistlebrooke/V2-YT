# Codex and Claude collaboration workflow

GitHub is the shared source of truth for Fernando, Codex, and Claude. Agents collaborate asynchronously through issues, branches, pull requests, reviews, and explicit handoffs.

## Default responsibilities

| Participant | Default responsibility |
| --- | --- |
| Fernando | Defines the outcome, resolves product decisions, and approves merges |
| Claude | Plans features and independently reviews pull requests |
| Codex | Implements features, runs tests, and verifies behavior in the browser |
| GitHub | Stores requirements, handoffs, code, review findings, and merge history |

These are defaults, not permanent restrictions. Claude may implement and Codex may review when the task explicitly assigns those roles.

## One task, one implementation owner

Each task has exactly one implementation owner at a time.

- Codex-owned branch: `codex/<short-task-name>`
- Claude-owned branch: `claude/<short-task-name>`
- Setup or neutral maintenance branch: `agent/<short-task-name>`

Do not have both agents edit the same branch. Do not have both agents independently change the same files for the same task. Transfer ownership explicitly in the issue before the second agent edits.

## Feature lifecycle

### 1. Create or identify the issue

The issue must state:

- User outcome
- Acceptance criteria
- Pages and workflows in scope
- Explicitly excluded work
- Data or migration risks
- Implementation owner
- Review owner

If requirements change, update the issue before implementation continues.

### 2. Plan

The planning agent posts a concise implementation plan in the issue. The plan should identify affected files, state transitions, storage/API contracts, tests, and visual checks.

For the default workflow, Claude plans and Codex confirms the plan is implementable.

### 3. Implement

The implementation owner creates its named branch and keeps the diff focused. Record material decisions in the issue or pull request rather than leaving them only in a private agent conversation.

### 4. Validate

Before requesting review:

- Run `npm test`.
- Verify the affected desktop flow.
- Verify the affected narrow mobile flow.
- Check for new browser-console warnings and errors.
- Confirm persistent data and migrations still work.
- Confirm empty, loading, success, and failure states affected by the change.
- Confirm destructive controls have appropriate safeguards.

If a check cannot be run, state why. Never mark an unrun check as passed.

### 5. Open a draft pull request

Use the repository pull-request template. Link the issue, identify the implementation agent, summarize the change, list the validation evidence, and call out risks or unresolved decisions.

### 6. Independent review

The non-implementing agent reviews the pull request.

Review priority:

1. Correctness and data integrity
2. Security and privacy
3. Regressions and state consistency
4. Missing tests
5. Accessibility and responsive behavior
6. Maintainability
7. Optional visual polish

Classify findings as blocking or non-blocking. Include file references and reproduction steps when possible.

### 7. Revision and merge

The implementation owner addresses accepted findings and posts a final handoff. Fernando reviews the preview/diff and decides whether to merge.

## Handoff template

Post this in the GitHub issue or pull request whenever ownership, review state, or implementation state changes:

```md
## Agent handoff

- Task:
- Implementation owner:
- Review owner:
- Branch:
- Pull request:
- Current status:
- Files changed:
- Acceptance criteria completed:
- Tests run:
- Browser checks:
- Known risks or limitations:
- Open decisions:
- Requested next action:
```

## Conflict prevention

- Pull or refresh the target branch before beginning work.
- Keep implementation branches short-lived.
- Prefer one focused pull request per issue.
- Avoid broad formatting changes.
- Never force-push or rewrite another agent's branch without explicit approval.
- If branches overlap, pause one task and choose a single integration owner.
- Resolve disagreements with evidence: tests, screenshots, reproducible behavior, or documented requirements.

## Security and privacy

This dashboard can contain health, financial, authentication, and other personal data.

- Never paste production secrets or personal records into issues, PRs, commits, screenshots, or agent prompts.
- Use environment variables and the existing deployment secret system.
- Use synthetic data for tests and screenshots.
- Treat the client-side password gate as a convenience, not a security boundary.
- Require explicit approval for authentication, storage, or data-migration changes.

## Communication rule

Private agent conversations are temporary context. Decisions that affect the repository must be copied into the GitHub issue or pull request so the user and the other agent can inspect them.
