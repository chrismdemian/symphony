import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parse as parseJsonc } from 'jsonc-parser';

import { writeDroidFenceSettings } from '../../src/droids/settings-writer.js';
import { DROID_FENCE_MARKER } from '../../src/droids/hook-command.js';

const CMD = `node "/sym/dist/droids/fence-hook.js" ${DROID_FENCE_MARKER}`;

let wt: string;
let settingsPath: string;

beforeEach(() => {
  wt = mkdtempSync(path.join(tmpdir(), 'sym-4f1-sw-'));
  settingsPath = path.join(wt, '.claude', 'settings.local.json');
});
afterEach(() => {
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Parse as JSONC: the comment-preservation test deliberately leaves a
// `//` comment in the file (proving editJsoncFile kept it), which plain
// JSON.parse would reject.
function read(): Record<string, unknown> {
  return parseJsonc(readFileSync(settingsPath, 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('writeDroidFenceSettings', () => {
  it('creates .claude/settings.local.json with the PreToolUse fence entry', async () => {
    await writeDroidFenceSettings({ worktreePath: wt, fenceCommand: CMD });
    const j = read() as { hooks: { PreToolUse: unknown[] } };
    expect(j.hooks.PreToolUse).toHaveLength(1);
    const entry = j.hooks.PreToolUse[0] as {
      hooks: Array<{ type: string; command: string; timeout: number }>;
    };
    expect(entry.hooks[0]).toEqual({
      type: 'command',
      command: CMD,
      timeout: 10,
    });
  });

  it('is idempotent — re-install strips the prior Symphony entry (no accumulation)', async () => {
    await writeDroidFenceSettings({ worktreePath: wt, fenceCommand: CMD });
    await writeDroidFenceSettings({
      worktreePath: wt,
      fenceCommand: `${CMD}`,
    });
    const j = read() as { hooks: { PreToolUse: unknown[] } };
    expect(j.hooks.PreToolUse).toHaveLength(1);
  });

  it('preserves user-authored PreToolUse entries, other keys, and JSONC comments', async () => {
    mkdirSync(path.join(wt, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath,
      `{
  // user's own settings — must survive
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "echo user-hook" }] }
    ]
  }
}
`,
    );
    await writeDroidFenceSettings({ worktreePath: wt, fenceCommand: CMD });
    const raw = readFileSync(settingsPath, 'utf8');
    expect(raw).toContain("user's own settings"); // comment preserved
    const j = read() as {
      model: string;
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(j.model).toBe('opus'); // sibling key preserved
    const cmds = j.hooks.PreToolUse.map((e) => e.hooks[0]!.command);
    expect(cmds).toContain('echo user-hook'); // user hook preserved
    expect(cmds).toContain(CMD); // ours appended
    expect(j.hooks.PreToolUse).toHaveLength(2);
  });

  it('throws on a corrupt existing settings file (fail fast — never silently overwrite)', async () => {
    mkdirSync(path.join(wt, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ this is not json ');
    await expect(
      writeDroidFenceSettings({ worktreePath: wt, fenceCommand: CMD }),
    ).rejects.toThrow();
  });
});
