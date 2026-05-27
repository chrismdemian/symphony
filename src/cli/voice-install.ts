import {
  runVoiceInstall as runInstallCore,
  type RunVoiceInstallOptions,
} from '../voice/installer.js';
import type { VoiceInstallResult } from '../voice/types.js';

/**
 * Phase 6A — `symphony voice install` CLI runner.
 *
 * Thin wrapper around `runVoiceInstall` that adds human-readable
 * stdout progress + summary. Returns the structured `VoiceInstallResult`
 * unchanged so callers (tests, agent-native consumers) get the rich
 * payload alongside the line-by-line output.
 */
export interface RunVoiceInstallCliOptions extends RunVoiceInstallOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export async function runVoiceInstall(
  opts: RunVoiceInstallCliOptions = {},
): Promise<VoiceInstallResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  stdout.write('[symphony] Installing voice subsystem (Phase 6A)...\n');

  const result = await runInstallCore({
    ...opts,
    onProgress: (line) => {
      // Indent pip output so the install banner stays readable
      stdout.write(`  ${line}\n`);
      opts.onProgress?.(line);
    },
  });

  if (result.ok) {
    if (result.idempotent) {
      stdout.write(
        `[symphony] Voice subsystem already installed at ${result.venvPath} — no changes.\n`,
      );
    } else {
      stdout.write(`[symphony] Voice subsystem installed at ${result.venvPath}.\n`);
    }
    stdout.write(`           silero-vad: ${result.sileroVadInstalled ? 'present' : 'MISSING'}\n`);
    stdout.write(`           sounddevice: ${result.soundDeviceInstalled ? 'present' : 'MISSING'}\n`);
    stdout.write(
      `           pyaudio (optional fallback): ${
        result.pyAudioInstalled ? 'present' : 'absent (sounddevice is primary)'
      }\n`,
    );
    for (const w of result.warnings) {
      stderr.write(`[symphony] warning: ${w}\n`);
    }
    stdout.write('[symphony] Next step: `symphony voice diagnose` to verify VAD events.\n');
  } else {
    stderr.write(
      `[symphony] Voice install failed: ${result.reason ?? 'unknown'}\n`,
    );
    for (const w of result.warnings) {
      stderr.write(`           ${w}\n`);
    }
  }
  return result;
}
