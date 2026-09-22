# Local incident intake runbook

This runbook starts Emerald Osprey and the incident orchestrator locally,
submits an issue through Emerald, watches live triage, and verifies the GitHub
issue and pull request produced by a successful fix.

## Prerequisites

- Node.js 22.13 or newer
- npm
- Git and GitHub CLI
- A GitHub Copilot subscription
- Push, issue, and pull-request access to `chetbackiewicz/emerald-osprey`
- Local checkouts of:
  - `chetbackiewicz/emerald-osprey`
  - `chetbackiewicz/orchestrator`

Verify the runtime and GitHub authentication:

```bash
node --version
gh auth status
```

Use the same Node 22 installation for dependency installation, both
applications, and verification. Native packages such as `better-sqlite3` must
be built for the Node runtime that executes the tests.

## 1. Install both applications

In the Emerald Osprey checkout:

```bash
cd /path/to/emerald-osprey
npm install
```

In the orchestrator checkout:

```bash
cd /path/to/orchestrator
npm install
```

## 2. Configure the orchestrator

Create `/path/to/orchestrator/.env`:

```dotenv
AGENT_RUNNER=copilot
COPILOT_MODEL=gpt-5
# COPILOT_MODEL_PROVIDER=copilot
# Optional: use an explicit token instead of the logged-in Copilot/gh user.
# COPILOT_GITHUB_TOKEN=github-token
# COPILOT_LOG_LEVEL=warning

INCIDENT_PUBLISH=true
INCIDENT_PUBLISH_BASE=main
INCIDENT_GITHUB_REMOTE=origin
INCIDENT_GITHUB_REPOSITORY=chetbackiewicz/emerald-osprey

INCIDENT_QUEUE_URL=http://127.0.0.1:3000
INCIDENT_POLL_INTERVAL_MS=5000
INCIDENT_LEASE_SECONDS=120
INCIDENT_HEARTBEAT_INTERVAL_MS=30000
```

`INCIDENT_WORKER_ID` is optional. When omitted, the orchestrator generates a
unique worker ID. Do not commit `.env`.

## 3. Prepare the Emerald repository

Keep the Emerald checkout that serves the website stable. The orchestrator
creates a separate attempt-scoped branch and worktree for every claimed
incident. Install dependencies in the stable repository because managed
worktrees link its `node_modules`:

```bash
cd /path/to/emerald-osprey
git fetch origin
npm install
git status --short
```

The checkout should be clean. It remains on its current branch while incident
work occurs under the orchestrator's managed workspace root.

## 4. Start Emerald Osprey

In terminal 1, from the stable Emerald checkout:

```bash
cd /path/to/emerald-osprey
DATABASE_PATH=/absolute/path/to/emerald-osprey-local.db \
PORT=3000 \
npm run dev
```

Verify the website and issue API:

```bash
curl --fail http://127.0.0.1:3000/issues
curl --fail http://127.0.0.1:3000/api/incidents
```

Open:

```text
http://127.0.0.1:3000/issues
```

## 5. Start the orchestrator worker

In terminal 2, from the orchestrator checkout:

```bash
cd /path/to/orchestrator
npm run worker -- \
  --queue-url http://127.0.0.1:3000 \
  --repo-root /path/to/emerald-osprey \
  --workspace-root /path/to/incident-worktrees \
  --target-ref demo/incident-season \
  --dashboard \
  --dashboard-port 4317
```

The worker loads `.env`, uses the Copilot runner, polls one incident at a time,
creates an isolated workspace from the immutable commit resolved by
`--target-ref`, and publishes verified outcomes to
`chetbackiewicz/emerald-osprey`. For normal incidents use `origin/main` instead
of the seeded demo ref.

The previous manual mode remains available when a specific existing worktree is
required:

```bash
npm run worker -- \
  --queue-url http://127.0.0.1:3000 \
  --cwd /path/to/existing/emerald-worktree \
  --pre-fix-ref demo/incident-season \
  --dashboard
```

