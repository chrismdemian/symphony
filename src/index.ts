#!/usr/bin/env node
import { Command } from 'commander';
// Type-only import — erased at compile, zero startup cost. The runtime
// `VoiceBridge` is still dynamic-imported inside the `voice listen` action
// to keep the CLI's cold-start fast.
import type { VoiceBridge } from './voice/bridge.js';

const program = new Command();

program
  .name('symphony')
  .description('Claude Code orchestrator — manage multiple claude -p workers across projects.')
  .version('0.0.0');

program
  .command('start')
  .description('Launch the Symphony orchestrator (Maestro).')
  .option('--in-memory', 'Run the bootstrap mcp-server in-memory (debug; no SQLite).')
  .option('--rpc-port <n>', 'Bootstrap mcp-server RPC port (0 = ephemeral).', (v) =>
    Number.parseInt(v, 10),
  )
  .action(async (opts: { inMemory?: boolean; rpcPort?: number }) => {
    const { runStart } = await import('./cli/start.js');
    const startOpts: Parameters<typeof runStart>[0] = {};
    if (opts.inMemory === true) startOpts.inMemory = true;
    if (opts.rpcPort !== undefined) startOpts.rpcPort = opts.rpcPort;
    const handle = await runStart(startOpts);
    await handle.done;
    process.exit(0);
  });

