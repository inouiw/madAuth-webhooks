# AGENTS.md

## Communication

- Keep responses concise and technical — avoid filler, hedging, and restating what the user already knows.
- When a change can reasonably be implemented in more than one way, ask the user which approach they prefer before writing code.
- Ask clarifying questions whenever requirements, scope, or expected behavior are ambiguous — don't guess silently.

## Repository structure

```
madAuth-webhooks/
├── dev-receiver/    # Prints each e-mail and SMS with its link and code — for development
└── aws-ses-mailer/  # AWS Lambda (SAM template) that sends e-mails with SES and SMS with SNS
```

Each folder stands alone: its own `package.json`, `node_modules`, tests and README. There are no npm workspaces. The webhook calls themselves are defined by madAuth (`inouiw/madAuth`, see `docs/server.md#webhooks` there).

## Workflow

- **When asked to implement a GitHub issue, always create a separate branch first** (e.g. `issue-<number>-short-description`) and do the work there — never commit the implementation directly to `main`.
- **Avoid stacking when possible — base every PR on `main`. Only genuinely dependent changes need stacking.** (Stacked PRs combined with squash merges force rebases and force-pushes of the child branches; for a dependent sequence, prefer merging each PR before starting the next one on fresh `main`.)
- **Every completed change — not just GitHub issues — ends with a pull request that is then reviewed.** However small the change, once it is done: publish the branch and open a PR (`git push -u` the branch, then `gh pr create`), then run the code review as described below. Reference the issue it implements in the PR description, if any.
- **Make GitHub close the issue automatically when the PR merges:** include a closing keyword followed by the issue number — `Fixes #<issue>`, `Closes #<issue>`, or `Resolves #<issue>` — in **both** the PR description and the commit message. Plain references like "issue #10" or "see #10" do **not** auto-close.
- **Check for merge conflicts with `main` and fix them without being asked.** Before opening a PR, and again whenever you return to an already-open one, run `git fetch origin` and check the branch merges cleanly (`gh pr view <PR#> --json mergeable`, or attempt `git merge origin/main`). On a conflict, resolve it yourself by merging `origin/main` into the branch — adopt the conventions `main` introduced in the meantime, don't just splice the textual halves together. Re-run the affected folders' checks after the merge, then push it.
- **Then review the pull request as a real GitHub code review**, not just a summary comment. Run `/code-review --comment`, which posts each finding as an **inline review comment anchored to the exact file and line** on the PR. Do not post findings only as a plain `gh pr comment` timeline comment. Address any findings before considering the work done.
  - **Keep review feedback concise:** one sentence per finding — state the problem and its impact, no preamble. Only report real issues; no "looks good" filler comments.
  - **Control the depth with the effort level — always at least `medium`.** Default to `/code-review medium --comment`. Use `high` (up to `max`) only when broad coverage matters more than noise. Do not use `low` — it misses too much for reviews that gate merging.
- **After changing the dev receiver, run it against a local madAuth server** (the `server` and `webhooks` launch configs of a madAuth checkout) and trigger the e-mails or SMS you changed — check that the link or code is printed and that madAuth reports no failed hand-over.
  - **Stop the processes when you are done testing**, so the ports are free for the next agent session.
  - **If a port is already in use, do not kill the occupying process on your own** — it may belong to another still-running agent session. Ask the user first.
- **Keep both receivers in step with madAuth.** When madAuth adds or renames a webhook type, handle it in both receivers, keep accepting the old names while released madAuth versions still send them, and update the READMEs.
- **Check for missing AWS permissions.** Locally, code runs with your own AWS credentials, which are broader than the deployed Lambda role. For every new or changed AWS call (SES, SNS, …), verify that the policy in `aws-ses-mailer/template.yaml` grants it.

### Coding guidelines

- Prefer immutable variables and pure functions.
- Prefer a result type with a success and an error case over exceptions.
- Avoid try-catch blocks for branching. Prefer to check whether something exists over handling exceptions.

### Testing

In every folder you change, run `npm run typecheck` and `npm test` before considering a task done.

### Documentation

The root README and each folder's README describe the behavior users rely on (webhook types handled, setup steps, environment variables). Update them **in the same commit** as the code change, and never leave them describing behavior that no longer exists. Do not amend commits; create a new commit instead.
