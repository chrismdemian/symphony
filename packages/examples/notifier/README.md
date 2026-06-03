# Notifier — example Symphony plugin

The reference plugin for `@symphony/plugin-sdk`. It demonstrates both plugin
capabilities in ~80 lines:

- **Event handlers** — subscribes to `onTaskCompleted` / `onTaskFailed` and
  appends a line to a log file.
- **A tool** — `notifier_status` returns the most recent notifications.

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
  .tool({ name, description, inputSchema, handler })   // a callable tool
  .onTaskCompleted((e) => { /* e.taskId, e.projectId */ })
  .onTaskFailed((e) => { /* ... */ })
  .serve();                                            // stdio MCP server
```

`plugin.json` is the install-time consent record: it declares the spawn
recipe (`node dist/index.js`), the `notify:send` permission, and the two
events this plugin subscribes to. Symphony validates it on install.
