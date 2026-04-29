import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsoncParser from 'jsonc-parser';
import {
  installStopHook,
  uninstallStopHook,
  buildStopHookCommand,
} from '../../src/orchestrator/maestro/hook-installer.js';

let sandbox: string;
let claudeDir: string;
let settingsPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-hook-installer-'));
  claudeDir = join(sandbox, '.claude');
  settingsPath = join(claudeDir, 'settings.local.json');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function readSettings(): unknown {
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function commandStrings(parsed: unknown): string[] {
  const root = parsed as { hooks?: { Stop?: Array<{ hooks: Array<{ command: string }> }> } };
  const stop = root.hooks?.Stop ?? [];
  return stop.flatMap((entry) => entry.hooks.map((h) => h.command));
}

describe('buildStopHookCommand', () => {
  it('returns a curl command that pipes stdin via -d @-', () => {
    const cmd = buildStopHookCommand();
    expect(cmd).toContain('curl -sf -X POST');
    expect(cmd).toContain('-d @-');
    expect(cmd).toContain('|| true');
    expect(cmd).toContain('$SYMPHONY_HOOK_TOKEN');
    expect(cmd).toContain('$SYMPHONY_HOOK_PORT');
    expect(cmd).toContain('X-Symphony-Hook-Token');
    expect(cmd).toContain('X-Symphony-Hook-Event: stop');
  });
});

describe('installStopHook', () => {
  it('creates settings.local.json when it does not exist', async () => {
    expect(existsSync(settingsPath)).toBe(false);
    await installStopHook({ claudeDir, port: 12345 });
    expect(existsSync(settingsPath)).toBe(true);
    const cmds = commandStrings(readSettings());
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('SYMPHONY_HOOK_PORT');
  });

  it('preserves user-defined Stop hooks across install', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'echo "user stop hook"' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await installStopHook({ claudeDir, port: 12345 });
    const cmds = commandStrings(readSettings());
    expect(cmds).toContain('echo "user stop hook"');
    expect(cmds.some((c) => c.includes('SYMPHONY_HOOK_PORT'))).toBe(true);
    expect(cmds).toHaveLength(2);
  });

  it('strips prior Symphony entries on re-install (idempotent)', async () => {
    await installStopHook({ claudeDir, port: 1111 });
    await installStopHook({ claudeDir, port: 2222 });
    const cmds = commandStrings(readSettings());
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('SYMPHONY_HOOK_PORT');
  });

  it('preserves JSONC comments and trailing commas', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      [
        '{',
        '  // user comment that must survive',
        '  "hooks": {',
        '    "Stop": [',
        '      { "hooks": [{ "type": "command", "command": "echo user" }] },',
        '    ],',
        '  },',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await installStopHook({ claudeDir, port: 12345 });
    const raw = readFileSync(settingsPath, 'utf8');
    expect(raw).toContain('// user comment that must survive');
    // Re-parse via jsonc-parser (NOT JSON.parse — the curl literal has chars
    // that look like control sequences to strict JSON when the file is hand-
    // built with a strip-comments hack). jsonc-parser tolerates comments +
    // trailing commas natively and produces the same value JSON.parse would.
    const parsed = jsoncParser.parse(raw, [], {
      allowTrailingComma: true,
      disallowComments: false,
    });
    const cmds = commandStrings(parsed);
    expect(cmds).toContain('echo user');
    expect(cmds.some((c) => c.includes('SYMPHONY_HOOK_PORT'))).toBe(true);
  });

  it('writes valid JSON when no prior file exists', async () => {
    await installStopHook({ claudeDir, port: 9999 });
    expect(() => readSettings()).not.toThrow();
    const root = readSettings() as { hooks: { Stop: unknown[] } };
    expect(root.hooks.Stop).toHaveLength(1);
  });

  it('throws when settings.local.json contains invalid JSONC', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, '{ broken: ', 'utf8');
    await expect(installStopHook({ claudeDir, port: 1 })).rejects.toThrow(/failed to parse/i);
  });

  it('throws when the root is not an object', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, '[1, 2, 3]', 'utf8');
    await expect(installStopHook({ claudeDir, port: 1 })).rejects.toThrow(/root must be a JSON object/);
  });

  it('serializes concurrent installs against the same claudeDir (audit C1)', async () => {
    // Two concurrent installs with different ports. Without the per-claudeDir
    // mutex they race read→modify→atomicWrite and either drop a Symphony
    // entry or end up with both ports' entries (also bad — only one is
    // valid). With the mutex, the second install observes the first's entry
    // (single Symphony marker) and replaces it. Exactly ONE Symphony entry
    // survives, with one of the two ports.
    const N = 8;
    const ports = Array.from({ length: N }, (_, i) => 10000 + i);
    await Promise.all(ports.map((port) => installStopHook({ claudeDir, port })));
    const cmds = commandStrings(readSettings());
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('SYMPHONY_HOOK_PORT');
  });
});

describe('uninstallStopHook', () => {
  it('is a no-op when settings.local.json is missing', async () => {
    await expect(uninstallStopHook({ claudeDir })).resolves.toBeUndefined();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('removes only Symphony entries, preserves user hooks', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'echo "user stop hook"' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await installStopHook({ claudeDir, port: 7777 });
    let cmds = commandStrings(readSettings());
    expect(cmds).toHaveLength(2);

    await uninstallStopHook({ claudeDir });
    cmds = commandStrings(readSettings());
    expect(cmds).toEqual(['echo "user stop hook"']);
  });

  it('preserves JSONC comments through round-trip', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      [
        '{',
        '  // important comment',
        '  "hooks": {}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await installStopHook({ claudeDir, port: 1234 });
    await uninstallStopHook({ claudeDir });
    const raw = readFileSync(settingsPath, 'utf8');
    expect(raw).toContain('// important comment');
  });

  it('honors a custom marker on uninstall', async () => {
    // Hand-craft a settings file with a "third-party" hook tagged by the
    // marker we'll later pass to uninstall — proves the marker arg actually
    // drives the strip filter (not just the default `SYMPHONY_HOOK_PORT`).
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'echo "user keep"' }] },
              { hooks: [{ type: 'command', command: 'curl THIRD_PARTY_TAG /hook' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await uninstallStopHook({ claudeDir, marker: 'THIRD_PARTY_TAG' });
    const cmds = commandStrings(readSettings());
    expect(cmds).toEqual(['echo "user keep"']);
  });
});
