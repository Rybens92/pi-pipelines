# Pi Pipelines — Agent Guide

This is a **Pi extension** that adds multi-agent pipeline orchestration with review gates and scoring loops.

## What this package does

1. Reads pipeline definitions from `.pi/pipelines/*.pipeline.yaml` (YAML format)
2. Each pipeline is a sequence of stages: agent tasks, parallel fan-outs, or review gates
3. The extension executes stages through pi-subagents' event bridge (or falls back to `pi.exec()`)
4. Review gates run iterative loops: worker → parallel reviewers → score → retry if below target

## How to adapt it

### For users
- Install: `pi install npm:pi-subagents` then `pi install /path/to/pi-pipelines`
- Create `.pipeline.yaml` files in `.pi/pipelines/`
- Run: `/run-pipeline <name> [task]` or ask the LLM to use `run_pipeline` tool

### Pipeline format

```yaml
name: my-pipeline
description: What it does
stages:
  - id: stage-name
    agent: agent-name       # planner, worker, reviewer, scout, oracle
    task: "Task for agent"  # Supports {task}, {outputs.stageId}
    gate:                   # Optional review gate
      type: review-loop
      maxRounds: 3
      targetScore: 9
      reviewers:
        - focus: "Review focus area"
```

### Stage types
- **Simple**: `{ id, agent, task }` — runs one agent
- **Parallel**: `{ id, parallel: [{ id, agent, task }, ...] }` — runs agents concurrently
- **Gate**: `{ id, agent, task, gate: { ... } }` — runs with iterative review scoring

### Template variables
- `{task}` — original task passed to pipeline
- `{outputs.stageId}` — output from a previous stage
- `{lastFeedback}` — last review feedback inside a gate loop

## How review gates work

```
Round 1: Worker → parallel reviewers → average scores
         If avg >= targetScore → PASS ✓
         If avg < targetScore → feedback → Round 2
Round 2: Worker retries with feedback → reviewers score again
         ...continues until pass or maxRounds exceeded
```

Each reviewer must end with `SCORE: N` (0-10) on the last line.

## Agent recommendations

| Pipeline stage | Recommended agent |
|---------------|-------------------|
| Code analysis | `scout`, `planner` |
| Test writing | `worker` |
| Implementation | `worker` |
| Code review | `reviewer`, `oracle` |
| Research | `researcher`, `scout` |
| Synthesis | `planner`, `oracle` |

## Requirements

- pi-subagents (`pi install npm:pi-subagents`) — required for agent delegation
- Pi >= 0.74
