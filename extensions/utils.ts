/**
 * Shared utility functions for pi-pipelines.
 */

/**
 * Format a duration in milliseconds into a human-readable string.
 * @internal Exported for testing. See pipeline-runner.test.ts
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${min}m ${sec}s`;
}
