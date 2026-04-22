/**
 * Parse a shell-style argument string into an array of arguments.
 * POSIX + Windows-aware: handles single/double quotes and backslash
 * escape rules per platform. Ported from emdash `ptyManager.ts:688-760`.
 *
 * Platform is an explicit parameter (defaulting to `process.platform`)
 * so tests can exercise both behaviours on the same host.
 */
export interface ParseShellArgsOptions {
  platform?: NodeJS.Platform;
  onWarning?: (message: string) => void;
}

export function parseShellArgs(
  input: string,
  options: ParseShellArgsOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const args: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      if (platform === 'win32') {
        // Preserve backslashes for Windows paths. Only `\"` inside double
        // quotes counts as an escape.
        const next = input[i + 1];
        if (inDoubleQuote && next === '"') {
          escape = true;
          continue;
        }
      } else if (!inSingleQuote) {
        // POSIX: backslash escapes next char except inside single quotes.
        escape = true;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escape) current += '\\';

  if (inSingleQuote || inDoubleQuote) {
    options.onWarning?.(`unclosed quote in input: ${input}`);
  }

  if (current.length > 0) args.push(current);

  return args;
}
