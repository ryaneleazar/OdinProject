# Odin

Autonomous developer agent that monitors Linear tickets, implements code changes using Claude Code, creates pull requests, and handles review feedback — all without human intervention.

## How It Works

```
You comment "@odin implement" on a Linear ticket
        │
        ▼
LinearPoller picks it up (polls every 60s)
        │
        ▼
Orchestrator creates an isolated git worktree
        │
        ▼
Claude (Haiku) implements the feature
        │
        ▼
Claude (Haiku) writes tests
        │
        ▼
Self-review: lint → types → tests → AI review (up to 3 rounds)
        │
        ▼
Git commit + push → GitHub PR created
        │
        ▼
Linear ticket moves to "Ready for Review"
        │
        ▼
PrCommentMonitor watches for reviewer feedback
        │
        ▼
If feedback → Claude addresses it → push → repeat
        │
        ▼
PR merged → Linear moves to "QA" → cleanup
```

## Architecture

```
odin/
├── src/
│   ├── index.ts                          # Entry point, boots orchestrator
│   ├── config.ts                         # Zod-validated env config
│   ├── linear/
│   │   ├── LinearPoller.ts               # Polls Linear for @odin implement comments
│   │   └── LinearStatusUpdater.ts        # Moves tickets through workflow states
│   ├── github/
│   │   ├── GitService.ts                 # Bare clone, worktrees, commit, push
│   │   ├── GitHubApiService.ts           # PR creation, comment fetching via Octokit
│   │   └── PrCommentMonitor.ts           # Watches PRs for reviewer feedback
│   ├── agent/
│   │   ├── AgentService.ts               # Claude Code SDK wrapper, Haiku-first escalation
│   │   └── prompts/
│   │       ├── implementTicket.ts        # Prompt for feature implementation
│   │       ├── writeTests.ts             # Prompt for test writing
│   │       ├── selfReview.ts             # Prompt for code review / fixing errors
│   │       └── addressFeedback.ts        # Prompt for addressing PR feedback
│   ├── selfReview/
│   │   └── SelfReviewPipeline.ts         # Lint → types → tests → AI review loop
│   ├── orchestrator/
│   │   ├── Orchestrator.ts               # Core lifecycle manager, wires everything
│   │   └── TicketStateMachine.ts         # Enforces valid state transitions
│   └── utils/
│       ├── logger.ts                     # Pino structured logging
│       ├── eventBus.ts                   # Typed internal pub/sub
│       └── stateStore.ts                 # Persistent state via JSON file
├── Dockerfile                            # Multi-stage build
├── docker-compose.yml                    # Production deployment config
├── .env                                  # Credentials and settings
└── .env.example                          # Template for .env
```

## Key Components

### LinearPoller

Polls your Linear team board every 60 seconds. Looks at issues in backlog, unstarted, or started states and checks their comments for the exact text `@odin implement`. When found, emits a `ticket:new` event. Tracks already-seen tickets to avoid duplicates.

### LinearStatusUpdater

Moves tickets through your Linear workflow columns:
- **In Progress** — when Odin starts working
- **Ready for Review** — when the PR is created
- **QA** — when the PR is merged

Also removes the `@odin implement` trigger comment after completion and can post status updates as comments on the ticket.

### GitService

Manages all git operations using a **bare clone** and **worktrees**. Each ticket gets its own isolated worktree so Odin can work on multiple tickets in parallel without conflicts. Injects your GitHub token into the HTTPS URL for authentication.

### GitHubApiService

REST API layer via Octokit. Creates PRs, fetches both inline review comments and general issue comments (merged and sorted chronologically), posts comments, and checks merge status.

### PrCommentMonitor

Watches open PRs every 60 seconds. Detects merges (triggers completion) and new reviewer comments. Waits for a **10-minute cooldown** after the last comment before triggering a feedback round — this prevents Odin from jumping in while the reviewer is still writing.

### AgentService

Bridge to Claude Code via the Agent SDK. Three model tiers:
- **cheap** (Haiku) — default for all tasks, fast and cost-effective
- **standard** (Sonnet) — automatic escalation target
- **premium** (Opus) — reserved for the hardest tasks

The `queryWithEscalation()` method tries Haiku first. If Haiku signals it can't complete the task (e.g. "this task is too complex"), it automatically retries with Sonnet.

### SelfReviewPipeline

Quality gate before PR creation. Runs up to 3 iterations:
1. `tsc --noEmit` — type checking
2. `vitest run` — test suite
3. If errors → Claude fixes them (Haiku first, escalates if needed)
4. If clean → quick Haiku AI review for logic bugs, security issues, style violations
5. If AI says "All checks passed" → done

### Orchestrator

The brain. Listens for events and manages the full lifecycle:
- **New ticket** → create worktree → implement → write tests → self-review → commit → PR → monitor
- **Feedback** → read comments → address changes → self-review → push → notify reviewer
- **Completion** → move to QA → delete trigger comment → clean up worktree

Persists all ticket state to `odin-state.json` via the StateStore. On startup, recovers from crashes:
- **Mid-implementation tickets** (Queued through CreatingPR) → cleans up worktree, releases ticket so the poller re-discovers it
- **PR-stage tickets** (AwaitingReview, AddressingFeedback) → re-attaches the PR monitor so feedback continues to be handled
- **Terminal tickets** (Completed, Failed) → cleans up leftover worktrees

