/**
 * Phase 4F.1 — PreToolUse fence hook ENTRY (separate tsup entry →
 * `dist/droids/fence-hook.js`; run via `node --import tsx <...>.ts` in
 * dev). Claude Code invokes this for every tool call in a fenced
 * droid's worktree, piping the PreToolUse JSON to stdin. The droid's
 * policy + worktree root arrive via env vars (set on the worker spawn,
 * exempted from the SYMPHONY_* env blocklist via `allowExtraEnvKeys`)
 * so the settings.local.json command stays static + free of any
 * shell-escaped JSON.
 *
 * Block contract (Claude Code `hooks.md`): EXIT 2 with the reason on
 * stderr — Claude Code feeds stderr back to the model and cancels the
 * tool call. Exit 0 ⇒ allowed. NEVER `|| true` (that converts the
 * blocking exit-2 into a no-op).
 *
 * Fail posture (deliberate, "full enforcement" decision —
 * `research/phase-reviews/4f1.md`):
 *   - policy env ABSENT  → exit 0 (the hook is only installed when a
 *     droid declares a policy; an absent policy means this is not a
 *     fenced context — never brick a worker over our own wiring).
 *   - policy env PRESENT but unparseable, or stdin unparseable →
 *     exit 2 (a fence that silently fails open is not a fence).
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DROID_FENCE_ENV,
  DROID_WORKTREE_ENV,
} from './hook-command.js';
import { evaluateFence, WRITE_TOOLS, type FencePolicy } from './fence.js';

interface PreToolUsePayload {
  readonly tool_name?: string;
  readonly tool_input?: {
    readonly file_path?: string;
    readonly notebook_path?: string;
  };
  readonly cwd?: string;
}

function block(reason: string): never {
  // Synchronous fd-2 write: `process.stderr.write` to a pipe is async
  // and `process.exit(2)` can truncate it — the model would then see a
  // blocked tool with no reason. `fs.writeSync` guarantees the flush.
  fs.writeSync(2, reason.endsWith('\n') ? reason : `${reason}\n`);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const policyRaw = process.env[DROID_FENCE_ENV];
  if (policyRaw === undefined || policyRaw.trim().length === 0) {
    // Not a fenced context — allow (hook should not have been installed).
    allow();
  }

  let parsedPolicy: unknown;
  try {
    parsedPolicy = JSON.parse(policyRaw as string);
  } catch (err) {
    block(
      `Symphony droid fence: malformed ${DROID_FENCE_ENV} env (${
        err instanceof Error ? err.message : String(err)
      }) — blocking to fail safe.`,
    );
  }
  // 4F.1 audit M3 — JSON.parse accepts `null`, `[]`, scalars, all of
  // which would silently disarm the toStrArr-based extraction
  // (resulting in {allowed: [], denied: [], writePaths: []} — i.e. no
  // enforcement). Validate the shape before extracting.
  if (
    typeof parsedPolicy !== 'object' ||
    parsedPolicy === null ||
    Array.isArray(parsedPolicy)
  ) {
    block(
      `Symphony droid fence: ${DROID_FENCE_ENV} must be a JSON object ` +
        `({allowed, denied, writePaths}); got ${
          parsedPolicy === null ? 'null' : Array.isArray(parsedPolicy) ? 'array' : typeof parsedPolicy
        } — blocking to fail safe.`,
    );
  }
  const policyObj = parsedPolicy as {
    allowed?: unknown;
    denied?: unknown;
    writePaths?: unknown;
  };

  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  // 4F.1 audit M1 — realpath the worktree root so the worktree-
  // containment check below isn't fooled by a symlink in the worktree
  // path itself (e.g. /home/chris symlinked elsewhere).
  const worktreeRootRaw = process.env[DROID_WORKTREE_ENV] ?? '';
  let worktreeRoot = worktreeRootRaw;
  if (worktreeRootRaw.length > 0) {
    try {
      worktreeRoot = fs.realpathSync(worktreeRootRaw);
    } catch {
      /* fall back to raw — fence still blocks any path that escapes */
    }
  }
  const policy: FencePolicy = {
    allowed: toStrArr(policyObj.allowed),
    denied: toStrArr(policyObj.denied),
    writePaths: toStrArr(policyObj.writePaths),
    worktreeRoot,
  };

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    block(
      `Symphony droid fence: could not read PreToolUse payload (${
        err instanceof Error ? err.message : String(err)
      }) — blocking to fail safe.`,
    );
  }

  let payload: PreToolUsePayload;
  try {
    payload = JSON.parse(raw) as PreToolUsePayload;
  } catch (err) {
    block(
      `Symphony droid fence: unparseable PreToolUse JSON (${
        err instanceof Error ? err.message : String(err)
      }) — blocking to fail safe.`,
    );
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (toolName.length === 0) {
    block('Symphony droid fence: PreToolUse payload missing tool_name — blocking to fail safe.');
  }

  let filePath: string | undefined;
  if (WRITE_TOOLS.has(toolName)) {
    const ti = payload.tool_input ?? {};
    const target = ti.file_path ?? ti.notebook_path;
    if (typeof target === 'string' && target.length > 0) {
      // Claude Code normally passes an absolute file_path; resolve a
      // relative one against the payload cwd (the worktree) so the
      // fence's worktree-containment check is accurate.
      const abs = path.isAbsolute(target)
        ? target
        : path.resolve(payload.cwd ?? process.cwd(), target);
      // 4F.1 audit M1 — when the parent dir EXISTS, realpath it so a
      // symlink (e.g. a bash-allowed droid does `ln -s /etc x` then
      // `Write x/passwd`) doesn't slip a syntactically-inside path
      // past the worktree-containment gate. When the parent does NOT
      // exist, there is no symlink to follow — use the syntactic abs
      // path and let `evaluateFence`'s `path.relative` check do its
      // standard job. Exploiting the symlink path requires creating
      // the symlink first (Bash, which is gated by the tool allow/
      // deny lists), so this is layered defense over the tool gate.
      try {
        const parentReal = fs.realpathSync(path.dirname(abs));
        filePath = path.join(parentReal, path.basename(abs));
      } catch {
        filePath = abs;
      }
    }
  }

  const decision = evaluateFence({ toolName, ...(filePath !== undefined ? { filePath } : {}) }, policy);
  if (decision.allow) allow();
  block(decision.reason ?? 'Symphony droid fence: denied.');
}

main().catch((err) => {
  // Any unexpected failure once a policy is in play fails CLOSED.
  block(
    `Symphony droid fence: internal error (${
      err instanceof Error ? err.message : String(err)
    }) — blocking to fail safe.`,
  );
});
