import { z } from 'zod';
import {
  defaultStatusMap,
  type StatusClassification,
  type TaskFormat,
} from './parser.js';

/**
 * obsidian-source config (`<install-dir>/config.json`). Ported from the
 * in-tree `src/integrations/obsidian-config.ts`. No token — a vault is a
 * folder of markdown on the local disk. Defaults are baked in so the file can
 * be minimal (just `vaultPath`).
 */

const TaskFormatSchema = z.enum(['emoji', 'dataview', 'auto']);

const StatusImportSchema = z.record(
  z.string(),
  z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']),
);
const StatusTerminalSchema = z.record(z.string(), z.boolean());
const PriorityImportSchema = z.record(z.string(), z.number().int());

export const ObsidianSourceConfigSchema = z.object({
  /** Absolute path to the Obsidian vault root. */
  vaultPath: z.string().min(1),
  taskFormat: TaskFormatSchema.default('auto'),
  /** Frontmatter key carrying the project route, e.g. `project: symphony`. */
  projectProperty: z.string().min(1).default('project'),
  /** Path fragments to exclude (substring match, posix-normalized). */
  exclude: z.array(z.string()).default(['.trash/', '.obsidian/']),
  statusImport: StatusImportSchema.optional(),
  statusTerminal: StatusTerminalSchema.optional(),
  /**
   * Symphony terminal status → Obsidian writeback char. `completed` always
   * writes (default `x`); `failed` only when configured. `appendDoneDate`
   * adds the Tasks-plugin `✅ YYYY-MM-DD` stamp when completing.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).max(1).default('x'),
      failed: z.string().min(1).max(1).optional(),
      appendDoneDate: z.boolean().default(true),
    })
    .default({ completed: 'x', appendDoneDate: true }),
  priorityImport: PriorityImportSchema.default({
    highest: 3,
    high: 2,
    medium: 1,
    low: -1,
    lowest: -2,
  }),
});

export type ObsidianSourceConfig = z.infer<typeof ObsidianSourceConfigSchema>;

/**
 * Build the effective status-char → classification map: the parser's built-in
 * defaults with any per-char user overrides merged on top.
 */
export function resolveStatusMap(
  config: ObsidianSourceConfig,
): Record<string, StatusClassification> {
  const map = defaultStatusMap();
  if (config.statusImport !== undefined) {
    for (const [char, status] of Object.entries(config.statusImport)) {
      const terminal = config.statusTerminal?.[char] ?? map[char]?.terminal ?? false;
      map[char] = { status, terminal };
    }
  }
  if (config.statusTerminal !== undefined) {
    for (const [char, terminal] of Object.entries(config.statusTerminal)) {
      const status = map[char]?.status ?? 'pending';
      map[char] = { status, terminal };
    }
  }
  return map;
}

export type { TaskFormat };
