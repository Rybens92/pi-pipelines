/**
 * Core types for the Pipelines extension
 */

/** A reviewer configuration inside a review gate */
export interface ReviewerDef {
  /** What this reviewer should focus on (prompt fragment) */
  focus: string;
  /** Optional specific agent to use (defaults to "reviewer") */
  agent?: string;
}

/** Controls what output of a stage is passed forward to {outputs.stageId} */
export interface StageReportConfig {
  /** How to pass output to next stages:
   *   'full'    — pass the raw agent output as-is (default)
   *   'summary' — ask an LLM to summarize before passing forward
   */
  mode?: "full" | "summary";
  /** Max length of the summary in characters (default: 500). Only used when mode='summary'. */
  maxLength?: number;
  /** Optional instruction to guide the summarizer. Only used when mode='summary'. */
  instruction?: string;
}

/**
 * Dynamic stage expansion configuration.
 * Transforms a single stage template into N parallel stages,
 * one per item from the source stage's output.
 */
export interface ExpandConfig {
  /** ID of the source stage whose output provides the items to expand over */
  from: string;
  /** Maximum number of items to expand (default: 10) */
  maxItems?: number;
}

/** A review gate that wraps a stage with iterative scoring */
export interface ReviewGate {
  type: "review-loop";
  /** Maximum number of worker → review → fix rounds */
  maxRounds: number;
  /** Target score (0-10) that must be met to pass the gate */
  targetScore: number;
  /** List of reviewers to run in parallel each round */
  reviewers: ReviewerDef[];
  /** Optional model to use for the cross-model judge (different from worker) */
  judgeModel?: string;
}

/** A single pipeline stage */
export interface Stage {
  /** Unique stage ID (used for output references like {outputs.stageId}) */
  id: string;
  /** Agent name to use (e.g. "planner", "worker", "reviewer", "scout") */
  agent?: string;
  /** Task description for the agent. Supports {task}, {outputs.stageId}, {lastFeedback} */
  task?: string;
  /** If set, run these stages in parallel */
  parallel?: Stage[];
  /**
   * If set, dynamically expand this stage template into N parallel stages,
   * one per item from the output of stage `expand.from`.
   * In v1, expanded stages do NOT execute gates — use a separate
   * parallel/review stage after the expand stage for quality checks.
   */
  expand?: ExpandConfig;
  /** Optional review gate wrapping this stage */
  gate?: ReviewGate;
  /** Optional model override for this stage */
  model?: string;
  /** Output file for this stage's results */
  output?: string;
  /** Files to read before execution */
  reads?: string[];
  /** Maximum subagent depth for nested delegation */
  maxSubagentDepth?: number;
  /**
   * Controls what output of this stage is passed forward via {outputs.stageId}.
   * When undefined or { mode: 'full' }, the raw agent output is used.
   * When { mode: 'summary' }, the output is summarized before being stored.
   */
  report?: StageReportConfig;
}

/** Configuration for the automatic post-pipeline report synthesizer */
export interface ReportConfig {
  /** Agent to use for synthesis (default: "planner") */
  agent?: string;
  /** Optional focus area to guide the synthesis prompt */
  focus?: string;
}

/** A complete pipeline definition */
export interface PipelineDef {
  /** Pipeline name (matches filename without extension) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Schema version */
  version?: number;
  /** Default judge model for review gates (cross-model) */
  judgeModel?: string;
  /** Pipeline stages */
  stages: Stage[];
  /**
   * Optional report synthesizer configuration.
   * When set (or when omitted), a synthesis agent is called after all
   * stages complete to produce a summary report.
   * Set to false to disable automatic synthesis.
   */
  report?: ReportConfig | false;
}

/** Runtime state for a single stage execution */
export interface StageResult {
  stageId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  rounds?: number; // How many review rounds were needed
  scores?: number[]; // Review scores per round
  rawOutput?: string; // Full raw output from the subagent
}

/** Full pipeline execution result */
export interface PipelineResult {
  pipelineName: string;
  task: string;
  success: boolean;
  stages: StageResult[];
  totalDurationMs: number;
  error?: string;
  /** Synthesized report from the automatic post-pipeline summary agent */
  synthesis?: string;
  /** Error from the synthesis step (synthesis itself can fail without failing the pipeline) */
  synthesisError?: string;
}

/** How to execute a stage — resolved from YAML + defaults */
export interface ResolvedStage {
  original: Stage;
  agent: string;
  task: string;
  isParallel: boolean;
  children: ResolvedStage[];
  gate: ReviewGate | null;
  model: string | undefined;
  output: string | undefined;
  reads: string[] | undefined;
  maxSubagentDepth: number | undefined;
}
