import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { detectUiStack } from '../../projects/ui-stack.js';
import type { ProjectStore, ProjectRecord } from '../../projects/types.js';
import { killTree } from '../finalize-runner.js';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry, WorkerRecord } from '../worker-registry.js';

/**
 * Phase 4G.2 — `verify_ui` MCP tool.
 *
 * For UI projects with a `previewCommand` set, boot the preview server in
 * the worker's worktree, wait for it to be ready, capture desktop +
 * mobile screenshots via programmatic Playwright, then tear the server
 * down. Returns the screenshot paths so Maestro can spawn a fresh
 * REVIEWER worker with the paths in the task brief — the reviewer uses
 * Claude's image-capable `Read` tool to grade the screenshots.
 *
 * The verifier owns boot + capture + teardown; the GRADING happens in a
 * separate spawned worker (rule: reviewer ≠ writer). The CLAUDE.md
 * skeptical-reviewer framing rides in the Maestro task brief, not in
 * this tool.
 *
 * Symphony-owned wrapping (NOT a thin shim around `@playwright/mcp`)
 * means the dispatch shim's audit log, AgentSafetyGuard, and tier
 * gating all cover every verify_ui call uniformly.
 */

/** Default boot-wait cap. Overridable per-call (`timeout_ms`) and per-project (`previewTimeoutMs`). */
const DEFAULT_PREVIEW_TIMEOUT_MS = 30_000;

/**
 * Stdout regex that catches `http://localhost:5173/` and friends. The
 * path character class explicitly excludes the ANSI escape byte
 * (`\x1b`) so a banner like `\x1b[36mhttp://localhost:5173/\x1b[0m` (vite,
 * next, svelte, etc.) doesn't capture the trailing escape sequence as
 * part of the URL — Playwright rejects URLs containing control bytes.
 *
 * Audit-fix M1 (Phase 4G.2 review): an earlier regex `[^\s]*` let the
 * trailing `\x1b[0m` leak into `previewUrl`, breaking `page.goto` on
 * every real-world dev server.
 */
// eslint-disable-next-line no-control-regex
const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s\x1b]*)?/;

/**
 * Pre-strip ANSI from captured stdout BEFORE the URL regex runs.
 * Defense-in-depth alongside the regex's escape-byte exclusion (some
 * shells emit cursor-positioning sequences that include `:` characters
 * which could still collide if a future regex change loosened the class).
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[\d;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

/** Desktop + mobile viewports per CLAUDE.md (Playwright MCP standard). */
const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
} as const;

export type Viewport = keyof typeof VIEWPORTS;

export interface VerifyUiResult {
  readonly workerId: string;
  readonly previewUrl: string;
  readonly screenshotPaths: Partial<Record<Viewport, string>>;
  readonly capturedAt: string;
}

export type VerifyUiOutcome =
  | { readonly ok: true; readonly result: VerifyUiResult }
  | { readonly ok: false; readonly message: string; readonly code: VerifyUiErrorCode };

export type VerifyUiErrorCode =
  | 'unknown-worker'
  | 'no-preview-command'
  | 'no-ui-stack'
  | 'boot-timeout'
  | 'aborted'
  | 'playwright-missing'
  | 'screenshot-failed';

export interface VerifyUiDeps {
  readonly registry: WorkerRegistry;
  readonly projectStore: ProjectStore;
  /**
   * Override for tests — supply a fake preview launcher / screenshotter.
   * Production wires `defaultPreviewLauncher` + `defaultScreenshotter`.
   */
  readonly previewLauncher?: PreviewLauncher;
  readonly screenshotter?: Screenshotter;
  /** Override for tests; production uses `Date`. */
  readonly now?: () => Date;
}

export interface RunVerifyUiInput {
  readonly workerId: string;
  readonly timeoutMs?: number;
  readonly viewports?: readonly Viewport[];
  readonly signal?: AbortSignal;
}

/**
 * Long-running preview process handle. The launcher boots the command,
 * resolves with the URL once stdout matches `URL_REGEX` (or once a
 * fallback HTTP probe succeeds on a `FALLBACK_PORTS` candidate), and
 * keeps the child alive for the caller to use.
 */
