---
description: >
  Create YAML pipelines for the pi-pipelines extension: locations, format,
  stage types, scoring review gates, template variables, agent recommendations,
  testing, and examples.
---

# Pi Pipelines — Creating Custom Pipelines

Complete guide for creating YAML pipelines for the pi-pipelines extension.

---

## 1. Where to create pipelines

Pipelines are discovered in three locations, in this order:

| Location | Description |
|---|---|
| `.pi/pipelines/` | **Project** — pipelines specific to the current project |
| `~/.pi/pipelines/` | **Global** — pipelines available in every project |
| `pipelines/` (extension) | **Bundled** — default pipelines shipped with the extension |

A project pipeline overrides a global pipeline, and a global pipeline overrides a bundled pipeline.
You can override any bundled pipeline by creating your own pipeline with the same name in `.pi/pipelines/` or `~/.pi/pipelines/`.

On first startup, the extension automatically copies bundled pipelines to `~/.pi/pipelines/` if they do not already exist.

---

## 2. Minimal pipeline — basic format

```yaml
name: hello-world
description: "Short description of what the pipeline does"

stages:
  - id: explore
    agent: scout
    task: "Explore the project structure for: {task}"

  - id: plan
    agent: planner
    task: "Create a plan based on: {outputs.explore}"
```

### Required fields

| Field | Description |
|---|---|
| `name` | Pipeline name, used as `/pipeline-<name>` |
| `description` | Description shown by `/list-pipelines` |
| `stages[]` | List of stages to execute |

### Every stage requires:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique stage identifier |
| `agent` or `parallel` | string/array | Agent to run, or list of parallel agents |
| `task` | string | Task for the agent; supports template variables |
| `model` *optional* | string | Model override for this stage |

---

## 3. Template variables

Before a task is sent to an agent, the runner resolves template variables:

| Variable | Resolves to | Example |
|---|---|---|
| `{task}` | Original task passed when the pipeline was launched | `"/pipeline-hello 'do X'"` → `{task}` = `"do X"` |
| `{outputs.<stageId>}` | Output from a previous stage, including parallel child IDs | `{outputs.analyze}` → output from stage `analyze` |
| `{lastFeedback}` | Latest feedback from a review gate, inside retry loops | Inserted automatically during gate retries |
| `{item}` | Whole item from dynamic expansion; JSON for objects, raw value for strings | `{item}` → `{"path":"src/a.ts"}` |
| `{item.<key>}` | Single field from a dynamic expansion item | `{item.path}` → `src/a.ts` |

**Example:**

```yaml
stages:
  - id: research
    agent: researcher
    task: "Research: {task}"

  - id: implement
    agent: worker
    task: "Implement based on: {outputs.research}"
```

**Important:** A stage does **not** automatically see previous stage outputs.
You must explicitly reference `{outputs.previousStage}` in the task.
Without that reference, the stage runs in isolation.

---

## 4. Stage types

### 4a. Simple Stage — one agent

```yaml
- id: analyze
  agent: planner
  task: "Create a plan: {task}"
  model: "anthropic/claude-sonnet-4"    # optional model override
```

### 4b. Parallel Stage — multiple agents at once

```yaml
- id: research
  parallel:
    - id: security
      agent: reviewer
      task: "Security analysis: {task}"
    - id: perf
      agent: scout
      task: "Performance analysis: {task}"
    - id: code
      agent: reviewer
      task: "Code review: {task}"
```

Agents in a `parallel` stage run concurrently.
The pipeline waits for all agents to finish, then stores the combined result in `outputs.<parallelStageId>`.
Each child output is also available under its own child ID, for example `{outputs.health}` or `{outputs.security}`.

**Example:**

```yaml
- id: checks
  parallel:
    - id: health
      agent: oracle
      task: "Assess project stability"
    - id: security
      agent: reviewer
      task: "Run a security review"

- id: decision
  agent: planner
  task: >
    Health: {outputs.health}
    Security: {outputs.security}
    Decide what to do next.
```

**Benefits of parallel stages:**
- Faster execution for I/O-bound work.
- Multiple perspectives on the same task.
- Saves time when stages are independent.

### 4c. Review Gate Stage — quality loop

