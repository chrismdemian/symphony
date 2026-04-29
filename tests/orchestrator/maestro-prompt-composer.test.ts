import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeMaestroPrompt,
  resolveMaestroPromptsDir,
  MaestroPromptLoadError,
  type MaestroPromptVars,
} from '../../src/orchestrator/maestro/prompt-composer.js';

const FULL_PROMPT_FIXTURE = `# Maestro — System Prompt v1

> Header commentary that must NOT make it into the rendered output.

**Template variables**: {project_name}, {registered_projects}, {workers_in_flight}, {current_mode}, {autonomy_default}, {plan_mode_required}.

---

## BEGIN PROMPT

You are Maestro.

Current project context:
- Active project: {project_name}
- Registered projects available to delegate to: {registered_projects}
- Workers currently in flight: {workers_in_flight}
- Current mode: {current_mode}
- Default autonomy tier: {autonomy_default}
- Plan-mode-required: {plan_mode_required}
- Preview command: {preview_command}
- Tools: {available_tools}
- Warmth: {maestro_warmth}

Example JSON spec (must NOT have its braces touched): { "key": "value", "n": 7 }

## END PROMPT

---

## Iteration notes (do not inject — meta-commentary)
This trailing section MUST be stripped.
`;

let sandbox: string;
let promptsDir: string;

const VARS: MaestroPromptVars = {
  projectName: 'symphony',
  registeredProjects: 'symphony, mathscrabble',
  workersInFlight: '(none)',
  currentMode: 'PLAN',
  autonomyDefault: '2',
  planModeRequired: false,
  previewCommand: 'pnpm dev',
  availableTools: 'see §Modes',
  maestroWarmth: 'middle',
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-maestro-prompt-'));
  promptsDir = join(sandbox, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'maestro-system-prompt-v1.md'), FULL_PROMPT_FIXTURE, 'utf8');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('composeMaestroPrompt', () => {
  it('substitutes every documented template variable', () => {
    const result = composeMaestroPrompt(VARS, { promptsDir });
    expect(result).toContain('Active project: symphony');
    expect(result).toContain('Registered projects available to delegate to: symphony, mathscrabble');
    expect(result).toContain('Workers currently in flight: (none)');
    expect(result).toContain('Current mode: PLAN');
    expect(result).toContain('Default autonomy tier: 2');
    expect(result).toContain('Plan-mode-required: false');
    expect(result).toContain('Preview command: pnpm dev');
    expect(result).toContain('Tools: see §Modes');
    expect(result).toContain('Warmth: middle');
  });

  it('strips header commentary and trailing iteration notes (BEGIN/END markers only)', () => {
    const result = composeMaestroPrompt(VARS, { promptsDir });
    expect(result).not.toContain('Header commentary');
    expect(result).not.toContain('Iteration notes');
    expect(result).not.toContain('Template variables');
    expect(result).not.toContain('## BEGIN PROMPT');
    expect(result).not.toContain('## END PROMPT');
  });

  it('renders empty values as the literal "(none)" sentinel — never "undefined"', () => {
    const result = composeMaestroPrompt(
      { ...VARS, registeredProjects: '', workersInFlight: '' },
      { promptsDir },
    );
    expect(result).toContain('Registered projects available to delegate to: (none)');
    expect(result).toContain('Workers currently in flight: (none)');
    expect(result).not.toContain('undefined');
  });

  it('does NOT touch JSON-shaped braces in the prompt body', () => {
    const result = composeMaestroPrompt(VARS, { promptsDir });
    expect(result).toContain('{ "key": "value", "n": 7 }');
  });

  it('throws MaestroPromptLoadError when v1 prompt is missing', () => {
    rmSync(join(promptsDir, 'maestro-system-prompt-v1.md'));
    expect(() => composeMaestroPrompt(VARS, { promptsDir })).toThrow(MaestroPromptLoadError);
  });

  it('throws MaestroPromptLoadError when BEGIN/END markers are missing', () => {
    writeFileSync(
      join(promptsDir, 'maestro-system-prompt-v1.md'),
      'No markers here.\n',
      'utf8',
    );
    expect(() => composeMaestroPrompt(VARS, { promptsDir })).toThrow(/BEGIN PROMPT.*END PROMPT/);
  });

  it('preserves boolean true rendering', () => {
    const result = composeMaestroPrompt({ ...VARS, planModeRequired: true }, { promptsDir });
    expect(result).toContain('Plan-mode-required: true');
  });
});

describe('resolveMaestroPromptsDir', () => {
  it('honors an explicit override', () => {
    expect(resolveMaestroPromptsDir(import.meta.url, '/explicit/path')).toBe('/explicit/path');
  });
});
