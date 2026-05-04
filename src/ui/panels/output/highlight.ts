/**
 * Phase 3F.4 — minimal syntax highlighter for the output panel.
 *
 * Hand-rolled per-language token detection — keywords, strings,
 * comments, numbers. Goal: visual signal, NOT full grammar accuracy.
 * For the worker-output use case (workers emit short code blocks
 * inline), regex tokenization is sufficient and avoids the bundle
 * cost of `cli-highlight`/`shiki` (PLAN.md §3F.4 research decision).
 *
 * Pattern: the highlighter returns a flat array of `Token`s in source
 * order. Each token has `kind` (used for theme color lookup) + `text`.
 * Adjacent default tokens are merged. Unknown languages fall through
 * with a single `default` token.
 *
 * Memoized via module-scope LRU keyed on `sha1(lang + source)` — same
 * code block re-renders during streaming hit the cache. Bound to 64
 * entries (recent worker output).
 */

export type TokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'default';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

/**
 * Languages with first-class regex configs. Normalized lang tags only —
 * 'tsx' falls through to 'ts' coverage, etc. (handled by `aliasLang`).
 */
type LangConfig = {
  /** Single-token comment patterns — must NOT match across multi-token boundaries. */
  readonly commentPatterns: readonly RegExp[];
  /** String literal patterns — single-line greedy matches. */
  readonly stringPatterns: readonly RegExp[];
  /** Sorted-longest-first keyword list. */
  readonly keywords: readonly string[];
  /** Number literal pattern. */
  readonly numberPattern: RegExp;
};

const TS_KEYWORDS = [
  'abstract', 'any', 'as', 'async', 'await', 'bigint', 'boolean',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'is',
  'keyof', 'let', 'namespace', 'never', 'new', 'null', 'number',
  'object', 'of', 'package', 'private', 'protected', 'public',
  'readonly', 'return', 'satisfies', 'static', 'string', 'super',
  'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type',
  'typeof', 'undefined', 'unknown', 'var', 'void', 'while', 'with',
  'yield',
] as const;

const PY_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
] as const;

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
  'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
  'interface', 'map', 'package', 'range', 'return', 'select',
  'struct', 'switch', 'type', 'var', 'true', 'false', 'nil',
] as const;

const RS_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate',
  'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if',
  'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut',
  'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct',
  'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where',
  'while',
] as const;

const SH_KEYWORDS = [
  'break', 'case', 'continue', 'do', 'done', 'elif', 'else', 'esac',
  'fi', 'for', 'function', 'if', 'in', 'local', 'return', 'select',
  'then', 'time', 'until', 'while',
] as const;

const JSON_KEYWORDS = ['true', 'false', 'null'] as const;

const LANG_CONFIGS: Record<string, LangConfig> = {
  ts: {
    commentPatterns: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
    stringPatterns: [/'(?:\\.|[^'\\])*'/g, /"(?:\\.|[^"\\])*"/g, /`(?:\\.|[^`\\])*`/g],
    keywords: TS_KEYWORDS,
    numberPattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
  },
  py: {
    commentPatterns: [/#[^\n]*/g],
    stringPatterns: [
      /'''[\s\S]*?'''/g,
      /"""[\s\S]*?"""/g,
      /'(?:\\.|[^'\\])*'/g,
      /"(?:\\.|[^"\\])*"/g,
    ],
    keywords: PY_KEYWORDS,
    numberPattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
  },
  go: {
    commentPatterns: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
    stringPatterns: [/'(?:\\.|[^'\\])*'/g, /"(?:\\.|[^"\\])*"/g, /`[^`]*`/g],
    keywords: GO_KEYWORDS,
    numberPattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
  },
  rs: {
    commentPatterns: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
    stringPatterns: [/'(?:\\.|[^'\\])*'/g, /"(?:\\.|[^"\\])*"/g],
    keywords: RS_KEYWORDS,
    numberPattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
  },
  sh: {
    commentPatterns: [/#[^\n]*/g],
    stringPatterns: [/'[^']*'/g, /"(?:\\.|[^"\\])*"/g],
    keywords: SH_KEYWORDS,
    numberPattern: /\b\d+\b/g,
  },
  json: {
    commentPatterns: [],
    stringPatterns: [/"(?:\\.|[^"\\])*"/g],
    keywords: JSON_KEYWORDS,
    numberPattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
  },
  yaml: {
    commentPatterns: [/#[^\n]*/g],
    stringPatterns: [/'[^']*'/g, /"(?:\\.|[^"\\])*"/g],
    keywords: ['true', 'false', 'null', 'yes', 'no'],
    numberPattern: /\b\d+(?:\.\d+)?\b/g,
  },
};

