/**
 * Phase 3R — Log sanitizer.
 *
 * Port of `omi/backend/utils/log_sanitizer.py`. Two functions:
 *
 *   - `sanitize(value)` — mask 8+ char runs containing digits or
 *     base64 specials (`+/`), mask email local part. Pure-alpha runs
 *     (like `access_token`, `exchange`) are preserved so structural
 *     context survives.
 *   - `sanitizePii(value)` — always mask every word. Use when the
 *     value is KNOWN to be PII (names, free-form user text, answers
 *     that might contain secrets).
 *
 * Both functions are pure + deterministic. Null / undefined return
 * the string `'None'` (matches Omi). Long inputs truncated at 2000
 * (sanitize) / 200 (sanitizePii) chars — the audit log is a
 * forensic trail, not a complete capture.
 */

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_PATTERN = /[A-Za-z0-9+/_-]{8,}/g;

const SANITIZE_MAX = 2000;
const SANITIZE_PII_MAX = 200;
const TRUNCATED_MARKER = '...[truncated]';

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) return `***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function maskToken(token: string): string {
  // Pure-alpha / underscore / hyphen words (no digits, no base64 specials)
  // are left intact — preserves JSON keys, error codes, function names.
  let hasMaskTrigger = false;
  for (const c of token) {
    if ((c >= '0' && c <= '9') || c === '+' || c === '/') {
      hasMaskTrigger = true;
      break;
    }
  }
  if (!hasMaskTrigger) return token;
  if (token.length < 8) return token;
  if (token.length <= 12) {
    return `${token.slice(0, 3)}***${token.slice(-3)}`;
  }
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

export function sanitize(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  let text = String(value);
  if (text.length > SANITIZE_MAX) {
    text = text.slice(0, SANITIZE_MAX) + TRUNCATED_MARKER;
  }
  // Email pass FIRST so token pass doesn't mangle local parts.
  text = text.replace(EMAIL_PATTERN, (m) => maskEmail(m));
  text = text.replace(TOKEN_PATTERN, (m) => maskToken(m));
  return text;
}

function maskWord(word: string): string {
  const n = word.length;
  if (n <= 4) return '***';
  if (n <= 8) return `${word[0]}***${word[n - 1]}`;
  return `${word.slice(0, 2)}***${word.slice(-2)}`;
}

export function sanitizePii(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  let text = String(value);
  const truncated = text.length > SANITIZE_PII_MAX;
  if (truncated) text = text.slice(0, SANITIZE_PII_MAX);
  text = text.replace(EMAIL_PATTERN, (m) => maskEmail(m));
  // Whitespace-split + per-word mask; emails (now containing `@`) pass through.
  const words = text.split(/\s+/);
  const masked = words.map((w) => (w.length === 0 || w.includes('@') ? w : maskWord(w)));
  let result = masked.join(' ');
  if (truncated) result += '...';
  return result;
}
