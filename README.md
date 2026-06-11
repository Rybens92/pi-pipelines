# Pi Pipelines

> Define and run multi-agent pipelines with review gates, scoring loops, and parallel execution — powered by pi-subagents.

Pi Pipelines is a Pi extension that adds a **declarative pipeline system** for
orchestrating multi-agent workflows. Define your workflow as YAML, run it with
a single command, and get structured results with quality gates.

## Install

```bash
# From local path
pi install /path/to/pi-pipelines

# Or from npm (once published)
pi install npm:pi-pipelines
```

Requires [pi-subagents](https://github.com/nicobailon/pi-subagents) to be
installed for agent delegation.

## Quick Start

```bash
# 1. Create a pipeline definition
mkdir -p .pi/pipelines

# 2. Create .pi/pipelines/my-pipeline.pipeline.yaml
# 3. Run it:
/run-pipeline my-pipeline "Implement user authentication"

# 4. Or let the LLM discover and run it:
/list-pipelines
```

## Features

### 🎯 Declarative YAML Pipelines
Define multi-agent workflows in `.pi/pipelines/*.pipeline.yaml` files.

### 🔄 Stage Types
- **Sequential** — agents run one after another, passing outputs via `{outputs.stageId}`
- **Parallel** — fan-out to multiple agents concurrently
- **Review Gates** — iterative worker → reviewers → scoring → retry loops

### 📊 Review Gates with Scoring
Each gate runs parallel reviewers that score work products on a 0-10 scale.
If the average score is below `targetScore`, the worker retries with feedback.
This is the "loop until passed" pattern described in multi-agent workflow literature.

### 🔗 Variable Substitution
- `{task}` — the original task
- `{outputs.stageId}` — output from previous stages, including parallel child IDs
- `{item}` / `{item.key}` — values from dynamic `expand` stages
- `{lastFeedback}` — last review feedback for gate retries

### 🤖 LLM-Friendly Tools
- `run_pipeline({ pipeline, task })` — for the LLM to execute pipelines
- `list_pipelines({ query? })` — for the LLM to discover pipelines

## Available Pipelines

The extension ships with these built-in examples:

| Pipeline | Description |
|----------|-------------|
| `tdd-review` | Full TDD cycle: plan → write tests (gated) → implement (gated) → verify → propose next |
| `dev-sprint` | Complete dev cycle: plan → TDD with test + code gates → verify → parallel project review → synthesize |
| `release-check` | Pre-release quality: parallel code review + security audit + stability check → release readiness |
| `refactor` | Safe refactoring: understand code → plan → refactor (gated) → verify → summary |

## Creating Pipelines

Create `.pipeline.yaml` files in `.pi/pipelines/`:

```yaml
name: my-pipeline
description: "What this pipeline does"

stages:
  - id: stage-one
    agent: planner
    task: "Plan for: {task}"

  - id: stage-two
    agent: worker
    task: "Implement: {outputs.stage-one}"
    gate:
      type: review-loop
      maxRounds: 3
      targetScore: 8
      reviewers:
        - focus: "Quality focus area for reviewer 1"
        - focus: "Quality focus area for reviewer 2"
```

## How Review Gates Work

1. **Worker executes** the task
2. **N reviewers** evaluate the output in parallel, scoring 0-10
3. **Average score** is calculated
4. If average >= `targetScore` → **gate passes**, pipeline continues
5. If average < `targetScore` → **feedback is collected**, worker retries
6. After `maxRounds` attempts without passing → **stage fails**

Reviewers must output a `SCORE: N` line (0-10) as the last line of their response.

## Architecture

```
Pipeline YAML
    │
    ▼
Pi Pipelines Extension
    │
    ├── /run-pipeline command (for users)
    ├── run_pipeline tool (for LLM)
    └── list_pipelines tool (for LLM)
    │
    ▼
Pipeline Runner (TypeScript)
    │
    ├── Sequential stages → pi.exec("pi", ["-p", "/run agent ..."])
    ├── Parallel stages   → Promise.all([pi.exec(...), ...])
    └── Review gates       → loop: worker → reviewers → score → retry
```

## License

MIT