function aliasLang(lang: string): string {
  switch (lang.toLowerCase()) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'javascript':
    case 'typescript':
      return 'ts';
    case 'py':
    case 'python':
      return 'py';
    case 'go':
    case 'golang':
      return 'go';
    case 'rs':
    case 'rust':
      return 'rs';
    case 'sh':
    case 'bash':
    case 'shell':
    case 'zsh':
      return 'sh';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return lang.toLowerCase();
  }
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly kind: TokenKind;
  readonly text: string;
}

function collectMatches(source: string, config: LangConfig): Match[] {
  const matches: Match[] = [];
  for (const re of config.commentPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        kind: 'comment',
        text: m[0],
      });
    }
  }
  for (const re of config.stringPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        kind: 'string',
        text: m[0],
      });
    }
  }
  config.numberPattern.lastIndex = 0;
  let nm: RegExpExecArray | null;
  while ((nm = config.numberPattern.exec(source)) !== null) {
    matches.push({
      start: nm.index,
      end: nm.index + nm[0].length,
      kind: 'number',
      text: nm[0],
    });
  }
  // Keywords — word-boundary regex per lang.
  if (config.keywords.length > 0) {
    const kw = new RegExp(`\\b(${config.keywords.join('|')})\\b`, 'g');
    let km: RegExpExecArray | null;
    while ((km = kw.exec(source)) !== null) {
      matches.push({
        start: km.index,
        end: km.index + km[0].length,
        kind: 'keyword',
        text: km[0],
      });
    }
  }
  return matches;
}

function resolveOverlaps(matches: Match[]): Match[] {
  // Sort by start; later, prefer earlier start. On tie, prefer LONGER match
  // (string > keyword if same start). Then drop any match contained inside
  // the previous one.
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const out: Match[] = [];
  let lastEnd = 0;
  for (const m of sorted) {
    if (m.start < lastEnd) continue;
    out.push(m);
    lastEnd = m.end;
  }
  return out;
}

function tokenizeUncached(lang: string, source: string): Token[] {
  const aliased = aliasLang(lang);
  const config = LANG_CONFIGS[aliased];
  if (config === undefined) {
    return [{ kind: 'default', text: source }];
  }
  const matches = resolveOverlaps(collectMatches(source, config));
  if (matches.length === 0) {
    return [{ kind: 'default', text: source }];
  }
  const tokens: Token[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) {
      tokens.push({ kind: 'default', text: source.slice(cursor, m.start) });
    }
    tokens.push({ kind: m.kind, text: m.text });
    cursor = m.end;
  }
  if (cursor < source.length) {
    tokens.push({ kind: 'default', text: source.slice(cursor) });
  }
  return tokens;
}

// LRU cache keyed on `${lang}::${source}`. Bounded to 64 entries; size
// chosen from the worker-output worst case (a typical "show me the
// diff" request emits ≤ 5 distinct code blocks; 64 covers many active
// workers without exceeding ~5 MB of cached strings).
const CACHE_LIMIT = 64;
const cache = new Map<string, Token[]>();

export function tokenize(lang: string, source: string): Token[] {
  const key = `${aliasLang(lang)}::${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Move to most-recently-used.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const tokens = tokenizeUncached(lang, source);
  if (cache.size >= CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, tokens);
  return tokens;
}

/** Test seam — clear the LRU between tests. */
export function _resetHighlightCache(): void {
  cache.clear();
}
