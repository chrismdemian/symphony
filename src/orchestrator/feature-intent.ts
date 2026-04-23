const MAX_FEATURE_INTENT_LEN = 60;

/**
 * Derive a stable, URL-safe slug from a task description.
 * Used to tag every worker with a one-line `feature_intent` that Maestro
 * references via `find_worker("the liquid glass one")` — see
 * `research/maestro-prompt-design.md` §6 + PLAN.md rule #3.
 *
 * Non-letters/digits collapse to `-`; leading/trailing dashes trimmed;
 * result bounded at 60 chars. Empty input returns `'untitled'` so every
 * worker has a non-empty intent.
 */
export function deriveFeatureIntent(description: string): string {
  const slug = description
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FEATURE_INTENT_LEN)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

export function matchesFeatureIntent(intent: string, description: string): boolean {
  const needle = description.trim().toLowerCase();
  if (needle.length === 0) return false;
  const haystack = intent.toLowerCase();
  if (haystack.includes(needle)) return true;
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => haystack.includes(tok));
}