### TicketStateMachine

Enforces valid state transitions:
```
Queued → Implementing → WritingTests → SelfReviewing → CreatingPR → AwaitingReview
                                                                        ↕
                                                                  AddressingFeedback
                                                                        │
                                                                    Completed
                                                  (any state) → Failed
```

### EventBus

Typed pub/sub system that decouples components. Events: `ticket:new`, `ticket:implementing`, `ticket:selfReviewing`, `ticket:creatingPR`, `ticket:awaitingReview`, `ticket:addressingFeedback`, `ticket:completed`, `ticket:failed`.

### StateStore

Persists active ticket state to `odin-state.json` in the workspace directory. Saves on every state transition so the Orchestrator can recover from crashes or restarts without losing track of in-flight work.

## Prerequisites

- **Node.js 22+**
- **Git**
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- A **Linear** account with API key
- A **GitHub** account with a personal access token (repo scope)

## Setup

### 1. Clone and install

```bash
cd odin
npm install
```

### 2. Configure environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Linear
LINEAR_API_KEY=lin_api_...           # Linear API key (Settings → API)
LINEAR_TEAM_ID=your-team-uuid        # UUID of your Linear team

# GitHub
GITHUB_TOKEN=ghp_...                 # Personal access token with repo scope
GITHUB_REPO_OWNER=your-org           # GitHub org or username
GITHUB_REPO_NAME=your-repo           # Repository name
GITHUB_REPO_URL=https://github.com/your-org/your-repo.git

# Agent config (defaults shown, all optional)
CLAUDE_MODEL=claude-sonnet-4-20250514
CLAUDE_CHEAP_MODEL=claude-haiku-4-5-20251001
MAX_CONCURRENT_TICKETS=2             # Max tickets worked on simultaneously
POLL_INTERVAL_MS=60000               # How often to check Linear (ms)
PR_COMMENT_COOLDOWN_MS=600000        # Wait time after last PR comment (ms)
MAX_BUDGET_PER_TICKET_USD=10         # Max Claude spend per ticket
WORKSPACE_DIR=/workspace             # Where git worktrees are created
LOG_LEVEL=info                       # trace | debug | info | warn | error | fatal
```

#### Finding your Linear Team UUID

Your team ID is a UUID, not the team key (e.g. "VIS"). To find it, run this against the Linear API:

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ teams { nodes { id name key } } }"}' | jq .
```

### 3. Authenticate Claude Code

Make sure you're logged into Claude Code on your machine:

```bash
claude auth login
```

This stores credentials in `~/.claude/`, which gets mounted into Docker at runtime.

## Running

### Local development

```bash
npm run dev
```

### Production (Docker)

```bash
docker compose up -d
```

The Docker setup:
- Mounts `~/.claude:/root/.claude:ro` for Claude CLI auth passthrough
- Creates persistent volumes for workspace and logs
- Allocates 8GB memory and 4 CPUs

### Build only

```bash
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled output
```

## Usage

1. Start Odin (`npm run dev` or `docker compose up -d`)
2. Go to any ticket on your Linear team board
3. Add a comment with exactly: `@odin implement`
4. Odin picks it up within 60 seconds and starts working
5. The ticket moves to "In Progress" on your board
6. Once done, a PR appears on GitHub and the ticket moves to "Ready for Review"
7. Review the PR and leave comments — Odin will address them after a 10-minute cooldown
8. Merge the PR — the ticket moves to "QA" and the trigger comment is cleaned up

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `LINEAR_API_KEY` | — | Linear API key (required) |
| `LINEAR_TEAM_ID` | — | Linear team UUID (required) |
| `GITHUB_TOKEN` | — | GitHub PAT with repo scope (required) |
| `GITHUB_REPO_OWNER` | — | GitHub org or username (required) |
| `GITHUB_REPO_NAME` | — | Repository name (required) |
| `GITHUB_REPO_URL` | — | HTTPS clone URL (required) |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Standard/escalation model |
| `CLAUDE_CHEAP_MODEL` | `claude-haiku-4-5-20251001` | Default model (Haiku) |
| `MAX_CONCURRENT_TICKETS` | `2` | Parallel ticket limit |
| `POLL_INTERVAL_MS` | `60000` | Linear polling interval (ms) |
| `PR_COMMENT_COOLDOWN_MS` | `600000` | Wait after last PR comment (ms) |
| `MAX_BUDGET_PER_TICKET_USD` | `10` | Max Claude spend per ticket |
| `WORKSPACE_DIR` | `/workspace` | Git worktree root |
| `LOG_LEVEL` | `info` | Logging verbosity |

## Cost Management

Odin uses a **Haiku-first strategy** to minimize costs:
- All tasks start with Haiku (cheapest model)
- Only escalates to Sonnet if Haiku explicitly flags the task as too complex or fails
- Each ticket has a configurable budget cap (`MAX_BUDGET_PER_TICKET_USD`)
- Typical ticket: mostly Haiku tokens with occasional Sonnet escalation

## Logs

Structured JSON logs via Pino. Each log line includes the originating module.

```bash
# Docker logs
docker compose logs -f odin

# Local development outputs to stdout
npm run dev
```
