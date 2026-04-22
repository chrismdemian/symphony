import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface EnsureClaudeTrustOptions {
  /** Override ~/.claude.json for testing. */
  configPath?: string;
  /** Override home dir detection (used when configPath not set). */
  home?: string;
  /** Swallow+report errors instead of logging via console.warn. */
  onError?: (err: Error) => void;
}

export interface EnsureClaudeTrustResult {
  /** The path written (or would have been written). */
  configPath: string;
  /** True if the file was modified; false if already trusted. */
  changed: boolean;
  /** True if an error occurred — handler was called, caller should proceed. */
  error?: Error;
}

interface ClaudeConfigShape {
  projects?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export function ensureClaudeTrust(
  worktreePath: string,
  options: EnsureClaudeTrustOptions = {},
): EnsureClaudeTrustResult {
  const configPath = options.configPath ?? join(options.home ?? homedir(), '.claude.json');
  const resolvedPath = resolve(worktreePath);

  try {
    let config: ClaudeConfigShape = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) config = parsed as ClaudeConfigShape;
    }

    if (!isObject(config.projects)) {
      config.projects = {};
    }

    const projects = config.projects;
    const existing = isObject(projects[resolvedPath]) ? projects[resolvedPath] : undefined;
    if (
      existing !== undefined &&
      existing.hasTrustDialogAccepted === true &&
      existing.hasCompletedProjectOnboarding === true
    ) {
      return { configPath, changed: false };
    }

    projects[resolvedPath] = {
      ...(existing ?? {}),
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };

    const tmpPath = `${configPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
      renameSync(tmpPath, configPath);
    } catch (writeErr) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort
      }
      throw writeErr;
    }

    return { configPath, changed: true };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    if (options.onError) {
      options.onError(normalized);
    } else {
      console.warn(`ensureClaudeTrust: ${normalized.message} (path=${worktreePath})`);
    }
    return { configPath, changed: false, error: normalized };
  }
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
