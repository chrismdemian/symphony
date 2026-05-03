/**
 * Orchestral verb dispatch for the chat status line.
 *
 * Each MCP tool maps to a single-word musical verb. The selector
 * `pickVerb` chooses based on the in-flight tool (preferred), the
 * presence of an open assistant text block, or a default.
 *
 * Mapping decisions (Plan §3B Architecture):
 *   - "Listening" replaces "Holding" for status reads (`list_*`,
 *     `get_*`, `find_*`, `global_status`, `think`).
 *   - "Holding" reserved for explicit `ask_user` waiting state in 3E.
 *   - "Composing" is the fall-through (no current tool, no text block).
 *   - "Phrasing" indicates the assistant is mid-prose between tool
 *     calls — gives the user signal the model is generating words, not
 *     waiting on a tool.
 *
 * Adding a new MCP tool? Add an entry here. The `verbMap.test.ts`
 * suite walks `src/orchestrator/tools/*.ts` for `name: 'foo'` literals
 * and asserts coverage — un-mapped tools fail the suite.
 */

export const TOOL_VERB: Readonly<Record<string, string>> = Object.freeze({
  // Worker lifecycle
  spawn_worker: 'Conducting',
  send_to_worker: 'Voicing',
  kill_worker: 'Soloing',
  resume_worker: 'Modulating',

  // Research / fan-out
  research_wave: 'Auditioning',

  // Audit / merge pipeline
  audit_changes: 'Cadencing',
  finalize: 'Resolving',
  review_diff: 'Cadencing',

  // Reads
  list_workers: 'Listening',
  list_tasks: 'Listening',
  list_projects: 'Listening',
  get_worker_output: 'Listening',
  global_status: 'Listening',
  find_worker: 'Listening',
  get_project_info: 'Listening',
  think: 'Listening',

  // Planning / scoring
  create_task: 'Scoring',
  update_task: 'Scoring',
  propose_plan: 'Scoring',

  // Worktree
  create_worktree: 'Arranging',

  // User loop
  ask_user: 'Improvising',
});

const DEFAULT_VERB = 'Composing';
const PROSE_VERB = 'Phrasing';

export interface PickVerbInput {
  /** Most recent in-flight tool name, or null when no tool is active. */
  readonly currentTool: string | null;
  /** True when the latest assistant block is text (model is generating prose). */
  readonly hasOpenTextBlock: boolean;
}

export function pickVerb({ currentTool, hasOpenTextBlock }: PickVerbInput): string {
  if (currentTool !== null) {
    return TOOL_VERB[currentTool] ?? DEFAULT_VERB;
  }
  if (hasOpenTextBlock) {
    return PROSE_VERB;
  }
  return DEFAULT_VERB;
}

export const KNOWN_VERBS: ReadonlySet<string> = new Set([
  ...Object.values(TOOL_VERB),
  PROSE_VERB,
  DEFAULT_VERB,
]);
