import { describe, it, expect, beforeEach } from 'vitest';
import { tokenize, _resetHighlightCache } from '../../../../src/ui/panels/output/highlight.js';

beforeEach(() => {
  _resetHighlightCache();
});

describe('tokenize (Phase 3F.4)', () => {
  it('returns single default token for unknown lang', () => {
    const tokens = tokenize('unknownlang', 'whatever text');
    expect(tokens).toEqual([{ kind: 'default', text: 'whatever text' }]);
  });

  it('tokenizes ts keywords as keyword', () => {
    const tokens = tokenize('ts', 'const foo = 1;');
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain('keyword');
    const constToken = tokens.find((t) => t.text === 'const');
    expect(constToken?.kind).toBe('keyword');
  });

  it('tokenizes ts number literals', () => {
    const tokens = tokenize('ts', 'const x = 42.5;');
    const num = tokens.find((t) => t.text === '42.5');
    expect(num?.kind).toBe('number');
  });

  it('tokenizes single-quoted ts string', () => {
    const tokens = tokenize('ts', "const s = 'hello';");
    const str = tokens.find((t) => t.text === "'hello'");
    expect(str?.kind).toBe('string');
  });

  it('tokenizes ts // comment', () => {
    const tokens = tokenize('ts', '// commentary\nconst x = 1;');
    const comment = tokens.find((t) => t.text === '// commentary');
    expect(comment?.kind).toBe('comment');
  });

  it('tokenizes ts /* block */ comment', () => {
    const tokens = tokenize('ts', '/* multi\nline */ const x = 1;');
    const comment = tokens.find((t) => t.kind === 'comment');
    expect(comment?.text).toContain('/*');
    expect(comment?.text).toContain('*/');
  });

  it('aliases js/jsx/tsx to ts coverage', () => {
    expect(tokenize('jsx', 'const x = 1;').some((t) => t.text === 'const' && t.kind === 'keyword')).toBe(true);
    expect(tokenize('javascript', 'const x = 1;').some((t) => t.text === 'const' && t.kind === 'keyword')).toBe(true);
  });

  it('tokenizes py keywords + # comments', () => {
    const tokens = tokenize('py', 'def foo():\n  # comment\n  return 1');
    const def = tokens.find((t) => t.text === 'def');
    expect(def?.kind).toBe('keyword');
    const comment = tokens.find((t) => t.text === '# comment');
    expect(comment?.kind).toBe('comment');
  });

  it('aliases python → py', () => {
    const tokens = tokenize('python', 'def foo():');
    expect(tokens.find((t) => t.text === 'def')?.kind).toBe('keyword');
  });

  it('tokenizes go keywords', () => {
    const tokens = tokenize('go', 'func main() { return }');
    expect(tokens.find((t) => t.text === 'func')?.kind).toBe('keyword');
    expect(tokens.find((t) => t.text === 'return')?.kind).toBe('keyword');
  });

  it('tokenizes rs keywords', () => {
    const tokens = tokenize('rs', 'pub fn foo() {}');
    expect(tokens.find((t) => t.text === 'pub')?.kind).toBe('keyword');
    expect(tokens.find((t) => t.text === 'fn')?.kind).toBe('keyword');
  });

  it('tokenizes sh # comments + keywords', () => {
    const tokens = tokenize('sh', 'if [ -f file ]; then\n  echo ok\nfi');
    expect(tokens.find((t) => t.text === 'if')?.kind).toBe('keyword');
    expect(tokens.find((t) => t.text === 'fi')?.kind).toBe('keyword');
  });

  it('tokenizes json strings + booleans + numbers', () => {
    const tokens = tokenize('json', '{"name": "alpha", "n": 42, "ok": true}');
    expect(tokens.find((t) => t.text === '"alpha"')?.kind).toBe('string');
    expect(tokens.find((t) => t.text === '42')?.kind).toBe('number');
    expect(tokens.find((t) => t.text === 'true')?.kind).toBe('keyword');
  });

  it('preserves source order across tokens', () => {
    const tokens = tokenize('ts', 'const x = 1;');
    const concat = tokens.map((t) => t.text).join('');
    expect(concat).toBe('const x = 1;');
  });

  it('memoizes — second call with same args returns identity-equal array', () => {
    const a = tokenize('ts', 'const x = 1;');
    const b = tokenize('ts', 'const x = 1;');
    expect(a).toBe(b);
  });

  it('different languages with same source yield different tokenizations', () => {
    const tsTokens = tokenize('ts', 'def x = 1');
    const pyTokens = tokenize('py', 'def x = 1');
    expect(tsTokens.find((t) => t.text === 'def')?.kind).not.toBe('keyword');
    expect(pyTokens.find((t) => t.text === 'def')?.kind).toBe('keyword');
  });

  it('TS built-in type names are tokenized as keywords (audit C1)', () => {
    // `string`, `number`, `boolean`, `void`, `any`, `unknown`, `never`,
    // `bigint`, `object`, `symbol`, `as` — all promoted to keyword in
    // 3F.4 audit response so type annotations render with the brand
    // accent instead of falling through as default text.
    const source = 'const s: string = ""; const n: number = 0; const b: boolean = true;';
    const tokens = tokenize('ts', source);
    expect(tokens.find((t) => t.text === 'string')?.kind).toBe('keyword');
    expect(tokens.find((t) => t.text === 'number')?.kind).toBe('keyword');
    expect(tokens.find((t) => t.text === 'boolean')?.kind).toBe('keyword');
  });

  it('TS `as` cast is tokenized as keyword', () => {
    const tokens = tokenize('ts', 'const x = foo as Bar;');
    expect(tokens.find((t) => t.text === 'as')?.kind).toBe('keyword');
  });
});
