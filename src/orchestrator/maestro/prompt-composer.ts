import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The 10 template variables documented in `research/prompts/maestro-system-prompt-v1.md`.
 *
 * Six are referenced in the prompt body today; three (`previewCommand`,
 * `availableTools`, `maestroWarmth`) are reserved for 4D fragment expansion;
 * `modelMode` (Phase 3H.2) gates Maestro's per-task model selection — when
 * `'opus'`, Symphony forces every spawn to Opus; when `'mixed'`, Maestro
 * decides per task. Empty/null values render as the literal string `(none)`
 * so Maestro never reads `undefined`.
 */
export interface MaestroPromptVars {
  projectName: string;
  registeredProjects: string;
  workersInFlight: string;
  currentMode: 'PLAN' | 'ACT';
  autonomyDefault: '1' | '2' | '3';
  planModeRequired: boolean;
  previewCommand: string;
  availableTools: string;
  maestroWarmth: string;
  modelMode: 'opus' | 'mixed';
}

const TEMPLATE_KEY_TO_FIELD: Record<string, keyof MaestroPromptVars> = {
  project_name: 'projectName',
  registered_projects: 'registeredProjects',
  workers_in_flight: 'workersInFlight',
  current_mode: 'currentMode',
  autonomy_default: 'autonomyDefault',
  plan_mode_required: 'planModeRequired',
  preview_command: 'previewCommand',
  available_tools: 'availableTools',
  maestro_warmth: 'maestroWarmth',
  model_mode: 'modelMode',
};

const BEGIN_MARKER = '## BEGIN PROMPT';
const END_MARKER = '## END PROMPT';

const NONE_LITERAL = '(none)';

/**
 * Resolve the directory holding `maestro-system-prompt-v1.md` etc.
 *
 * Two shapes (mirrors `state/path.ts:resolveMigrationsPath`):
 *  - Source-run (tsx / vitest): files live at `research/prompts/`.
 *  - Bundled (tsup): `tsup` `onSuccess` copies them to `dist/prompts/`.
 *
 * Callers may pass an explicit `moduleUrl`/`overrideDir` in tests to keep
 * resolution out of the critical path.
 */
export function resolveMaestroPromptsDir(
  moduleUrl: string = import.meta.url,
  overrideDir?: string,
): string {
  if (overrideDir !== undefined) return overrideDir;
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    // src/orchestrator/maestro/ → ../../../research/prompts (tsx run)
    path.resolve(here, '..', '..', '..', 'research', 'prompts'),
    // dist/index.js cwd-adjacent (tsup) → dist/prompts/
    path.resolve(here, 'prompts'),
    // dist/orchestrator/maestro/ → ../../prompts (alt bundle layout)
    path.resolve(here, '..', '..', 'prompts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  // m6: surface every probed path so debug sessions don't chase a phantom.
  throw new MaestroPromptLoadError(
    `Could not locate Maestro prompts directory. Tried:\n  - ${candidates.join('\n  - ')}\n` +
      `Pass an explicit \`promptsDir\` override or rebuild via \`pnpm build\` to populate dist/prompts/.`,
    candidates[0]!,
  );
}

/**
 * Load the v1 Maestro system prompt (frozen artifact at
 * `research/prompts/maestro-system-prompt-v1.md`), strip the meta-commentary
 * outside `## BEGIN PROMPT` / `## END PROMPT`, and substitute every template
 * variable.
 *
 * Phase 4D will replace this with a fragment-based PromptComposer; the v1
 * artifact stays frozen by design.
 */
export function composeMaestroPrompt(
  vars: MaestroPromptVars,
  options: { promptsDir?: string } = {},
): string {
  const dir = resolveMaestroPromptsDir(import.meta.url, options.promptsDir);
  const file = path.join(dir, 'maestro-system-prompt-v1.md');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new MaestroPromptLoadError(
      `failed to read Maestro v1 prompt at ${file}: ${(err as Error).message}`,
      file,
    );
  }
  const body = extractPromptBody(raw, file);
  return substituteVars(body, vars);
}

/**
 * Render a "(none)" fallback for empty values so the prompt never contains
 * the string "undefined" when Maestro's environment is fresh.
 */
function rawValue(vars: MaestroPromptVars, field: keyof MaestroPromptVars): string {
  const v = vars[field];
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return s.length === 0 ? NONE_LITERAL : s;
}

function substituteVars(body: string, vars: MaestroPromptVars): string {
  // Match {token_name} where token_name is lowercase + underscores.
  // Other braces (JSON examples in the prompt body) are left untouched.
  return body.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    const field = TEMPLATE_KEY_TO_FIELD[key];
    if (field === undefined) return match;
    return rawValue(vars, field);
  });
}

function extractPromptBody(raw: string, file: string): string {
  const beginIdx = raw.indexOf(BEGIN_MARKER);
  const endIdx = raw.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new MaestroPromptLoadError(
      `expected "${BEGIN_MARKER}" / "${END_MARKER}" markers in ${file}; got begin=${beginIdx} end=${endIdx}`,
      file,
    );
  }
  // Skip the marker line itself, but preserve everything after it.
  const afterBegin = raw.indexOf('\n', beginIdx);
  if (afterBegin === -1 || afterBegin > endIdx) {
    throw new MaestroPromptLoadError(
      `expected newline after "${BEGIN_MARKER}" before END marker in ${file}`,
      file,
    );
  }
  return raw.slice(afterBegin + 1, endIdx).trimEnd() + '\n';
}

export class MaestroPromptLoadError extends Error {
  constructor(message: string, public readonly file: string) {
    super(message);
    this.name = 'MaestroPromptLoadError';
  }
}
