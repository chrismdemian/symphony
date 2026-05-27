/**
 * Phase 6A — types for the voice bridge. Wire-format types are the
 * load-bearing contract between Node and the Python subprocess; they
 * carry through to 6B (STT events), 6C (wake-word), 6D (rolling buffer),
 * and 6E (TUI integration) without renaming.
 */

/**
 * JSON events the Python bridge writes to stdout, newline-delimited.
 *
 * The bridge emits `ready` once after audio init + Silero model load
 * complete. `speech_start` / `speech_end` are the VAD-gated segment
 * boundaries — every speech_start is followed by exactly one speech_end
 * (no nesting, no overlap). `error` is non-fatal; fatal errors exit the
 * process with code 1 and stderr context. `shutdown_ack` is the final
 * message before a clean `exit 0` in response to `{"cmd":"shutdown"}`.
 *
 * `tMs` is milliseconds since the `ready` event (monotonic per-session
 * timeline). 6B will emit additional event kinds (`partial`, `final`)
 * without changing this union's shape — the discriminated union widens.
 */
export type VoiceBridgeEvent =
  | {
      readonly type: 'ready';
      readonly backend: VoiceAudioBackend;
      readonly sampleRate: number;
      readonly vadThreshold: number;
      readonly vadMinSpeechMs: number;
      readonly vadMinSilenceMs: number;
    }
  | { readonly type: 'speech_start'; readonly tMs: number }
  | {
      readonly type: 'speech_end';
      readonly tMs: number;
      readonly durationMs: number;
    }
  | { readonly type: 'error'; readonly code: string; readonly message: string }
  | { readonly type: 'shutdown_ack' };

/**
 * Which audio capture library the bridge initialized with.
 * `'stdin-pcm'` is the test/diagnose mode — no real microphone.
 */
export type VoiceAudioBackend = 'sounddevice' | 'pyaudio' | 'stdin-pcm';

/**
 * Commands Node writes to the bridge's stdin, newline-delimited JSON.
 * The runtime threshold setter (`set_threshold`) is reserved for 6E's
 * settings popup; 6A includes it in the protocol so 6E doesn't have to
 * widen the wire format later.
 */
export type VoiceBridgeCommand =
  | { readonly cmd: 'shutdown' }
  | { readonly cmd: 'set_threshold'; readonly value: number };

/**
 * Result of `runVoiceInstall`. Mirrors the `RunSkillsResult` shape from
 * Phase 4D.3/4D.4 (exitCode + structured payload). PyAudio install on
 * Win32 is best-effort — `pyAudioAvailable: false` is NOT a failure;
 * sounddevice is the primary capture backend.
 */
export interface VoiceInstallResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reason?:
    | 'python-not-found'
    | 'python-version-too-old'
    | 'python-store-install'
    | 'venv-creation-failed'
    | 'pip-bootstrap-failed'
    | 'silero-install-failed'
    | 'sounddevice-install-failed'
    | 'numpy-install-failed';
  readonly venvPath: string;
  readonly pythonPath: string;
  readonly sileroVadInstalled: boolean;
  readonly onnxRuntimeInstalled: boolean;
  readonly soundDeviceInstalled: boolean;
  readonly numpyInstalled: boolean;
  readonly pyAudioInstalled: boolean;
  readonly warnings: readonly string[];
  /** True when nothing was reinstalled (every requested dep already present at its current version). */
  readonly idempotent: boolean;
}

/**
 * Result of `runVoiceDiagnose`. Used by the CLI surface and the Phase 6A
 * production scenario gate. `speechSegments` is the count of complete
 * `speech_start → speech_end` pairs observed.
 */
export interface VoiceDiagnoseResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reason?:
    | 'voice-env-missing'
    | 'python-not-runnable'
    | 'bridge-spawn-failed'
    | 'bridge-ready-timeout'
    | 'bridge-exit-nonzero'
    | 'no-speech-detected'
    | 'fixture-missing';
  readonly speechSegments: number;
  readonly events: readonly VoiceBridgeEvent[];
  readonly stderrTail: string;
  /** Wall-clock duration of the diagnose run, in ms. */
  readonly durationMs: number;
}