Open the live dashboard:

```text
http://127.0.0.1:4317
```

The dashboard shows the current triage stage and only the current live agent
operation. It does not replay a list of past tool calls. Use the **Models**
screen to choose a model from the GitHub Copilot catalog or the optional Azure
Foundry BYOK connection for each stage. OpenAI and Anthropic models remain
GitHub Copilot model choices rather than separate BYOK providers. The worker
validates saved selections and checks availability again before each stage
starts.

## 6. Submit the season issue

On `http://127.0.0.1:3000/issues`, create an issue with:

```text
Summary: Season end date is incorrectly closed

Details: Coho on Skykomish is closed on the listed season end date. The
application should include the final date of the configured season.
```

Select **Create Issue**. Emerald stores the issue in SQLite and the worker
claims it on the next poll.

The same issue can be submitted directly for API testing:

```bash
curl --fail \
  --request POST \
  --header 'content-type: application/json' \
  --data '{
    "idempotencyKey": "local-season-demo-1",
    "summary": "Season end date is incorrectly closed",
    "payload": {
      "trigger": "manual",
      "report": "Coho on Skykomish is closed on the listed season end date. The application should include the final date of the configured season."
    }
  }' \
  http://127.0.0.1:3000/api/incidents
```

Use a new `idempotencyKey` for each independent test.

## 7. Observe triage and verification

The expected stages are:

```text
received
assessing
investigating
acting
awaiting_verification
verified_fixed
```

For a verified fix, the orchestrator independently checks:

1. The new reproduction test fails at the immutable commit resolved from
   `--target-ref` (or at `--pre-fix-ref` in manual mode).
2. The reproduction test passes with the agent's changes.
3. The complete Emerald test suite passes with the agent's changes.

The terminal record should contain real Copilot token usage and request IDs.
The Emerald issue page intentionally hides those internal agent details and
shows only the user-facing status, concise outcome, and publication links.

## 8. Verify GitHub publication

A `verified_fixed` incident should:

1. Commit only the independently verified files.
2. Push the attempt-scoped `incident-fix/<identity>-attempt-<number>` branch.
3. Open a pull request against `main`.
4. Create or update the matching GitHub issue.
5. Return both URLs to the Emerald incident result.

From either repository:

```bash
gh pr list \
  --repo chetbackiewicz/emerald-osprey \
  --search 'head:incident-fix/'

gh issue list \
  --repo chetbackiewicz/emerald-osprey \
  --search 'Incident'
```

The Emerald issue card should expose **GitHub issue** and **Pull request**
links when publication succeeds.

## 9. Rerun another issue

After a terminal result, select **Resume polling** on the orchestrator
dashboard. This clears only the displayed record; it does not requeue or alter
the completed Emerald issue.

Managed mode creates a fresh attempt-scoped workspace for the next claim. If a
previous failed workspace was preserved, inspect or remove it separately; it
will not be reused by a later queue attempt.

## 10. Stop and clean up

Stop the worker and Emerald server with `Ctrl+C` in their terminals.

Successfully published managed worktrees are removed automatically only after
Emerald acknowledges the completion callback. Clean read-only outcomes are
also removed. Failed workspaces, workspaces with uncommitted changes, and
workspaces with unpublished commits are preserved; the worker logs the exact
path for inspection.

List all Emerald worktrees with:

```bash
cd /path/to/emerald-osprey
git worktree list
```

Run conservative orchestrator cleanup with:

```bash
cd /path/to/orchestrator
npm run workspace:cleanup -- \
  --repo-root /path/to/emerald-osprey \
  --workspace-root /path/to/incident-worktrees \
  --target-ref demo/incident-season
```

The command removes only clean managed worktrees with no unpublished commits.
It reports and preserves dirty or unpublished workspaces.

Remove a preserved worktree only after deciding that its changes and commits
are no longer needed. Never recursively delete the managed workspace root.
