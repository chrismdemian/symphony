import React from 'react';
import { Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { SystemApiRetryEvent } from '../../../workers/types.js';

/**
 * Phase 3D.1 — sticky rate-limit banner.
 *
 * Renders a single amber row at the top of the output panel while the
 * most recent retry event hasn't yet been followed by a non-retry
 * visible event. Auto-clears via the reducer's `lastRetryEvent` state
 * (set on `system_api_retry`, cleared on the next non-retry append /
 * derived backwards after `backfillMerge`). The body keeps the audit
 * trail; the banner is the glanceable header.
 */

export interface RateLimitBannerProps {
  readonly retry: SystemApiRetryEvent | null;
}

export function RateLimitBanner({ retry }: RateLimitBannerProps): React.JSX.Element | null {
  const theme = useTheme();
  if (retry === null) return null;

  const seconds =
    typeof retry.delayMs === 'number' ? Math.max(0, Math.round(retry.delayMs / 1000)) : null;
  const attempt = typeof retry.attempt === 'number' ? retry.attempt : null;

  const attemptPart = attempt === null ? '' : ` attempt ${attempt}`;
  const retryPart = seconds === null ? 'retrying' : `retry in ${seconds}s`;

  return (
    <Text color={theme['rateLimitWarning']} bold>
      ⏱ rate limited —{attemptPart}, {retryPart}
    </Text>
  );
}