export interface PreviewHandle {
  readonly url: string;
  readonly child: ChildProcess;
}

export interface PreviewLauncherInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

export type PreviewLauncher = (input: PreviewLauncherInput) => Promise<PreviewHandle>;

export interface ScreenshotterInput {
  readonly url: string;
  readonly outputPath: string;
  readonly viewport: { width: number; height: number };
  readonly signal: AbortSignal | undefined;
}

export type Screenshotter = (input: ScreenshotterInput) => Promise<void>;

/**
 * Core verifier — used directly by the MCP tool wrapper below. Extracted
 * so unit tests can drive the loop without going through the dispatch
 * shim. The dispatch shim handles audit logging + tier gating
 * uniformly via `wrapToolHandler`.
 */
export async function runVerifyUi(
  deps: VerifyUiDeps,
  input: RunVerifyUiInput,
): Promise<VerifyUiOutcome> {
  if (isAborted(input.signal)) {
    return { ok: false, message: 'aborted before start.', code: 'aborted' };
  }

  const record = deps.registry.get(input.workerId);
  if (!record) {
    return {
      ok: false,
      message: `Unknown worker '${input.workerId}'.`,
      code: 'unknown-worker',
    };
  }

  const project = resolveProjectForWorker(deps.projectStore, record);
  if (project?.previewCommand === undefined || project.previewCommand.trim().length === 0) {
    return {
      ok: false,
      message: `Project '${project?.name ?? '(unregistered)'}' has no \`previewCommand\` configured. Set one in the project record before calling verify_ui.`,
      code: 'no-preview-command',
    };
  }

  // 4F.3's UI-stack detection — guard against verify_ui on a Python/Go
  // project that happens to have a previewCommand. Cheap, safe.
  const stack = await detectUiStack(record.projectPath);
  if (!stack.hasUiStack) {
    return {
      ok: false,
      message: `Project '${project.name}' does not declare a known UI stack in package.json. verify_ui is only meaningful for UI projects (React, Vue, Svelte, Next, Tailwind, etc.).`,
      code: 'no-ui-stack',
    };
  }

  const launcher = deps.previewLauncher ?? defaultPreviewLauncher;
  const screenshotter = deps.screenshotter ?? defaultScreenshotter;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? project.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
  const viewports = input.viewports ?? (['desktop', 'mobile'] as const);

  let preview: PreviewHandle | undefined;
  try {
    preview = await launcher({
      command: project.previewCommand,
      cwd: record.worktreePath,
      timeoutMs,
      signal: input.signal,
    });
  } catch (err) {
    if (err instanceof PreviewBootError) {
      return { ok: false, message: err.message, code: err.code };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `preview boot failed: ${msg}`, code: 'boot-timeout' };
  }

  // From here on, ANY exit path must `killTree(preview.child)` so the
  // worker's preview server doesn't outlive Symphony. Belt-and-suspenders
  // via try/finally.
  const capturedAt = now().toISOString();
  // Replace `:` in the timestamp (Win32 reserves `:` in filenames) so the
  // screenshot dir is valid across platforms.
  const stamp = capturedAt.replace(/[:.]/g, '-');
  const screenshotDir = path.join(record.worktreePath, '.symphony', 'screenshots', stamp);
  const paths: Partial<Record<Viewport, string>> = {};
  try {
    await fsp.mkdir(screenshotDir, { recursive: true });
    for (const viewport of viewports) {
      if (isAborted(input.signal)) {
        return { ok: false, message: 'aborted mid-capture.', code: 'aborted' };
      }
      const outputPath = path.join(screenshotDir, `${viewport}.png`);
      try {
        await screenshotter({
          url: preview.url,
          outputPath,
          viewport: VIEWPORTS[viewport],
          signal: input.signal,
        });
        paths[viewport] = outputPath;
      } catch (err) {
        if (err instanceof PlaywrightMissingError) {
          return { ok: false, message: err.message, code: 'playwright-missing' };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          message: `screenshot failed for viewport '${viewport}': ${msg}`,
          code: 'screenshot-failed',
        };
      }
    }
  } finally {
    killTree(preview.child);
  }

  return {
    ok: true,
    result: {
      workerId: record.id,
      previewUrl: preview.url,
      screenshotPaths: paths,
      capturedAt,
    },
  };
}

