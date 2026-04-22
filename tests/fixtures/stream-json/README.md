# stream-json fixtures

Hand-crafted NDJSON fixtures mirroring the on-the-wire shape of
`claude -p --output-format stream-json --verbose` output. Used by
`tests/workers/stream-parser.fixtures.test.ts`.

Shapes match the `claudeSDKMessage` struct reverse-engineered in
`research/repos/multica/server/pkg/agent/claude.go` plus the Phase 4E
worker completion report contract.

Each fixture is a full session — `system/init` → work → `result`.

| File | Covers |
|---|---|
| `happy-path.ndjson` | Minimal session: init → text → result |
| `tool-use-turn.ndjson` | assistant tool_use → user tool_result → follow-up text |
| `api-retry.ndjson` | Repeated `system/api_retry` events before recovery |
| `malformed-mixed.ndjson` | Broken + unknown lines interleaved with valid ones |
| `structured-completion.ndjson` | Final assistant turn carries a valid Phase 4E JSON report fence |

To add a real captured session later:

```bash
claude -p --output-format stream-json --input-format stream-json \
  --verbose --strict-mcp-config \
  --permission-mode bypassPermissions \
  <<<'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say hi"}]}}' \
  > tests/fixtures/stream-json/real-<name>.ndjson
```

Commit only if the session is small (< 50 KB), redacted of any
session-specific secrets, and deterministic enough to assert on.
