# Changelog

All notable changes to pi-pipelines will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-06-11

### Added

- **Initial release** — declarative multi-agent pipelines as a Pi extension.
- YAML pipeline definitions (`.pi/pipelines/*.pipeline.yaml`) with validation.
- Three stage types: sequential, parallel (fan-out), and review gates (scoring loops).
- Dynamic stage expansion (`expand.from`) — fan out one stage into N parallel stages from structured output.
- Automatic pipeline report synthesis after all stages complete.
- Stage output compression (`report: summary`) for long-running pipelines.
- Template variables: `{task}`, `{outputs.*}`, `{lastFeedback}`, `{item}`, `{item.*}`.
- LLM-callable tools: `run_pipeline` and `list_pipelines` with prompt guidelines.
- TUI status widget showing pipeline progress and results.
- Auto-discovery: `/pipeline-<name>` commands generated per pipeline definition.
- Auto-seed: bundled pipelines copied to `~/.pi/pipelines/` on first startup.
- 5 built-in example pipelines: `hello-world`, `tdd-review`, `dev-sprint`, `release-check`, `refactor`.
- Complete skill (`skills/pi-pipelines/SKILL.md`) for agent to create and manage pipelines autonomously.
- Per-round timeouts in review gates (10 min worker, 5 min reviewer).
- ESLint + Prettier configuration with `pnpm check` pre-publish hook.
- 314 tests with 97.4% code coverage.