function resolveProjectForWorker(
  store: ProjectStore,
  record: WorkerRecord,
): Pick<ProjectRecord, 'name' | 'path' | 'previewCommand' | 'previewTimeoutMs'> | undefined {
  const resolved = path.resolve(record.projectPath);
  if (record.projectId !== null) {
    const byId = store.get(record.projectId);
    if (byId !== undefined) return byId;
  }
  for (const candidate of store.list()) {
    if (path.resolve(candidate.path) === resolved) return candidate;
  }
  return undefined;
}

/**
 * Production preview launcher — spawn the command in the worker's
 * worktree, capture stdout, watch for a URL match OR fall back to an
 * HTTP probe of `FALLBACK_PORTS`. Resolves with the running handle so
 * the caller can use it then `killTree` on teardown.
 */
export const defaultPreviewLauncher: PreviewLauncher = async (input) => {
  if (isAborted(input.signal)) {
    throw new PreviewBootError('aborted before boot', 'aborted');
  }
  const spawnOptions: SpawnOptions = {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
  const child = spawn(input.command, [], spawnOptions);
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.length > 16_384) stdout = stdout.slice(-16_384);
  });
  // We deliberately ignore stderr for URL detection (vite/next print
  // their banner on stdout); the killTree teardown handles cleanup.
  child.stderr?.on('data', () => {});

  const start = Date.now();
  const deadline = start + input.timeoutMs;

  // Abort + early-exit watchers — fail the boot promise if the child
  // dies before we see a URL. m2 (Phase 4G.2 audit): also listen on
  // 'error' so a post-spawn ENOENT/EPERM/EMFILE doesn't crash Symphony
  // — fold it into the exit-class so the boot promise throws cleanly.
  let exited = false;
  let exitInfo: { code: number | null; sig: NodeJS.Signals | null } | undefined;
  let errorMessage: string | undefined;
  child.once('exit', (code, sig) => {
    exited = true;
    exitInfo = { code, sig };
  });
  child.once('error', (err) => {
    exited = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  });

  try {
    while (Date.now() < deadline) {
      if (isAborted(input.signal)) {
        throw new PreviewBootError('aborted during boot', 'aborted');
      }
      if (exited) {
        const reason = errorMessage
          ? `spawn error: ${errorMessage}`
          : exitInfo
            ? `exit code ${exitInfo.code ?? 'null'} (signal ${exitInfo.sig ?? 'null'})`
            : 'unexpected exit';
        throw new PreviewBootError(
          `preview command exited before emitting a URL — ${reason}. Stdout tail: ${stdout.slice(-512) || '(empty)'}`,
          'boot-timeout',
        );
      }
      // Audit-fix M1: strip ANSI BEFORE running the regex so vite/next/
      // svelte/etc. banners don't capture trailing escape sequences.
      const clean = stripAnsi(stdout);
      const match = clean.match(URL_REGEX);
      if (match) {
        return { url: normalizeUrl(match[0]), child };
      }
      // Audit-fix M2: NO fallback port probe. An ambient dev server on
      // 3000/5173/etc. would be claimed as "the worker's preview" before
      // the worker's actual preview boots — deterministic collision in
      // Symphony's parallel-orchestration model. Preview commands MUST
      // emit a URL on stdout; the boot-timeout error message tells the
      // USER what to do if their command stays silent.
      await sleep(250).catch(() => {});
    }
    throw new PreviewBootError(
      `preview command did not emit a URL within ${input.timeoutMs}ms. Increase \`previewTimeoutMs\` or check that the command prints its URL to stdout (e.g. \`Local: http://localhost:5173/\`). Stdout tail: ${stripAnsi(stdout).slice(-512) || '(empty)'}`,
      'boot-timeout',
    );
  } catch (err) {
    killTree(child);
    throw err;
  }
};

function normalizeUrl(raw: string): string {
  // Strip trailing punctuation common in banners ("ready at http://localhost:5173/.")
  return raw.replace(/[)\]>,.;:]+$/u, '');
}

