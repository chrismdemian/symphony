import path from 'node:path';

import {
  assertSafeDroidName,
  DROID_TOOL_ALIASES,
  DROID_TOOL_TOKENS,
  DroidParseError,
  type DroidDefinition,
  type DroidToolToken,
} from './types.js';

/**
 * Phase 4F.1 — strict droid-file parser.
 *
 * Droid files use YAML-ish frontmatter, but Symphony has no YAML
 * dependency and a tool-permission gate is the wrong place to introduce
 * a broad parser + supply-chain surface. The frontmatter schema is tiny
 * and closed (`name`, `model`, `tools_allowed`, `tools_denied`,
 * `write_paths`), so this hand-rolls a STRICT parser over exactly that
 * shape — matching the codebase's "hand-roll the constrained detector,
 * reject the dependency" posture (3F.4 highlighter, 4A/4D prompt
 * extraction). Strictness is deliberate: an unrecognized key or token
 * is an ERROR, never silently ignored — a typo'd `tools_denied` that
 * quietly enforces nothing is a security footgun.
 *
 * Supported value forms:
 *   key: scalar                      # bare / "double" / 'single' quoted
 *   key: [a, b, c]                   # inline list
 *   key:                             # block list
 *     - a
 *     - b
 *
 * Full-line `#` comments and blank lines inside the frontmatter are
 * ignored. CRLF tolerated (Windows authoring). A leading BOM is
 * stripped (1A/4A gotcha parity).
 */

const FRONTMATTER_KEYS = [
  'name',
  'model',
  'tools_allowed',
  'tools_denied',
  'write_paths',
] as const;

const FRONTMATTER_KEY_SET = new Set<string>(FRONTMATTER_KEYS);

export interface ParseDroidOptions {
  /**
   * When set, the frontmatter `name` MUST equal this (the filename stem
   * for project-scoped droids — PLAN.md `<project>/.symphony/droids/<name>.md`).
   * Prevents a `dhh-reviewer.md` whose frontmatter says `name: foo`,
   * which would make `spawn_worker({role})` ambiguous.
   */
  readonly expectedName?: string;
}

/** Parse + validate one droid file's raw text. Throws {@link DroidParseError}. */
export function parseDroidFile(
  raw: string,
  source: string,
  options: ParseDroidOptions = {},
): DroidDefinition {
  // Strip a leading UTF-8 BOM. Written as the six-char regex escape
  // \uFEFF, NOT a literal BOM byte — a literal trips ESLint
  // no-irregular-whitespace (known gotcha 2A.4b).
  const text = raw.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);

  // Frontmatter MUST open on the first non-empty line with a bare `---`.
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i += 1;
  if (i >= lines.length || lines[i]!.trim() !== '---') {
    throw new DroidParseError(
      'droid file must begin with a `---` frontmatter fence',
      source,
    );
  }
  i += 1;

  // Collect frontmatter lines up to the closing `---`.
  const fmLines: string[] = [];
  let closed = false;
  for (; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      closed = true;
      i += 1;
      break;
    }
    fmLines.push(lines[i]!);
  }
  if (!closed) {
    throw new DroidParseError(
      'unterminated frontmatter — missing closing `---` fence',
      source,
    );
  }

  const body = lines
    .slice(i)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  if (body.trim().length === 0) {
    throw new DroidParseError(
      'droid body is empty — the markdown after the frontmatter is the role prompt',
      source,
    );
  }

  const fields = parseFrontmatter(fmLines, source);

  const rawName = fields['name'];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw new DroidParseError("missing required frontmatter field 'name'", source);
  }
  let name: string;
  try {
    name = assertSafeDroidName(rawName);
  } catch (err) {
    throw new DroidParseError(
      err instanceof Error ? err.message : String(err),
      source,
    );
  }
  if (options.expectedName !== undefined && name !== options.expectedName) {
    throw new DroidParseError(
      `frontmatter name '${name}' does not match expected '${options.expectedName}' ` +
        '(a project droid file must be named <name>.md)',
      source,
    );
  }

  const model =
    typeof fields['model'] === 'string'
      ? (fields['model'] as string).trim()
      : undefined;
  if (fields['model'] !== undefined && (model === undefined || model.length === 0)) {
    throw new DroidParseError("frontmatter 'model' must be a non-empty string", source);
  }

  const toolsAllowed = parseToolList(fields['tools_allowed'], 'tools_allowed', source);
  const toolsDenied = parseToolList(fields['tools_denied'], 'tools_denied', source);
  if ((toolsAllowed?.length ?? 0) + (toolsDenied?.length ?? 0) === 0) {
    throw new DroidParseError(
      "a droid must declare a tool policy: at least one of 'tools_allowed' or " +
        "'tools_denied' must be present and non-empty (a droid with no enforced " +
        'policy is almost certainly a mistake — declare the tools it may use).',
      source,
    );
  }

  const writePaths = parseWritePaths(fields['write_paths'], source);

  const def: DroidDefinition = {
    name,
    body,
    source,
    ...(model !== undefined ? { model } : {}),
    ...(toolsAllowed !== undefined ? { toolsAllowed } : {}),
    ...(toolsDenied !== undefined ? { toolsDenied } : {}),
    ...(writePaths !== undefined ? { writePaths } : {}),
  };
  return def;
}

