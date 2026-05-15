import { describe, it, expect } from 'vitest';
import { _stopIntentTakesPrecedence as takesPrecedence } from '../../src/workers/manager.js';

/**
 * Phase 3T — `stopIntent` precedence rule. A later, higher-priority
 * intent MUST overwrite an earlier lower-priority one. Without this,
 * a user who pivots (`interrupt`) then exits (`kill` via shutdown)
 * would see workers misclassified `interrupted` post-mortem.
 *
 * Ordering: timeout > kill > interrupt > none.
 */
describe('_stopIntentTakesPrecedence', () => {
  it('any intent overrides none', () => {
    expect(takesPrecedence('interrupt', 'none')).toBe(true);
    expect(takesPrecedence('kill', 'none')).toBe(true);
    expect(takesPrecedence('timeout', 'none')).toBe(true);
  });

  it('kill overrides interrupt (shutdown wins over pivot)', () => {
    expect(takesPrecedence('kill', 'interrupt')).toBe(true);
  });

  it('interrupt does NOT override kill (pivot must not weaken a real shutdown)', () => {
    expect(takesPrecedence('interrupt', 'kill')).toBe(false);
  });

  it('timeout overrides every other intent', () => {
    expect(takesPrecedence('timeout', 'kill')).toBe(true);
    expect(takesPrecedence('timeout', 'interrupt')).toBe(true);
    expect(takesPrecedence('timeout', 'none')).toBe(true);
  });

  it('no intent ever overrides timeout', () => {
    expect(takesPrecedence('kill', 'timeout')).toBe(false);
    expect(takesPrecedence('interrupt', 'timeout')).toBe(false);
  });

  it('an intent does not override itself (idempotency)', () => {
    expect(takesPrecedence('interrupt', 'interrupt')).toBe(false);
    expect(takesPrecedence('kill', 'kill')).toBe(false);
    expect(takesPrecedence('timeout', 'timeout')).toBe(false);
  });
});