program
  .command('add <path>')
  .description(
    'Register a project with Symphony. Name auto-detects from --name, .symphony.json, package.json, then directory basename.',
  )
  .option('--name <name>', 'Override the auto-detected project name (slug-normalized).')
  .action(async (projectPath: string, opts: { name?: string }) => {
    const { runAdd } = await import('./cli/add.js');
    const result = await runAdd({
      projectPath,
      ...(opts.name !== undefined ? { nameOverride: opts.name } : {}),
    });
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('list')
  .description('List registered projects.')
  .option('--json', 'Print as JSON instead of a table (for scripting).')
  .action(async (opts: { json?: boolean }) => {
    const { runList } = await import('./cli/list.js');
    const result = await runList({ format: opts.json === true ? 'json' : 'table' });
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('remove <name>')
  .description('Unregister a project by name (or id).')
  .option('--force', 'Remove even when active workers or pending tasks exist.')
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import('./cli/remove.js');
    const result = await runRemove({
      nameOrId: name,
      ...(opts.force === true ? { force: true } : {}),
    });
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('config')
  .description(
    'Open Symphony settings (TUI). With --edit, opens ~/.symphony/config.json in $EDITOR.',
  )
  .option('--edit', 'Open the config file in $EDITOR ($VISUAL → $EDITOR → notepad/vi).')
  .option(
    '--config-file <path>',
    'Override the config file path (default ~/.symphony/config.json or $SYMPHONY_CONFIG_FILE).',
  )
  .action(async (opts: { edit?: boolean; configFile?: string }) => {
    if (opts.edit === true) {
      const { runConfigEdit } = await import('./cli/config-edit.js');
      const result = await runConfigEdit({
        ...(opts.configFile !== undefined ? { configFilePath: opts.configFile } : {}),
      });
      if (result.created) {
        console.error(`[symphony] created ${result.filePath}`);
      }
      process.exit(result.exitCode);
    }
    // No --edit: boot the TUI and pre-open the settings popup. This
    // routes through the same `runStart` as `symphony start`, so the
    // user gets the full app behind the popup — Esc closes it and they
    // continue working.
    const { runStart } = await import('./cli/start.js');
    const handle = await runStart({ initialPopup: 'settings' });
    await handle.done;
    process.exit(0);
  });

program
  .command('reset')
  .description(
    'Wipe all Symphony workers, tasks, questions, and worktrees. User config preserved.',
  )
  .option('--force', 'Skip the typed-confirmation prompt (CI / scripted).')
  .action(async (opts: { force?: boolean }) => {
    const { runReset } = await import('./cli/reset.js');
    const result = await runReset({ force: opts.force === true });
    process.exit(result.ok ? 0 : 1);
  });

const skills = program
  .command('skills')
  .description('Manage persistent, cross-project skills (~/.symphony/skills).');

skills
  .command('install <source>')
  .description(
    'Install a skill from a directory containing SKILL.md, or a .md file.',
  )
  .option('--id <id>', 'Override the skill id (default: source basename).')
  .action(async (source: string, opts: { id?: string }) => {
    const { runSkillsInstall } = await import('./cli/skills.js');
    const result = await runSkillsInstall({
      source,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
    });
    process.exit(result.exitCode);
  });

skills
  .command('list')
  .description('List installed skills and their agent-link status.')
  .action(async () => {
    const { runSkillsList } = await import('./cli/skills.js');
    const result = await runSkillsList();
    process.exit(result.exitCode);
  });

skills
  .command('sync-bundled')
  .description('Install/refresh the bundled skill set (idempotent).')
  .option('--force', 'Reinstall even if already up-to-date.')
  .action(async (opts: { force?: boolean }) => {
    const { runSkillsSyncBundled } = await import('./cli/skills.js');
    const result = await runSkillsSyncBundled(
      opts.force === true ? { force: true } : {},
    );
    process.exit(result.exitCode);
  });

skills
  .command('uninstall <name>')
  .description('Remove a skill and its agent symlink.')
  .action(async (name: string) => {
    const { runSkillsUninstall } = await import('./cli/skills.js');
    const result = await runSkillsUninstall({ id: name });
    process.exit(result.exitCode);
  });

const plugin = program
  .command('plugin')
  .description('Manage Symphony plugins (~/.symphony/plugins). Phase 7A.');

plugin
  .command('new <name>')
  .description('Scaffold a new plugin project (uses @symphony/plugin-sdk). Phase 7B.')
  .option('--out <dir>', 'Target directory (default: ./<id>).')
  .option('--author <author>', 'Plugin author for the manifest.')
  .option('--force', 'Scaffold into a non-empty directory.')
  .action(async (name: string, opts: { out?: string; author?: string; force?: boolean }) => {
    const { runPluginNew } = await import('./cli/plugin-new.js');
    const result = await runPluginNew({
      name,
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      ...(opts.author !== undefined ? { author: opts.author } : {}),
      ...(opts.force === true ? { force: true } : {}),
    });
    process.exit(result.exitCode);
  });

plugin
  .command('install <source>')
  .description('Install a plugin from a local directory (containing plugin.json) or a plugin.json path.')
  .action(async (source: string) => {
    const { runPluginInstall } = await import('./cli/plugin.js');
    const result = await runPluginInstall({ source });
    process.exit(result.exitCode);
  });

plugin
  .command('list')
  .description('List installed plugins and their enabled state.')
  .option('--json', 'Print as JSON instead of a table (for scripting).')
  .action(async (opts: { json?: boolean }) => {
    const { runPluginList } = await import('./cli/plugin.js');
    const result = await runPluginList({ format: opts.json === true ? 'json' : 'table' });
    process.exit(result.exitCode);
  });

plugin
  .command('remove <id>')
  .description('Uninstall a plugin by id (removes the dir and the registry row).')
  .action(async (id: string) => {
    const { runPluginRemove } = await import('./cli/plugin.js');
    const result = await runPluginRemove({ id });
    process.exit(result.exitCode);
  });

plugin
  .command('enable <id>')
  .description('Enable an installed plugin (loads at next Symphony start).')
  .action(async (id: string) => {
    const { runPluginEnable } = await import('./cli/plugin.js');
    const result = await runPluginEnable({ id });
    process.exit(result.exitCode);
  });

plugin
  .command('disable <id>')
  .description('Disable an installed plugin (stops loading at next Symphony start).')
  .action(async (id: string) => {
    const { runPluginDisable } = await import('./cli/plugin.js');
    const result = await runPluginDisable({ id });
    process.exit(result.exitCode);
  });

program
  .command('update-catalogs')
  .description(
    'Vendor the awesome-design-md design catalog into ~/.symphony/design-catalog/ for the bundled design-researcher droid (Phase 4F.2).',
  )
  .option('--force', 'Refetch every slug (default: skip slugs already present).')
  .option('--slug <name>', 'Only update one slug (matches `getdesign list`).')
  .option('--vendor-dir <path>', 'Override the vendor directory.')
  .action(
    async (opts: { force?: boolean; slug?: string; vendorDir?: string }) => {
      const { runUpdateCatalogs } = await import('./cli/update-catalogs.js');
      const result = await runUpdateCatalogs({
        ...(opts.force === true ? { force: true } : {}),
        ...(opts.slug !== undefined ? { only: opts.slug } : {}),
        ...(opts.vendorDir !== undefined ? { vendorDir: opts.vendorDir } : {}),
      });
      process.exit(result.exitCode);
    },
  );

const voice = program
  .command('voice')
  .description(
    'Voice subsystem (Phase 6A) — install the local Python bridge or run a VAD diagnose.',
  );

voice
  .command('install')
  .description(
    'Bootstrap the Python venv at ~/.symphony/voice-env (silero-vad + sounddevice + numpy; pyaudio best-effort).',
  )
  .option('--force', 'Reinstall even when deps are already present.')
  .action(async (opts: { force?: boolean }) => {
    const { runVoiceInstall } = await import('./cli/voice-install.js');
    const result = await runVoiceInstall(opts.force === true ? { force: true } : {});
    process.exit(result.exitCode);
  });

voice
  .command('diagnose')
  .description(
    'Pipe a known PCM fixture through the bridge and assert VAD events fire. Exits 0 on PASS.',
  )
  .option('--json', 'Emit a single-line JSON summary instead of human output.')
  .option(
    '--wake-word',
    'Phase 6C — run in wake-word mode: pipe wake-symphony-3s.pcm + assert ≥1 wake_word event.',
  )
  .option(
    '--wake-word-threshold <n>',
    'Override the wake-word activation threshold (0..1, default 0.5).',
    (v) => Number.parseFloat(v),
  )
  .action(
    async (opts: {
      json?: boolean;
      wakeWord?: boolean;
      wakeWordThreshold?: number;
    }) => {
      const { runVoiceDiagnose } = await import('./cli/voice-diagnose.js');
      const wakeWordThreshold =
        opts.wakeWordThreshold !== undefined &&
        Number.isFinite(opts.wakeWordThreshold)
          ? opts.wakeWordThreshold
          : undefined;
      const result = await runVoiceDiagnose({
        ...(opts.json === true ? { format: 'json' as const } : {}),
        ...(opts.wakeWord === true ? { wakeWord: true } : {}),
        ...(wakeWordThreshold !== undefined ? { wakeWordThreshold } : {}),
      });
      process.exit(result.exitCode);
    },
  );

voice
  .command('listen')
  .description(
    'Phase 6C — listen on the live mic for wake-word events. Press Ctrl-C to exit.',
  )
  .option('--json', 'Emit one JSON event per line instead of human output.')
  .option(
    '--threshold <n>',
    'Override the wake-word activation threshold (0..1, default from voice.wakeWordThreshold config).',
    (v) => Number.parseFloat(v),
  )
  .option(
    '--cooldown-ms <n>',
    'Override the post-fire cooldown in ms (default from voice.wakeWordCooldownMs config).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--sustain-frames <n>',
    'Override the sustain-frame count (default from voice.wakeWordSustainFrames config).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--max-events <n>',
    'Auto-exit after N wake-word events (default 0 = unbounded).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--model <name>',
    'Override the wake-word model name (default from voice.wakeWordModel config).',
  )
  .action(
    async (opts: {
      json?: boolean;
      threshold?: number;
      cooldownMs?: number;
      sustainFrames?: number;
      maxEvents?: number;
      model?: string;
    }) => {
      const { runVoiceListen } = await import('./cli/voice-listen.js');
      const threshold =
        opts.threshold !== undefined && Number.isFinite(opts.threshold)
          ? opts.threshold
          : undefined;
      const cooldownMs =
        opts.cooldownMs !== undefined && !Number.isNaN(opts.cooldownMs)
          ? opts.cooldownMs
          : undefined;
      const sustainFrames =
        opts.sustainFrames !== undefined && !Number.isNaN(opts.sustainFrames)
          ? opts.sustainFrames
          : undefined;
      const maxEvents =
        opts.maxEvents !== undefined && !Number.isNaN(opts.maxEvents)
          ? opts.maxEvents
          : undefined;
      // SIGINT (Ctrl-C) handling (audit-M3, mirrors the 3T two-tap pattern).
      // First Ctrl-C: abort the signal → runVoiceListen calls bridge.stop()
      // for a graceful mic release. Second Ctrl-C (impatient user during
      // the 2 s grace): force-kill the bridge's Python subprocess
      // synchronously, then exit 130. Without the second-tap force path,
      // a double Ctrl-C on Win32 (where SIGINT isn't delivered to the
      // child) orphans python.exe with the mic still open — a CLAUDE.md
      // cleanup violation.
      const abortController = new AbortController();
      let sigintCount = 0;
      let listenBridge: VoiceBridge | undefined;
      const onSigint = (): void => {
        sigintCount += 1;
        if (sigintCount === 1) {
          abortController.abort();
        } else {
          // Second press — don't wait for graceful stop. Force-kill the
          // child tree (Win32 taskkill / POSIX SIGKILL via forceStop) then
          // bail with the conventional 128+SIGINT(2) = 130 code.
          if (listenBridge !== undefined) {
            void listenBridge.stop({ graceMs: 0 }).catch(() => undefined);
          }
          process.exit(130);
        }
      };
      process.on('SIGINT', onSigint);
      try {
        const { VoiceBridge } = await import('./voice/bridge.js');
        listenBridge = new VoiceBridge();
        const result = await runVoiceListen({
          ...(opts.json === true ? { format: 'json' as const } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          ...(cooldownMs !== undefined ? { cooldownMs } : {}),
          ...(sustainFrames !== undefined ? { sustainFrames } : {}),
          ...(maxEvents !== undefined ? { maxEvents } : {}),
          ...(opts.model !== undefined ? { modelName: opts.model } : {}),
          bridgeFactory: () => listenBridge!,
          signal: abortController.signal,
        });
        process.exit(result.exitCode);
      } finally {
        process.off('SIGINT', onSigint);
      }
    },
  );

voice
  .command('transcribe <file>')
  .description(
    'Transcribe a 16kHz mono WAV or raw PCM file via Moonshine. Prints the joined transcript.',
  )
  .option('--json', 'Emit a single-line JSON summary instead of human output.')
  .option('--stt-model <name>', 'Override the Moonshine model (moonshine/base | moonshine/tiny).')
  .option('--partial-interval-ms <n>', 'Override the partial-transcription cadence (default: 200).', (v) =>
    Number.parseInt(v, 10),
  )
  .option(
    '--max-utterance-seconds <n>',
    'Override the hard-cap utterance length (default: 30).',
    (v) => Number.parseInt(v, 10),
  )
  .action(
    async (
      file: string,
      opts: {
        json?: boolean;
        sttModel?: string;
        partialIntervalMs?: number;
        maxUtteranceSeconds?: number;
      },
    ) => {
      const { runVoiceTranscribe } = await import('./cli/voice-transcribe.js');
      const sttModel =
        opts.sttModel === 'moonshine/base' || opts.sttModel === 'moonshine/tiny'
          ? opts.sttModel
          : undefined;
      const partialIntervalMs =
        opts.partialIntervalMs !== undefined && !Number.isNaN(opts.partialIntervalMs)
          ? opts.partialIntervalMs
          : undefined;
      const maxUtteranceSeconds =
        opts.maxUtteranceSeconds !== undefined && !Number.isNaN(opts.maxUtteranceSeconds)
          ? opts.maxUtteranceSeconds
          : undefined;
      const result = await runVoiceTranscribe({
        wavPath: file,
        ...(opts.json === true ? { format: 'json' as const } : {}),
        ...(sttModel !== undefined ? { sttModel } : {}),
        ...(partialIntervalMs !== undefined ? { partialIntervalMs } : {}),
        ...(maxUtteranceSeconds !== undefined ? { maxUtteranceSeconds } : {}),
      });
      process.exit(result.exitCode);
    },
  );

voice
  .command('capture')
  .description(
    'Phase 6D — always-capture: store VAD-gated transcripts in the rolling context buffer. Press Ctrl-C to stop.',
  )
  .option('--json', 'Emit one JSON line per stored chunk instead of human output.')
  .option(
    '--max-events <n>',
    'Auto-exit after N stored transcript chunks (default 0 = unbounded).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--max-seconds <n>',
    'Auto-exit after N seconds (default 0 = unbounded).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--pcm <file>',
    'Fixture mode: pipe a 16kHz mono PCM file instead of opening the mic (no microphone required).',
  )
  .action(
    async (opts: { json?: boolean; maxEvents?: number; maxSeconds?: number; pcm?: string }) => {
      const { runVoiceCapture } = await import('./cli/voice-capture.js');
      const maxEvents =
        opts.maxEvents !== undefined && !Number.isNaN(opts.maxEvents) ? opts.maxEvents : undefined;
      const maxSeconds =
        opts.maxSeconds !== undefined && !Number.isNaN(opts.maxSeconds) ? opts.maxSeconds : undefined;
      // SIGINT two-tap (mirrors `voice listen`, 6C audit-M3): first Ctrl-C
      // aborts gracefully (final compaction + clean teardown); second
      // force-kills the bridge's Python subprocess and exits 130 so a
      // double-press on Win32 can't orphan python.exe with the mic open.
      const abortController = new AbortController();
      let sigintCount = 0;
      let captureBridge: VoiceBridge | undefined;
      const onSigint = (): void => {
        sigintCount += 1;
        if (sigintCount === 1) {
          abortController.abort();
        } else {
          if (captureBridge !== undefined) {
            void captureBridge.stop({ graceMs: 0 }).catch(() => undefined);
          }
          process.exit(130);
        }
      };
      process.on('SIGINT', onSigint);
      try {
        const { VoiceBridge } = await import('./voice/bridge.js');
        captureBridge = new VoiceBridge();
        const result = await runVoiceCapture({
          ...(opts.json === true ? { format: 'json' as const } : {}),
          ...(maxEvents !== undefined ? { maxEvents } : {}),
          ...(maxSeconds !== undefined ? { maxSeconds } : {}),
          ...(opts.pcm !== undefined
            ? { inputMode: 'stdin-pcm' as const, fixturePath: opts.pcm }
            : {}),
          bridgeFactory: () => captureBridge!,
          signal: abortController.signal,
        });
        process.exit(result.exitCode);
      } finally {
        process.off('SIGINT', onSigint);
      }
    },
  );

program
  .command('mcp-server')
  .description('Run the Symphony orchestrator MCP server over stdio. Spawned as a child of claude -p.')
  .option('--in-memory', 'Skip the SQLite store; use in-memory registries only (Phase 2A behavior).')
  .option('--no-rpc', 'Skip starting the WebSocket RPC server (Phase 2B.2).')
  .option('--rpc-port <n>', 'Bind port for the RPC server (0 = ephemeral).', (v) => Number.parseInt(v, 10))
  .option('--rpc-token-file <path>', 'Path for the RPC descriptor JSON (default ~/.symphony/rpc.json).')
  .option('--default-project <path>', 'Absolute path to the default project (overrides cwd).')
  .option('--plugins', 'Activate the plugin host (Phase 7A). Only Maestro’s MCP child passes this.')
  .action(
    async (opts: {
      inMemory?: boolean;
      rpc?: boolean;
      rpcPort?: number;
      rpcTokenFile?: string;
      defaultProject?: string;
      plugins?: boolean;
    }) => {
      const { startOrchestratorServer, SymphonyDatabase } = await import('./orchestrator/index.js');
      const database = opts.inMemory ? undefined : SymphonyDatabase.open();
      let handle;
      try {
        const rpcEnabled = opts.rpc !== false;
        const rpcPort = opts.rpcPort;
        const rpcTokenFilePath = opts.rpcTokenFile;
        handle = await startOrchestratorServer({
          ...(database !== undefined ? { database } : {}),
          ...(opts.defaultProject !== undefined ? { defaultProjectPath: opts.defaultProject } : {}),
          ...(opts.plugins === true ? { plugins: { enabled: true } } : {}),
          rpc: rpcEnabled
            ? {
                enabled: true,
                ...(rpcPort !== undefined ? { port: rpcPort } : {}),
                ...(rpcTokenFilePath !== undefined ? { tokenFilePath: rpcTokenFilePath } : {}),
              }
            : { enabled: false },
        });
      } catch (err) {
        // Phase 2B.1 audit M6 — close the DB on server-start failure
        // so the WAL/SHM sidecars flush cleanly before the process exits.
        database?.close();
        throw err;
      }
      if (handle.rpc !== undefined) {
        // Single parseable line on stderr for clients that want to reach
        // the orchestrator without scraping `~/.symphony/rpc.json`.
        const rpc = handle.rpc;
        const advert = {
          event: 'symphony.rpc.ready',
          host: rpc.host,
          port: rpc.port,
          tokenFile: rpc.tokenFilePath ?? null,
        };
        console.error(`[symphony] ${JSON.stringify(advert)}`);
      }
      // Audit M5 (2B.2 review): hard deadline so a wedged WS client
      // can't block process exit indefinitely. SIGTERM should always
      // exit; if `handle.close()` doesn't drain in 5s, force-exit.
      const SHUTDOWN_DEADLINE_MS = 5_000;
      const shutdown = async (_signal: string) => {
        let exitCode = 0;
        const timer = setTimeout(() => {
          console.error(
            `[symphony] graceful close exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`,
          );
          process.exit(1);
        }, SHUTDOWN_DEADLINE_MS);
        timer.unref?.();
        try {
          await handle
            .close()
            .catch((e) => console.error('[symphony] server close failed:', e));
        } finally {
          try {
            database?.close();
          } catch (e) {
            console.error('[symphony] database close failed:', e);
            exitCode = 1;
          }
          clearTimeout(timer);
          process.exit(exitCode);
        }
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.stdin.on('close', () => void shutdown('stdin-close'));
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