type RawField = string | string[];

function parseFrontmatter(
  fmLines: readonly string[],
  source: string,
): Record<string, RawField> {
  const fields: Record<string, RawField> = {};
  for (let idx = 0; idx < fmLines.length; idx += 1) {
    const line = fmLines[idx]!;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // Block-list continuation lines (`  - item`) are consumed by the
    // owning key below; a stray one here is a structure error.
    if (trimmed.startsWith('- ') || trimmed === '-') {
      throw new DroidParseError(
        `unexpected list item '${trimmed}' with no owning key`,
        source,
      );
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      throw new DroidParseError(
        `malformed frontmatter line (expected 'key: value'): ${line}`,
        source,
      );
    }
    const key = line.slice(0, colon).trim();
    if (!FRONTMATTER_KEY_SET.has(key)) {
      throw new DroidParseError(
        `unknown frontmatter key '${key}' — allowed: ${FRONTMATTER_KEYS.join(', ')}`,
        source,
      );
    }
    if (key in fields) {
      throw new DroidParseError(`duplicate frontmatter key '${key}'`, source);
    }
    const inlineRaw = line.slice(colon + 1).trim();
    if (inlineRaw.length === 0) {
      // Block list: gather following `  - item` lines.
      const items: string[] = [];
      let j = idx + 1;
      for (; j < fmLines.length; j += 1) {
        const next = fmLines[j]!;
        const nt = next.trim();
        if (nt.length === 0 || nt.startsWith('#')) continue;
        if (!nt.startsWith('- ') && nt !== '-') break;
        const item = nt === '-' ? '' : stripScalar(nt.slice(2).trim());
        if (item.length === 0) {
          throw new DroidParseError(`empty list item under '${key}'`, source);
        }
        items.push(item);
      }
      fields[key] = items;
      idx = j - 1;
      continue;
    }
    if (inlineRaw.startsWith('[')) {
      fields[key] = parseInlineList(inlineRaw, key, source);
      continue;
    }
    fields[key] = stripScalar(stripComment(inlineRaw));
  }
  return fields;
}

/** Strip a trailing ` # comment` from an unquoted scalar. */
function stripComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith('[')) {
    return value;
  }
  const hash = value.indexOf(' #');
  return hash >= 0 ? value.slice(0, hash).trim() : value;
}

/** Unwrap `"x"` / `'x'`; bare values pass through trimmed. */
function stripScalar(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseInlineList(raw: string, key: string, source: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new DroidParseError(`malformed inline list for '${key}': ${raw}`, source);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((part) => {
    const item = stripScalar(part.trim());
    if (item.length === 0) {
      throw new DroidParseError(`empty list item in '${key}'`, source);
    }
    return item;
  });
}

function parseToolList(
  value: RawField | undefined,
  key: string,
  source: string,
): readonly DroidToolToken[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DroidParseError(
      `'${key}' must be a list (e.g. [read, grep] or a block list)`,
      source,
    );
  }
  const out: DroidToolToken[] = [];
  for (const raw of value) {
    const tok = raw.toLowerCase();
    if (!(tok in DROID_TOOL_ALIASES)) {
      throw new DroidParseError(
        `unknown tool token '${raw}' in '${key}' — allowed: ${DROID_TOOL_TOKENS.join(
          ', ',
        )}`,
        source,
      );
    }
    const known = tok as DroidToolToken;
    if (!out.includes(known)) out.push(known);
  }
  return out;
}

function parseWritePaths(
  value: RawField | undefined,
  source: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DroidParseError(
      "'write_paths' must be a list (e.g. [\"DESIGN.md\"])",
      source,
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    const p = entry.trim();
    if (p.length === 0) {
      throw new DroidParseError("empty entry in 'write_paths'", source);
    }
    // The fence resolves write_paths relative to the worktree root. An
    // absolute path or `..` traversal would let a write escape the
    // fence — reject at parse time (hard security boundary).
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
      throw new DroidParseError(
        `unsafe write_path '${p}' — must be worktree-relative with no '..' ` +
          'traversal or absolute path.',
        source,
      );
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
