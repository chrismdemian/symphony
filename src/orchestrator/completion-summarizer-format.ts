/**
 * Phase 3K — pure formatting helpers shared between the server-side
 * summarizer and the TUI's system Bubble. Lives in its own file (no
 * Node-only imports) so the TUI bundle can import `formatDuration`
 * without transitively pulling `child_process` from `one-shot.ts`.
 *
 * The `completion-summarizer.ts` module re-imports these helpers and
 * the TUI imports directly from here.
 */

/**
 * Format a duration in ms to a human-friendly compact string (`2m 18s`,
 * `38s`, `3h 4m`). Used in the system Bubble's header line and by the
 * heuristic summary's metrics line.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '(unknown)';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}
