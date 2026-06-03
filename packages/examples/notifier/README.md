# Notifier — example Symphony plugin

The reference plugin for `@symphony/plugin-sdk`. It demonstrates the plugin
capabilities in ~90 lines:

- **Event handlers** — subscribes to `onTaskCreated` / `onTaskCompleted` /
  `onTaskFailed` / `onWorkerSpawned` and appends a line to a log file. These
  `on_<event>` tools are kept out of Maestro's toolbelt by the host (Phase 7B.3).
- **A tool** — `notifier_status` returns the most recent notifications. It
  declares a `task:read` per-tool permission (a subset of the manifest grant),
  which the host enforces fail-closed at load time (Phase 7B.3).

## Build & install

```bash
pnpm --filter @symphony/plugin-notifier-example build
symphony plugin install packages/examples/notifier
symphony plugin enable notifier-example
# enable the master switch too:
symphony config set pluginsEnabled true   # or via the settings UI
```

Then restart Symphony. When a task completes, a line is written to
`$SYMPHONY_NOTIFIER_LOG` (default `<tmpdir>/symphony-notifier.log`), and
Maestro can call `notifier_example__notifier_status` to read recent activity.

## How it maps to the SDK

```ts
await createPlugin({ id, name, version })
  .tool({ name, description, inputSchema, permissions, handler })  // a callable tool
  .onTaskCreated((e) => { /* e.taskId, e.projectId, e.description */ })
  .onTaskCompleted((e) => { /* e.taskId, e.projectId */ })
  .onTaskFailed((e) => { /* ... */ })
  .onWorkerSpawned((e) => { /* e.workerId, e.role, e.projectId */ })
  .serve();                                            // stdio MCP server
```

`plugin.json` is the install-time consent record: it declares the spawn
recipe (`node dist/index.js`), the `notify:send` + `task:read` permissions, and
the events this plugin subscribes to. Symphony validates it on install.
