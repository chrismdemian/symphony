import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClaudeTrust } from '../../src/workers/trust.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-trust-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function configPath(): string {
  return join(sandbox, '.claude.json');
}

describe('ensureClaudeTrust', () => {
  it('creates the config file when absent', () => {
    const worktree = join(sandbox, 'project-a');
    const { changed, error } = ensureClaudeTrust(worktree, { configPath: configPath() });
    expect(error).toBeUndefined();
    expect(changed).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean; hasCompletedProjectOnboarding: boolean }>;
    };
    expect(parsed.projects[worktree]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('is idempotent — second call reports changed=false', () => {
    const worktree = join(sandbox, 'project-b');
    ensureClaudeTrust(worktree, { configPath: configPath() });
    const second = ensureClaudeTrust(worktree, { configPath: configPath() });
    expect(second.changed).toBe(false);
    expect(second.error).toBeUndefined();
  });

  it('only marks changed=true when one of the flags is missing', () => {
    const worktree = join(sandbox, 'project-c');
    writeFileSync(
      configPath(),
      JSON.stringify({
        projects: {
          [worktree]: { hasTrustDialogAccepted: true },
        },
      }),
      'utf8',
    );
    const first = ensureClaudeTrust(worktree, { configPath: configPath() });
    expect(first.changed).toBe(true);
    const second = ensureClaudeTrust(worktree, { configPath: configPath() });
    expect(second.changed).toBe(false);
  });

  it('preserves unrelated keys in the config file', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        theme: 'dark',
        editor: { fontSize: 14 },
        projects: {
          '/existing/project': {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            customKey: 'preserved',
          },
        },
      }),
      'utf8',
    );
    const worktree = join(sandbox, 'new-project');
    ensureClaudeTrust(worktree, { configPath: configPath() });
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as {
      theme: string;
      editor: { fontSize: number };
      projects: Record<string, Record<string, unknown>>;
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.editor.fontSize).toBe(14);
    expect(parsed.projects['/existing/project']?.customKey).toBe('preserved');
    expect(parsed.projects[worktree]?.hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project keys when adding trust flags', () => {
    const worktree = join(sandbox, 'project-d');
    writeFileSync(
      configPath(),
      JSON.stringify({
        projects: {
          [worktree]: { someOtherSetting: 'keep-me' },
        },
      }),
      'utf8',
    );
    ensureClaudeTrust(worktree, { configPath: configPath() });
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(parsed.projects[worktree]).toEqual({
      someOtherSetting: 'keep-me',
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('returns error (non-fatal) when config file is malformed JSON', () => {
    writeFileSync(configPath(), '{not json', 'utf8');
    let captured: Error | undefined;
    const result = ensureClaudeTrust(join(sandbox, 'p'), {
      configPath: configPath(),
      onError: (e) => {
        captured = e;
      },
    });
    expect(result.error).toBeDefined();
    expect(captured?.message).toBeDefined();
    expect(result.changed).toBe(false);
  });

  it('resolves relative worktree paths to absolute', () => {
    // Cannot easily change cwd in a test; instead confirm the output key is
    // absolute. path.resolve('relative') anchors at process.cwd() which will
    // always be absolute on any platform.
    const worktree = 'relative-path';
    ensureClaudeTrust(worktree, { configPath: configPath() });
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as {
      projects: Record<string, unknown>;
    };
    const keys = Object.keys(parsed.projects);
    expect(keys[0]?.startsWith('/') || /^[A-Za-z]:/.test(keys[0]!)).toBe(true);
  });

  it('atomically writes (no *.tmp files left behind on success)', () => {
    const worktree = join(sandbox, 'atomic');
    ensureClaudeTrust(worktree, { configPath: configPath() });
    const files = readdirSync(sandbox);
    expect(files.some((f) => f.includes('.tmp'))).toBe(false);
    expect(existsSync(configPath())).toBe(true);
  });
});