```yaml
- id: implement
  agent: worker
  task: "Implement: {outputs.analyze}"
  gate:
    type: review-loop          # only supported gate type for now
    maxRounds: 3               # max attempts; default: 3
    targetScore: 9             # minimum average score, 0-10
    reviewers:
      - focus: "Does the code cover all required cases?"
      - focus: "Is the code clean and free of duplication?"
      - focus: "Are the tests production-ready?"
```

**How a review gate works:**

```
Round 1: Worker runs the task
         ↓
         Parallel reviewers receive the output + focus
         ↓
         Each reviewer ends with "SCORE: N" (0-10)
         ↓
         Average score: (8 + 7 + 9) / 3 = 8.0
         ↓
         8.0 < 9.0? → ⚠ Feedback → Round 2 with fixes

Round 2: Worker receives {lastFeedback} → improves the work
         ↓
         Reviewers score again
         ↓
         9.3 >= 9.0? → ✅ PASS

If the score is still below target after maxRounds → ❌ FAIL
```

**Cross-model judging:** reviewers should use a different model than the worker to reduce the bias of "checking your own work."
Set `model` on the stage, or configure it in pi-subagents.

---

### 4d. Expand Stage — dynamic task decomposition

An `expand` stage creates N parallel tasks from the output of a previous stage.
It is ideal when one agent discovers a list of files/topics, and each item should be processed independently.

**How it works:**

```
Source stage (scout): returns a JSON array of items
  → [{"path":"src/a.ts","risk":"high"}, {"path":"src/b.ts","risk":"low"}]
  ↓
Runner parses the output → creates N dynamic stages
  ↓
Stage-1: Worker → "Refactor src/a.ts: high"
Stage-2: Worker → "Refactor src/b.ts: low"
  ↓
Dynamic stages run in parallel → results are aggregated into outputs
```

**YAML syntax:**

```yaml
stages:
  - id: find-files
    agent: scout
    task: >
      Find files to refactor for: {task}.
      Return JSON: [{"path":"...","risk":"..."}, ...]

  - id: refactor-each
    expand:
      from: find-files            # source: output from stage find-files
      maxItems: 5                 # optional limit; default: 10
    agent: worker
    task: "Refactor {item.path}: {item.risk}"
    # gate: ...                   # ❌ not supported in v1
```

**Template variables for expand:**

| Variable | Resolves to |
|---|---|
| `{item}` | Whole item; JSON for objects, raw value for strings |
| `{item.path}` | Value of the `path` field from the item |
| `{item.name}` | Value of the `name` field from the item |
| `{item.<key>}` | Any field from an object item |

**Source output parsing strategies:**

| Strategy | Format | Example |
|---|---|---|
| 1. JSON | Array or `{items: [...]}` | `[{"path":"a.ts"}, ...]` |
| 2. YAML | Sequence | `- path: a.ts` |
| 3. Markdown | `-`, `*`, or numbered list | `- src/a.ts` |

**Use cases:**

| Goal | Source stage returns | Dynamic stages |
|-----|---------------------|-------------------|
| Refactoring | List of files + risk | Worker refactors each file |
| Content marketing | List of topics + angles | Worker writes each post |
| Postmortem | List of events + timestamps | Worker reconstructs each event |
| Code review | List of modules + focus areas | Reviewer checks each module |

**v1 limitations:**
- Gates on expanded stages are **not** executed. Use a separate review/aggregation stage after expand.
- All dynamic stages use the same agent from the expand template's `agent` field.
- The expand stage output is aggregated as one string in `outputs`.

### 4e. Stage Report — compressing output between stages

Optionally compress a stage output before passing it to the next stage.
By default, output is passed through unchanged (`full`).

```yaml
stages:
  - id: explore
    agent: scout
    task: "Explore the project: {task}"
    report:
      mode: summary        # 'full' (default) or 'summary'
      maxLength: 500       # max summary length; default: 500
      instruction: >       # optional instruction for the summarizer
        Extract key files and architecture decisions
```

**When to use `report: summary`:**
- A scout returned a 50 KB analysis, but the next stage only needs conclusions.
- You want to reduce token cost in long pipelines.

**When not to use it:**
- The next stage needs full context, for example a code review of the complete codebase.
- The pipeline has only 1-2 stages; token savings are usually minimal.

### 4f. Pipeline Report — final synthesis

After all stages finish, the pipeline automatically starts a synthesis agent that summarizes the whole run.
You can configure which agent and focus to use:

```yaml
name: code-review
# ... description ...
report:
  agent: planner           # synthesis agent; default: "planner"
  focus: "release check"   # optional synthesis prompt focus
```

**Disable synthesis:**

```yaml
name: hello-world
report: false              # disables the synthesis agent
```

Synthesis is **best-effort**. If the synthesis agent fails, the pipeline itself is not failed.
The result will include `synthesisError`.

**Where synthesis appears:**
- In the `run_pipeline` tool output, as a block in `buildPipelineContextMessage`.
- In `formatPipelineResult`, as a quoted block at the top of the report.
- In the message injected into the conversation after `/pipeline-*`.

---

## 5. Complete example: code review pipeline

```yaml
name: code-review
description: "Full code review pipeline with security and performance checks"

stages:
  - id: explore
    agent: scout
    task: >
      Explore the code structure for: {task}.
      List all files that need review.
    model: "deepseek/deepseek-v4-flash"

  - id: review
    agent: reviewer
    task: >
      Perform a code review based on: {outputs.explore}.
      Check readability, architecture, tests, and error handling.

  - id: security-check
    agent: oracle
    task: >
      Perform a security review based on: {outputs.explore}.
      Look for injection, auth bypass, unsafe deserialization, and secrets in code.

  - id: final-report
    agent: planner
    task: >
      Create a final report combining:
      - Code review: {outputs.review}
      - Security: {outputs.security-check}
      Task: {task}
```

---

## 6. Complete example: TDD pipeline with gates

```yaml
name: tdd-cycle
description: "TDD cycle with gates for tests and code"

stages:
  - id: analyze
    agent: planner
    task: >
      Create an implementation plan for: {task}.
      Include acceptance criteria, test cases, and architecture.

  - id: write-tests
    agent: worker
    task: >
      Write tests based on: {outputs.analyze}.
      Use the existing test framework.
    gate:
      type: review-loop
      maxRounds: 3
      targetScore: 9
      reviewers:
        - focus: "Coverage of all scenarios from the plan"
        - focus: "Are tests production-ready? Include edge cases and error paths."
        - focus: "Are tests readable and maintainable?"

  - id: implement
    agent: worker
    task: >
      Implement code that passes the tests: {outputs.write-tests}.
      Task: {outputs.analyze}.
    gate:
      type: review-loop
      maxRounds: 3
      targetScore: 8
      reviewers:
        - focus: "Correctness against acceptance criteria"
        - focus: "Code cleanliness, DRY, SOLID"
        - focus: "Error handling and edge cases"

  - id: verify
    agent: worker
    task: >
      Run all tests and verify whether they pass.
      Report which tests pass/fail and include coverage information.

  - id: propose-next
    agent: oracle
    task: >
      Based on the work so far: {outputs.verify}
      and the original task: {task}
      propose the next steps.
```

---

## 7. Complete example: content-campaign pipeline with expand

```yaml
name: content-campaign
description: "Generates a content campaign: research → posts → visuals → quality"

report:
  agent: planner
  focus: "content campaign completeness"

stages:
  - id: research
    agent: researcher
    task: >
      Research trending topics for: {task}.
      Return JSON: [{"title":"...","angle":"...","keywords":["..."]}, ...]
      Minimum 3 topics.

  - id: write-posts
    expand:
      from: research
      maxItems: 5
    agent: worker
    task: >
      Write a blog post for: {item.title}
      Angle: {item.angle}
      Keywords: {item.keywords}
      Format: markdown, 800-1500 words.

  - id: generate-visuals
    expand:
      from: research
      maxItems: 5
    agent: worker
    task: >
      Create visual concept for: {item.title}
      Describe hero image, supporting diagrams, social media card.

  - id: quality-review
    parallel:
      - agent: reviewer
        task: "Review ALL posts for quality: {outputs.write-posts}"
      - agent: reviewer
        task: "Review ALL visual concepts: {outputs.generate-visuals}"

  - id: compile-campaign
    agent: planner
    task: >
      Compile the full campaign for: {task}.
      Posts: {outputs.write-posts}
      Visuals: {outputs.generate-visuals}
      Reviews: {outputs.quality-review}
      Output editorial calendar, each post, and promotion plan.
```

**Step-by-step flow:**

