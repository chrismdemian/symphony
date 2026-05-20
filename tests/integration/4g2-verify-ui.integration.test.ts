/**
 * Phase 4G.2 — `verify_ui` integration test against a real HTTP preview
 * server + real Playwright (when chromium is installed).
 *
 * The preview command is a tiny `node -e "..."` one-liner that serves a
 * static HTML page and prints its URL — exactly the shape `verify_ui`'s
 * URL-regex boot detection expects. We register the worktree as a
 * project with that preview command, call `verify_ui`, and assert:
 *   - the response is `ok: true`
 *   - both screenshot files exist on disk
 *
 * Skips the Playwright leg with `console.warn` when chromium isn't
 * available so CI without `npx playwright install` doesn't hard-fail
 * the entire branch. The hermetic unit tests cover all error paths
 * regardless.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVerifyUi } from '../../src/orchestrator/tools/verify-ui.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

function stubWorker(): Worker {
  return {
    id: 'wk',
    sessionId: undefined,
    status: 'completed',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

function registerWorker(
  reg: WorkerRegistry,
  id: string,
  projectPath: string,
  worktreePath: string,
): WorkerRecord {
  const record: WorkerRecord = {
    id,
    projectPath,
    projectId: 'p1',
    taskId: null,
    worktreePath,
    role: 'implementer',
    featureIntent: 'ship-ui',
    taskDescription: 'ship the landing page',
    autonomyTier: 2,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    auditAttempts: 0,
    detach: () => {},
  };
  reg.register(record);
  return record;
}

/**
 * Inline Node preview server. Listens on an OS-assigned port and prints
 * the URL to stdout in a shape the URL regex catches. Stays alive until
 * killed.
 */
const PREVIEW_SCRIPT = `
const http = require('http');
const html = '<!doctype html><html><head><meta charset="utf-8"><title>preview</title></head><body><h1>hello from preview</h1></body></html>';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  console.log('Local:   http://localhost:' + port + '/');
});
process.on('SIGTERM', () => srv.close());
process.on('SIGINT', () => srv.close());
`.trim();

function previewCommand(): string {
  // Avoid newlines inside `-e` — collapse to a single line so cmd.exe
  // doesn't truncate at the first `\n`.
  const oneLine = PREVIEW_SCRIPT.replace(/\n/g, ' ');
  // Quote the script for cmd.exe vs sh — `shell: true` means we just
  // build ONE shell string. Use single quotes on POSIX, escaped double
  // quotes on Win32.
  if (process.platform === 'win32') {
    return `node -e "${oneLine.replace(/"/g, '\\"')}"`;
  }
  return `node -e '${oneLine}'`;
}

async function isChromiumInstalled(): Promise<boolean> {
  try {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

let workdir: string;
let projectStore: ProjectRegistry;
let registry: WorkerRegistry;

beforeEach(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sym-4g2-int-'));
  // Seed package.json with React so detectUiStack passes.
  await fsp.writeFile(
    path.join(workdir, 'package.json'),
    JSON.stringify({ dependencies: { react: '18.0.0' } }),
    'utf8',
  );
  projectStore = new ProjectRegistry();
  projectStore.register({
    id: 'p1',
    name: 'preview-int',
    path: workdir,
    createdAt: '2026-05-20T00:00:00.000Z',
    previewCommand: previewCommand(),
    previewTimeoutMs: 15_000,
  });
  registry = new WorkerRegistry();
  registerWorker(registry, 'wk-int', workdir, workdir);
});

afterEach(async () => {
  await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {});
});

describe('Phase 4G.2 — verify_ui end-to-end against a real preview server', () => {
  it('boots the preview, screenshots desktop + mobile, tears the server down', async () => {
    const chromiumOk = await isChromiumInstalled();
    if (!chromiumOk) {
      // First-run UX is documented; CI must run `npx playwright install
      // chromium` for this leg. Log a warning so the gap is visible.
      console.warn(
        '[4g2 integration] Skipping Playwright leg — chromium is not installed. Run `npx playwright install chromium` to enable.',
      );
      return;
    }

    const outcome = await runVerifyUi(
      { registry, projectStore },
      { workerId: 'wk-int' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.result.previewUrl).toMatch(
      /^http:\/\/(?:localhost|127\.0\.0\.1):\d+/,
    );
    expect(outcome.result.screenshotPaths.desktop).toBeDefined();
    expect(outcome.result.screenshotPaths.mobile).toBeDefined();
    const desktopPath = outcome.result.screenshotPaths.desktop!;
    const mobilePath = outcome.result.screenshotPaths.mobile!;
    await expect(fsp.access(desktopPath)).resolves.toBeUndefined();
    await expect(fsp.access(mobilePath)).resolves.toBeUndefined();
    // Sanity — files are non-trivial (PNG header is 8 bytes).
    const desktopStat = await fsp.stat(desktopPath);
    const mobileStat = await fsp.stat(mobilePath);
    expect(desktopStat.size).toBeGreaterThan(100);
    expect(mobileStat.size).toBeGreaterThan(100);
  }, 60_000);
});
