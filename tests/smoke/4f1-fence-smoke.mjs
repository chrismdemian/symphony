#!/usr/bin/env node
// Phase 4F.1 fence smoke — real Node subprocess against the BUILT
// `dist/droids/fence-hook.js` artifact, driven by the env layout
// Symphony actually writes onto worker spawns. Catches packaging
// regressions (tsup multi-entry, esbuild tree-shaking on fence.ts +
// minimatch, exit-code contract) independently of the vitest scenario.
//
// Run: `pnpm build && pnpm smoke:4f1`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const hook = path.join(repoRoot, 'dist', 'droids', 'fence-hook.js');

if (!existsSync(hook)) {
  console.error(
    `[smoke:4f1] missing ${hook}\n  Run \`pnpm build\` first (the built fence-hook is the production artifact this smoke validates).`,
  );
  process.exit(1);
}

const FENCE_ENV = 'SYMPHONY_DROID_FENCE';
const WT_ENV = 'SYMPHONY_DROID_WORKTREE';
const MARKER = '--symphony-droid-fence';

function runHook(env, stdin) {
  return new Promise((resolve) => {
    const child = spawn('node', [hook, MARKER], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

const wt = mkdtempSync(path.join(tmpdir(), 'sym-smoke-4f1-'));
const policyJson = JSON.stringify({
  allowed: ['Read', 'Grep', 'Glob', 'Write'],
  denied: ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit'],
  writePaths: ['DESIGN.md'],
});
const baseEnv = {
  ...process.env,
  [FENCE_ENV]: policyJson,
  [WT_ENV]: wt,
};

function payload(toolName, filePath) {
  return JSON.stringify({
    session_id: 's',
    transcript_path: '/x.jsonl',
    cwd: wt,
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: filePath !== undefined ? { file_path: filePath } : {},
    tool_use_id: 't1',
  });
}

const cases = [
  {
    name: 'allow: Read (in allowlist)',
    env: baseEnv,
    stdin: payload('Read', path.join(wt, 'README.md')),
    expectExit: 0,
  },
  {
    name: 'deny: Bash (in denylist)',
    env: baseEnv,
    stdin: payload('Bash'),
    expectExit: 2,
    expectStderrRe: /denied|not in this droid/i,
  },
  {
    name: 'allow: Write to DESIGN.md (in write_paths)',
    env: baseEnv,
    stdin: payload('Write', path.join(wt, 'DESIGN.md')),
    expectExit: 0,
  },
  {
    name: 'deny: Write to src/x.ts (not in write_paths)',
    env: baseEnv,
    stdin: payload('Write', path.join(wt, 'src', 'x.ts')),
    expectExit: 2,
    expectStderrRe: /write_paths/i,
  },
  {
    name: 'deny: Write outside the worktree',
    env: baseEnv,
    stdin: payload('Write', path.resolve('/etc/passwd')),
    expectExit: 2,
    expectStderrRe: /outside the worktree/i,
  },
  {
    name: 'fail-closed: malformed PreToolUse stdin',
    env: baseEnv,
    stdin: 'not json',
    expectExit: 2,
  },
  {
    name: 'fail-closed: unparseable policy env',
    env: { ...baseEnv, [FENCE_ENV]: '{ broken' },
    stdin: payload('Read', path.join(wt, 'README.md')),
    expectExit: 2,
  },
  // 4F.1 audit M3 — JSON.parse accepts `null`/`[]`/scalars but those
  // disarm the toStrArr extraction. The fence must REJECT any
  // parseable-but-wrong-shape policy env, not silently allow.
  {
    name: 'fail-closed: policy env is "null"',
    env: { ...baseEnv, [FENCE_ENV]: 'null' },
    stdin: payload('Bash'),
    expectExit: 2,
    expectStderrRe: /must be a JSON object/i,
  },
  {
    name: 'fail-closed: policy env is "[]" (array, not object)',
    env: { ...baseEnv, [FENCE_ENV]: '[]' },
    stdin: payload('Bash'),
    expectExit: 2,
    expectStderrRe: /must be a JSON object/i,
  },
  {
    name: 'fail-closed: policy env is a scalar "42"',
    env: { ...baseEnv, [FENCE_ENV]: '42' },
    stdin: payload('Bash'),
    expectExit: 2,
    expectStderrRe: /must be a JSON object/i,
  },
  // 4F.1 audit M1 — symlink-then-write must not slip past the fence.
  // Create an EXISTING symlink (junction on Win32) inside the worktree
  // pointing OUTSIDE; a Write to `<wt>/escape/x` is syntactically
  // inside-worktree but realpath of the parent follows the symlink.
  // Skip cleanly if the platform/permissions can't create the link.
  ...(() => {
    const escape = path.join(wt, 'escape');
    const outside = path.resolve(tmpdir(), 'sym-smoke-4f1-outside');
    try {
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return [];
    }
    return [
      {
        name: 'deny: Write through an in-worktree symlink to outside (M1)',
        env: baseEnv,
        stdin: payload('Write', path.join(escape, 'pwned.txt')),
        expectExit: 2,
        expectStderrRe: /outside the worktree/i,
      },
    ];
  })(),
  {
    name: 'pass-through: no policy env (not a fenced context)',
    env: (() => {
      const e = { ...process.env };
      delete e[FENCE_ENV];
      delete e[WT_ENV];
      return e;
    })(),
    stdin: payload('Bash'),
    expectExit: 0,
  },
];

let failures = 0;
for (const c of cases) {
  const r = await runHook(c.env, c.stdin);
  const exitOk = r.exitCode === c.expectExit;
  const stderrOk =
    c.expectStderrRe === undefined || c.expectStderrRe.test(r.stderr);
  const status = exitOk && stderrOk ? 'PASS' : 'FAIL';
  if (status === 'FAIL') {
    failures += 1;
    console.error(
      `[smoke:4f1] FAIL — ${c.name}\n  expected exit ${c.expectExit}, got ${r.exitCode}\n  stderr: ${r.stderr.trim()}`,
    );
  } else {
    console.log(`[smoke:4f1] PASS — ${c.name}`);
  }
}

try {
  rmSync(wt, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(
  `\n[smoke:4f1] ${cases.length - failures}/${cases.length} ${failures === 0 ? 'PASS' : 'FAIL'}`,
);
process.exit(failures === 0 ? 0 : 1);
