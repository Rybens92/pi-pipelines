# 🧩 Pi Pipelines

> Declarative multi-agent pipelines for Pi — with review gates, scoring loops, parallel execution, and dynamic stage expansion.

[![npm version](https://img.shields.io/npm/v/pi-pipelines?style=flat-square)](https://www.npmjs.com/package/pi-pipelines)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Pi](https://img.shields.io/badge/pi-%E2%89%A50.74-5B5BD6?style=flat-square)](https://pi.dev)
[![Test Status](https://img.shields.io/badge/tests-314%20passing-brightgreen?style=flat-square)](https://github.com/Rybens92/pi-pipelines)
[![Code Coverage](https://img.shields.io/badge/coverage-97.4%25-brightgreen?style=flat-square)](https://github.com/Rybens92/pi-pipelines)

---

## 💡 Why This Exists

Recently, there's been a lot of discussion on social media about **agent loops** — the idea that an AI agent shouldn't just produce output and move on, but should iterate on its work through review and refinement loops. The conversation has been especially active around AI, LLMs, and agent harnesses.

This project is a small attempt to implement something like that as a **Pi extension**.

**My interpretation of loops** is first and foremost a **review process**: having AI review what AI already produced, then iterating on it until it reaches a quality target. The reviewer agents run in a different context than the main workflow — they are independent, focused evaluators that ensure the primary agent's work is at the right level. That's what review gates in this project are built for.

There's also talk about **agent/subagent recurrence** as the next step beyond loops. My answer to that in this project is **Dynamic Stage Expansion** — a mechanism that takes structured output from one stage (e.g., a list of files, topics, or tasks discovered by a scout agent), and dynamically fans them out into N parallel worker stages. It's not true agent recursion yet — it's an attempt to move in that direction, and I'm open to where that leads.

The result is a system where you can:

- Define multi-agent workflows as **YAML files** (manually)
- **Ask the agent** to create pipelines for you using the built-in skill
- Run **automated pipelines** that chain together exploration, planning, implementation, review, and verification into repeatable workflows

---

## 📦 Install

### Prerequisites

| Requirement | Version | Install |
|---|---|---|
| [Pi](https://pi.dev) | `>= 0.74` | `npm install -g @earendil-works/pi-coding-agent` |
| [pi-subagents](https://github.com/Rybens92/pi-subagents) | latest | `pi install npm:pi-subagents` |

### Install the extension

```bash
# From npm (recommended)
pi install npm:pi-pipelines

# From GitHub
pi install git:github.com/Rybens92/pi-pipelines

# From a local path
pi install /path/to/pi-pipelines
```

---

## 🚀 Quick Start

```bash
# 1. Create a pipeline directory
mkdir -p .pi/pipelines

# 2. Create a pipeline file
cat > .pi/pipelines/hello.pipeline.yaml << 'EOF'
name: hello
description: "Quick project exploration and action plan"

stages:
  - id: explore
    agent: scout
    task: "Explore the project for: {task}"
  - id: plan
    agent: planner
    task: "Create a plan based on: {outputs.explore}"
EOF

# 3. Run it (via command)
/run-pipeline hello "Add user authentication"

# 4. Or discover available pipelines
/list-pipelines
```

### Letting the Agent Create Pipelines for You

The extension ships with a [built-in skill](skills/pi-pipelines/SKILL.md) that teaches the Pi agent how to create, validate, and run pipeline definitions. The agent can generate complete pipeline YAML files based on your description, place them in the right directory, and even test them. Just describe what you want and the agent will handle the rest.

Try saying: *"Create a code review pipeline with a security gate"* — the agent will use the skill to build it for you.

---

## ✨ Features

### 🎯 Declarative YAML Pipelines
Define entire workflows in `.pi/pipelines/*.pipeline.yaml`. No code, just YAML.

### 🔄 Three Stage Types

| Stage Type | Description |
|---|---|
| **Sequential** | Agents run one after another, passing outputs via `{outputs.stageId}` |
| **Parallel** | Fan-out to multiple agents concurrently for independent work |
| **Review Gate** | Worker → parallel reviewers → score → retry loop until quality target is met |

### 📊 Review Gates with Scoring — The Loop Pattern

This is the core idea: **AI reviewing what AI produced, iterating until it's good enough.**

```
Round 1: Worker → 3 Reviewers (parallel, independent context) → Avg Score: 7.3
         ❌ 7.3 < 9.0 → Feedback collected → Round 2

Round 2: Worker (with feedback from round 1) → 3 Reviewers → Avg Score: 9.3
         ✅ PASS — quality target met
```

Each reviewer runs in its own context — isolated from the worker and from each other — to provide an independent quality assessment. They score on a 0–10 scale. The worker retries with the collected feedback until the average meets `targetScore` or `maxRounds` is exhausted.

### 🧩 Dynamic Stage Expansion — Towards Agent Recurrence

Some people on X (formerly Twitter) argue that the future of agentic workflows isn't just loops, but **recurrence** — agents spawning subagents that spawn further subagents, recursively decomposing work.

Dynamic Stage Expansion is this project's take on that idea. It takes structured output from one stage (JSON, YAML, or a markdown list) and dynamically fans it out into N parallel stages. It's not true agent recursion — each expansion is one level deep and each expanded stage runs the same agent type. But it's a step in that direction, and it's already useful for real workflows.

```yaml
stages:
  - id: find-files
    agent: scout
    task: "Return JSON files to refactor: [{\"path\":\"...\"}, ...]"

  - id: refactor-each
    expand:
      from: find-files
      maxItems: 10
    agent: worker
    task: "Refactor {item.path}"
```

### 🔗 Template Variables

| Variable | Resolves to |
|---|---|
| `{task}` | Original user task passed to the pipeline |
| `{outputs.<stageId>}` | Output from a previous stage |
| `{lastFeedback}` | Latest review feedback (auto-injected in gate retries) |
| `{item}` | Whole item from dynamic stage expansion |
| `{item.<key>}` | Single field from a dynamic expansion item |

### 🤖 LLM-Friendly Tools
Pi Pipelines registers tools that the LLM can use:

| Tool | Purpose |
|---|---|
| `run_pipeline({ pipeline, task })` | Execute any defined pipeline |
| `list_pipelines({ query? })` | Discover and filter available pipelines |

### 📋 Automatic Report Synthesis
After all stages complete, a synthesis agent automatically generates a structured report of what was accomplished, key findings, issues, and next steps.

---

## 📚 Built-in Pipelines

The extension ships with 5 example pipelines. They're automatically copied to `~/.pi/pipelines/` on first run.

| Pipeline | Stages | Gates | Use Case |
|---|---|---|---|
| `hello-world` | 2 | 0 | Smoke test / quick exploration |
| `tdd-review` | 5 | 2 | Feature implementation with test + code quality gates |
| `dev-sprint` | 6 | 2 | Full development cycle with project review |
| `release-check` | 2 | 0 | Pre-release quality: code review, security audit, stability |
| `refactor` | 5 | 1 | Safe refactoring with regression verification |

Use them as-is or as templates for your own pipelines.

---

## 🏗️ Creating Custom Pipelines

### Three ways to create pipelines

| Method | When to use |
|---|---|
| **Manually** — write `.pipeline.yaml` files in `.pi/pipelines/` | When you know exactly what you want |
| **Via the agent** — describe your workflow, the agent uses the built-in skill to write the YAML | When you want the LLM to handle the details |
| **Copy and modify** — fork one of the 5 built-in pipelines | The fastest way to get started |

### Minimal Pipeline

```yaml
# .pi/pipelines/my-pipeline.pipeline.yaml
name: my-pipeline
description: "Short description"

stages:
  - id: explore
    agent: scout
    task: "Explore: {task}"

  - id: plan
    agent: planner
    task: "Plan based on: {outputs.explore}"
```

### Pipeline with a Review Gate

```yaml
stages:
  - id: implement
    agent: worker
    task: "Implement: {outputs.analyze}"
    gate:
      type: review-loop
      maxRounds: 3          # Default: 3
      targetScore: 8        # Default: 8 (use 9 for tests)
      reviewers:
        - focus: "Does the implementation satisfy all criteria?"
        - focus: "Is the code clean and maintainable?"
        - focus: "Are error paths handled correctly?"
```

### Parallel Stage

```yaml
stages:
  - id: checks
    parallel:
      - id: code-review
        agent: reviewer
        task: "Review code quality: {task}"
      - id: security
        agent: reviewer
        task: "Security audit: {task}"
      - id: perf
        agent: scout
        task: "Performance analysis: {task}"

  - id: decision
    agent: planner
    task: >
      Based on:
      Code Review: {outputs.code-review}
      Security: {outputs.security}
      Decide next steps.
```

### Expand Stage (Dynamic)

```yaml
stages:
  - id: research
    agent: researcher
    task: >
      Find topics for: {task}.
      Return JSON: [{"title":"...","angle":"..."}]

  - id: write-posts
    expand:
      from: research
      maxItems: 5
    agent: worker
    task: "Write blog post: {item.title}. Angle: {item.angle}"
```

For the full pipeline authoring guide with all configuration options, see [skills/pi-pipelines/SKILL.md](skills/pi-pipelines/SKILL.md).

---

## 📐 Architecture

```
User / LLM
  │
  ├── /run-pipeline <name> <task>    (TUI command)
  ├── /pipeline-<name> <task>        (dedicated command per pipeline)
  └── run_pipeline()  /  list_pipelines()   (LLM tools)
  │
  ▼
Pi Pipelines Extension (TypeScript)
  │
  ├── config-loader.ts   — Parse & validate YAML pipeline definitions
  ├── pipeline-runner.ts — Orchestrate stages, gates, and expansions
  ├── subagent-bridge.ts — Event bridge to pi-subagents (with fallback)
  ├── tui-widgets.ts     — TUI status widget for pipeline progress
  └── utils.ts           — Shared utilities
  │
  ▼
pi-subagents (event bridge)
  │
  └── Subagents (scout, planner, worker, reviewer, oracle, ...)
```

---

## 📊 Project Status

| Metric | Status |
|---|---|
| Tests | 314 passing |
| Code Coverage | 97.4% statements, 90% branches |
| Linter | ESLint + Prettier (flat config) |
| Runtime | TypeScript (no build step — Pi loads via jiti) |
| Dependencies | 1 production dep (`js-yaml`) |

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create a branch** for your feature or fix
3. **Write tests** for your changes
4. **Run the check suite**: `pnpm check` (lint + format + tests)
5. **Open a pull request** with a clear description

### Development Setup

```bash
git clone https://github.com/Rybens92/pi-pipelines.git
cd pi-pipelines
pnpm install
pnpm test        # Run tests (314 tests, ~700ms)
pnpm check       # Full suite: lint + format + tests
pnpm test:coverage  # With coverage report
```

### Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/).

---

## ❓ FAQ

**Q: Do I need pi-subagents?**
Yes. Pi Pipelines delegates agent execution to pi-subagents. Install it first: `pi install npm:pi-subagents`.

**Q: Can I use this without Pi?**
No. This is a Pi extension and requires the Pi CLI environment.

**Q: Do I need to build / compile TypeScript?**
No. Pi uses [jiti](https://github.com/unjs/jiti) to load TypeScript directly. No build step needed.

**Q: How many pipelines can I have?**
As many as you like. Each `.pipeline.yaml` file in `.pi/pipelines/` becomes a `/pipeline-<name>` command.

**Q: Can the agent create pipelines for me?**
Yes. The extension includes a [skill](skills/pi-pipelines/SKILL.md) that teaches the Pi agent how to create, validate, and manage pipeline YAML files. Just describe what you need.

**Q: What agents are available for pipeline stages?**

| Agent | Read-only | Edits files | Use case |
|---|---|---|---|
| `scout` | ✅ | ❌ | Code exploration and analysis |
| `planner` | ✅ | ❌ | Planning and synthesis |
| `worker` | ❌ | ✅ | Implementation — only one at a time |
| `reviewer` | ✅ | ❌ | Code review and quality assessment |
| `oracle` | ✅ | ❌ | Strategic analysis and second opinions |
| `researcher` | ✅ | ❌ | Web research (requires `pi-web-access`) |

**Q: How do reviewers score?**
Each reviewer ends their output with `SCORE: N` on the last line (0–10). The pipeline runner parses these scores automatically.

---

## 📝 License

[MIT](LICENSE) — Copyright (c) 2026 Pi Pipelines
