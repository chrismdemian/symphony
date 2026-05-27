/**
 * Phase 6A/6B — types for the voice bridge. Wire-format types are the
 * load-bearing contract between Node and the Python subprocess; they
 * carry through to 6C (wake-word), 6D (rolling buffer), and 6E (TUI
 * integration) without renaming.
 */

/**
 * JSON events the Python bridge writes to stdout, newline-delimited.
 *
 * Phase 6A introduced `ready` / `speech_start` / `speech_end` / `error`
 * / `shutdown_ack`. Phase 6B adds `stt_ready` (Moonshine warmup
 * complete), `partial` (re-running batch inference on the growing
 * buffer every ~200 ms), `final` (transcription on the full segment),
 * and `warning` (hard-cap utterance truncation).
 *
 * The bridge emits `ready` once after audio init + Silero model load
 * complete. `speech_start` / `speech_end` are the VAD-gated segment
 * boundaries — every speech_start is followed by exactly one speech_end
 * (no nesting, no overlap). `error` is non-fatal; fatal errors exit the
 * process with code 1 and stderr context. `shutdown_ack` is the final
 * message before a clean `exit 0` in response to `{"cmd":"shutdown"}`.
 *
 * 6B ordering contract (per segment):
 *   speech_start
 *     -> 0..N `partial` events (monotonic `seq`, may have gaps due to
 *        drop-oldest under load; consumers MUST discard out-of-order
 *        `partial` events with `seq <= lastRendered.seq`)
 *     -> speech_end
 *     -> exactly one `final` event with the latest `seq + 1`
 *   On hard-cap (>= --max-utterance-seconds): `warning` fires IMMEDIATELY
 *   at the truncation moment, then `speech_end` (synthetic), then the
 *   final inference completes and emits `final`.
 *
 * `tMs` is milliseconds since the `ready` event (monotonic per-session
 * timeline).
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
  | { readonly type: 'stt_ready'; readonly model: string }
  | { readonly type: 'speech_start'; readonly tMs: number }
  | {
      readonly type: 'speech_end';
      readonly tMs: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'partial';
      readonly seq: number;
      readonly text: string;
      readonly tMs: number;
    }
  | {
      readonly type: 'final';
      readonly seq: number;
      readonly text: string;
      readonly tMs: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'warning';
      readonly code: 'utterance-truncated';
      readonly tMs: number;
    }
  | {
      /** Phase 6C — fired when openWakeWord's sustain+cooldown logic commits
       * to a wake-word detection. Decoupled from VAD: may fire mid-segment
       * (during continuous speech that starts with "hey symphony") OR
       * outside any VAD segment (single softly-spoken wake phrase).
       * Consumers MUST NOT assume `wake_word` precedes `speech_start`. */
      readonly type: 'wake_word';
      readonly model: string;
      readonly score: number;
      readonly tMs: number;
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
 *
 * Phase 6B adds Moonshine STT fields (`moonshineInstalled`,
 * `moonshineImportOk`, `moonshineModelWarmed`) plus a `voiceVocabSeeded`
 * boolean for the atomic vocab-seed install.
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
    | 'numpy-install-failed'
    | 'moonshine-install-failed'
    | 'moonshine-import-failed'
    | 'moonshine-download-failed'
    | 'openwakeword-install-failed'
    | 'openwakeword-import-failed';
  readonly venvPath: string;
  readonly pythonPath: string;
  readonly sileroVadInstalled: boolean;
  readonly onnxRuntimeInstalled: boolean;
  readonly soundDeviceInstalled: boolean;
  readonly numpyInstalled: boolean;
  readonly pyAudioInstalled: boolean;
  /** Phase 6B — `useful-moonshine-onnx` pip-shows present. */
  readonly moonshineInstalled: boolean;
  /** Phase 6B — `from useful_moonshine_onnx import ...` succeeded (validates transitive deps that `pip show` doesn't catch). */
  readonly moonshineImportOk: boolean;
  /** Phase 6B — model weights downloaded + cached locally; future invocations skip the network. */
  readonly moonshineModelWarmed: boolean;
  /** Phase 6B — atomic `~/.symphony/voice-vocab.json` seed file created (only when target was absent). */
  readonly voiceVocabSeeded: boolean;
  /** Phase 6C — `openwakeword` pip-shows present. */
  readonly openWakeWordInstalled: boolean;
  /** Phase 6C — `from openwakeword.model import Model` succeeded. Validates the ONNX runtime + tflite-runtime-or-onnx-fallback + shared embedding backbone dependencies. */
  readonly openWakeWordImportOk: boolean;
  /** Phase 6C — bundled `hey-symphony.onnx` model present on disk (under `assets/wake-models/` in dev, `dist/assets/wake-models/` in built). */
  readonly wakeModelBundled: boolean;
  readonly warnings: readonly string[];
  /** True when nothing was reinstalled (every requested dep already present at its current version). */
  readonly idempotent: boolean;
}

/**
 * Result of `runVoiceDiagnose`. Used by the CLI surface and the Phase
 * 6A/6B production scenario gate. `speechSegments` is the count of
 * complete `speech_start → speech_end` pairs observed. Phase 6B adds
 * `finalEvents` (count of STT final-text events observed) so the gate
 * can assert STT is wired even when only VAD events are required by
 * the strict 6A pass criterion.
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
    | 'fixture-missing'
    | 'wake-model-missing'
    | 'no-wake-detected';
  readonly speechSegments: number;
  /** Phase 6B — count of `final` STT events seen during the run. */
  readonly finalEvents: number;
  /** Phase 6B — true when an `stt_ready` event was observed. */
  readonly sttReady: boolean;
  /** Phase 6C — count of `wake_word` events observed (when `--wake-word` mode is active). */
  readonly wakeEvents: number;
  /** Phase 6C — true when at least one `wake_word` event fired (convenience boolean over `wakeEvents > 0`). */
  readonly wakeDetected: boolean;
  /** Phase 6C — whether the diagnose ran in wake-word mode (`--wake-word`). When false, `wakeEvents`/`wakeDetected` are always 0/false. */
  readonly wakeMode: boolean;
  readonly events: readonly VoiceBridgeEvent[];
  readonly stderrTail: string;
  /** Wall-clock duration of the diagnose run, in ms. */
  readonly durationMs: number;
}

/**
 * Result of `runVoiceTranscribe` (Phase 6B). Mirrors the
 * `VoiceDiagnoseResult` shape (existing 6A pattern). The joined
 * transcript is the concatenation of `finals[*].text`, separated by a
 * single space.
 */
export interface VoiceTranscribeResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reason?:
    | 'voice-env-missing'
    | 'fixture-missing'
    | 'unsupported-audio-format'
    | 'bridge-spawn-failed'
    | 'bridge-ready-timeout'
    | 'stt-ready-timeout'
    | 'no-final-event';
  readonly transcript: string;
  readonly partials: ReadonlyArray<{
    readonly seq: number;
    readonly text: string;
    readonly tMs: number;
  }>;
  readonly finals: ReadonlyArray<{
    readonly seq: number;
    readonly text: string;
    readonly tMs: number;
    readonly durationMs: number;
  }>;
  readonly events: readonly VoiceBridgeEvent[];
  readonly stderrTail: string;
  readonly durationMs: number;
  readonly sttReady: boolean;
  readonly truncated: boolean;
}