/**
 * Wrap `signal?.aborted` so TypeScript's control-flow narrowing doesn't
 * eagerly conclude that a second check after an early-return path is
 * unreachable. The signal IS a runtime side-effect; the flag can flip
 * mid-call (Maestro cancelling the dispatch, USER pressing Esc).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

class PreviewBootError extends Error {
  constructor(
    message: string,
    public readonly code: 'boot-timeout' | 'aborted',
  ) {
    super(message);
    this.name = 'PreviewBootError';
  }
}

/**
 * Production screenshotter — dynamic-imports `playwright` so the
 * chromium dep isn't loaded at module-init time. First-run failure
 * (chromium not downloaded) is surfaced with an actionable message.
 */
export const defaultScreenshotter: Screenshotter = async (input) => {
  let chromium;
  try {
    const playwright = await import('playwright');
    chromium = playwright.chromium;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PlaywrightMissingError(
      `Could not load the \`playwright\` package: ${msg}. Run \`pnpm add playwright\` (already a runtime dep) and \`npx playwright install chromium\` if this is the first run.`,
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/.test(msg)) {
      throw new PlaywrightMissingError(
        `Chromium is not installed. Run \`npx playwright install chromium\` then re-run \`verify_ui\`.`,
      );
    }
    throw err;
  }

  try {
    const context = await browser.newContext({ viewport: input.viewport });
    const page = await context.newPage();
    // 10s navigation budget — slow dev servers need this. AbortSignal
    // tear-down is handled by `browser.close()` in the finally branch.
    await page.goto(input.url, { waitUntil: 'load', timeout: 10_000 });
    await page.screenshot({ path: input.outputPath, fullPage: false });
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
};

/**
 * Thrown by `Screenshotter` implementations when the `playwright` package
 * or its chromium executable isn't available. `runVerifyUi` catches this
 * specifically and returns the `playwright-missing` error code so Maestro
 * can surface an actionable message rather than treating it as a UI
 * defect.
 */
export class PlaywrightMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaywrightMissingError';
  }
}

// ---------------------------------------------------------------------------
// MCP tool wrapper
// ---------------------------------------------------------------------------

const VIEWPORT_VALUES = ['desktop', 'mobile'] as const;

const shape = {
  worker_id: z
    .string()
    .min(1)
    .describe('Worker id whose preview should be screenshotted.'),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .optional()
    .describe(
      `Boot-wait cap in ms (preview command must emit a URL within this window). Default ${DEFAULT_PREVIEW_TIMEOUT_MS}.`,
    ),
  viewports: z
    .array(z.enum(VIEWPORT_VALUES))
    .min(1)
    .optional()
    .describe(`Viewports to capture. Default: both ('desktop' 1280x720 + 'mobile' 390x844).`),
};

export function makeVerifyUiTool(
  deps: VerifyUiDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'verify_ui',
    description:
      "Boot the worker's preview server, capture desktop + mobile screenshots, then tear it down. Returns paths to PNG files in `<worktree>/.symphony/screenshots/<iso>/`. Use AFTER `audit_changes` PASS on UI projects, BEFORE finalize — then spawn a fresh REVIEWER worker with the paths in its task brief so it can grade the visuals via its `Read` tool. Refuses with a structured error when the project has no `previewCommand` or no UI stack. act-mode only.",
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ worker_id, timeout_ms, viewports }, ctx) => {
      const outcome = await runVerifyUi(deps, {
        workerId: worker_id,
        ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
        ...(viewports !== undefined ? { viewports } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: `verify_ui failed: ${outcome.message}` }],
          structuredContent: {
            ok: false,
            code: outcome.code,
            worker_id,
          },
          isError: true,
        };
      }
      const r = outcome.result;
      const lines = [
        `verify_ui PASS`,
        `worker: ${r.workerId}`,
        `preview: ${r.previewUrl}`,
        `captured_at: ${r.capturedAt}`,
        `screenshots:`,
        ...Object.entries(r.screenshotPaths).map(
          ([v, p]) => `  - ${v}: ${p}`,
        ),
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          worker_id: r.workerId,
          preview_url: r.previewUrl,
          screenshot_paths: r.screenshotPaths as Record<string, string>,
          captured_at: r.capturedAt,
        },
      };
    },
  };
}