```
research (researcher) → JSON with 3-5 topics
  ↓
write-posts (expand × N) → each topic = one worker

generate-visuals (expand × N) → each topic = one visual concept
  ↓ (both expands run independently)
quality-review (parallel × 2) → one reviewer for posts, one for visuals
  ↓
compile-campaign (planner) → final report
```

**Key difference:** The `research` source stage returns data, and `expand`
creates N stages that process each item independently. The next stage,
`quality-review`, receives the aggregated output from all expanded stages via
`{outputs.write-posts}`.

---

## 8. Agent recommendations

| Role | Agent | Notes |
|---|---|---|
| Code analysis / exploration | `scout` | Cheap, fast, reads files, returns structure |
| Planning | `planner` | Read-only; good for plans and analysis |
| Implementation | `worker` | Only agent that edits files. Use one worker at a time |
| Code review | `reviewer` | Reads code and checks quality; can make small fixes |
| Second opinion | `oracle` | Read-only; challenges decisions and supports strategic discussion |
| Research | `researcher` | Searches the web. Requires `pi-web-access` |
| General delegate | `delegate` | Behaves like the parent session |

**Single-worker rule:** only one `worker` should edit files at a time.
The other agents (`scout`, `planner`, `reviewer`, `oracle`) are read-only.

---

## 9. Good practices

### 9a. Pipeline naming
- Use short names without spaces: `code-review`, `tdd-cycle`, `release-prep`.
- The `description` should explain when to use the pipeline.

### 9b. Gate configuration
- Use `targetScore: 9` for tests because the quality bar is high.
- Use `targetScore: 8` for code because code can be "good enough" for a first pass.
- Use `maxRounds: 2-3`; more rounds are usually not worth the time.
- Use 2-3 reviewers per gate. One reviewer is too little; 4+ is usually overkill.

### 9c. Template variables in tasks
- Always use `{outputs.previousStage}` when the next agent needs context.
- Use `{task}` at the start of the first stage and in summary stages.
- Do not use `{lastFeedback}` manually; review gates insert it automatically.

### 9d. Expand — good practices
- The source stage should return STRUCTURED data, preferably JSON.
- Use `maxItems` to avoid accidentally creating hundreds of stages.
- Nested expand is not supported; use two expand stages one after another.
- Usually place a review/aggregation stage after expand because expanded stages do not have gates in v1.
- JSON with an `items` key (`{"items": [...]}`) is the safest format because agents can generate it easily.

### 9e. Models
- Set `model` on stages that require a specific model.
- Reviewers should use a different model than the worker for cross-model judging.
- For quick pipelines such as `hello-world`, do not set a model; let the default model run.

### 9f. Pipeline structure
- 2-6 stages is a good default.
- First stage: usually `scout` or `planner` for exploration.
- Last stage: usually `oracle` or `planner` for synthesis and next steps.
- Use gates only on critical stages such as tests and implementation.

---

## 10. Testing a new pipeline

After creating a file in one of the supported locations:
- **Project**: `.pi/pipelines/<name>.pipeline.yaml`
- **Global**: `~/.pi/pipelines/<name>.pipeline.yaml`

Check whether Pi sees the pipeline:

```bash
# 1. Check whether Pi sees the pipeline
/list-pipelines
# You should see: /pipeline-<name>

# 2. Run a quick smoke test
/pipeline-<name> "quick test"

# 3. If the pipeline has gates, verify that they work
# Reviewers should end their output with SCORE: N
```

If the pipeline does not appear:
- Check whether the file is in `.pi/pipelines/` or `~/.pi/pipelines/`.
- Check whether the file extension is `.pipeline.yaml`.
- Check YAML syntax; indentation matters.
- Restart Pi; commands are registered at startup.

---

## 11. Bundled pipeline examples

The extension ships 5 example pipelines, automatically copied to `~/.pi/pipelines/` on first startup:

| File | Description | Gates |
|---|---|---|
| `hello-world.pipeline.yaml` | Minimal: scout → planner | 0 |
| `tdd-review.pipeline.yaml` | TDD with test and code gates | 2 |
| `dev-sprint.pipeline.yaml` | Full development cycle | 2 |
| `release-check.pipeline.yaml` | Pre-release quality check | 0 |
| `refactor.pipeline.yaml` | Safe refactoring with a gate | 1 |

Use them as starting points for your own pipelines.
