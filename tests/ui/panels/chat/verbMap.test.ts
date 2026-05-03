import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  KNOWN_VERBS,
  TOOL_VERB,
  pickVerb,
} from '../../../../src/ui/panels/chat/verbMap.js';

const TOOLS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'),
  '..',
  '..',
  '..',
  '..',
  'src',
  'orchestrator',
  'tools',
);

function readRegisteredToolNames(): string[] {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
  const names: string[] = [];
  for (const file of files) {
    const body = readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    // Tool registrations all use `name: 'snake_case_id',` exactly once.
    const match = /\bname:\s*'([a-z][a-z0-9_]*)'/.exec(body);
    if (match === null) continue;
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

describe('verbMap', () => {
  test('every registered MCP tool has a verb entry', () => {
    const tools = readRegisteredToolNames();
    expect(tools.length).toBeGreaterThan(15);
    for (const name of tools) {
      expect(TOOL_VERB[name], `missing verb for tool '${name}'`).toBeDefined();
    }
  });

  test('every mapped verb is in the known-verb set', () => {
    for (const verb of Object.values(TOOL_VERB)) {
      expect(KNOWN_VERBS.has(verb)).toBe(true);
    }
  });
});

describe('pickVerb', () => {
  test('returns the mapped verb when currentTool is known', () => {
    expect(pickVerb({ currentTool: 'spawn_worker', hasOpenTextBlock: false })).toBe(
      'Conducting',
    );
    expect(pickVerb({ currentTool: 'list_workers', hasOpenTextBlock: false })).toBe(
      'Listening',
    );
    expect(pickVerb({ currentTool: 'finalize', hasOpenTextBlock: false })).toBe('Resolving');
  });

  test('falls back to Composing for unknown tool name', () => {
    expect(pickVerb({ currentTool: 'imaginary_tool', hasOpenTextBlock: false })).toBe(
      'Composing',
    );
  });

  test('returns Phrasing when no tool but text block is open', () => {
    expect(pickVerb({ currentTool: null, hasOpenTextBlock: true })).toBe('Phrasing');
  });

  test('returns Composing when no tool and no text', () => {
    expect(pickVerb({ currentTool: null, hasOpenTextBlock: false })).toBe('Composing');
  });

  test('currentTool wins over open text block', () => {
    expect(pickVerb({ currentTool: 'finalize', hasOpenTextBlock: true })).toBe('Resolving');
  });
});
