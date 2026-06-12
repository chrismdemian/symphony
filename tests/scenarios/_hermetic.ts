import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';
import { defaultConfig, type SymphonyConfig } from '../../src/utils/config-schema.js';

export interface HermeticConfigHandle {
  readonly cfgFile: string;
  /** Restore the previous env + remove the temp dir. Call in afterEach. */
  restore(): void;
}

/**
 * Pin `SYMPHONY_CONFIG_FILE` to an isolated config so a scenario's
 * `runStart()` → `loadConfig()` never reads (or writes) the developer's
 * real `~/.symphony/config.json`.
 *
 * Why this matters: `loadConfig()` takes no `home` arg, so without this a
 * scenario silently inherits whatever is on the dev machine — and any test
 * that writes the real config (the `5d-config-watch` leak) pollutes every
 * later scenario non-deterministically.
 *
 * Defaults `automationsEnabled: false` so the Phase-8D `AutomationInjector`
 * (a second, legitimate `maestro.events()` consumer) doesn't start — keeping
 * single-iterator and side-effect assertions deterministic. Override any
 * field via `overrides`.
 */
export function useHermeticConfig(
  overrides?: Partial<SymphonyConfig>,
): HermeticConfigHandle {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-hermetic-cfg-'));
  mkdirSync(dir, { recursive: true });
  const cfgFile = join(dir, 'config.json');
  const cfg: SymphonyConfig = {
    ...defaultConfig(),
    automationsEnabled: false,
    ...overrides,
  };
  writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8');
  const prev = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
  return {
    cfgFile,
    restore(): void {
      if (prev === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
      else process.env[SYMPHONY_CONFIG_FILE_ENV] = prev;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}
