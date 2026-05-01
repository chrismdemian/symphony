# TUI Visual Verification Harness

Renders Symphony's Ink components under canonical states, dumps the
captured frames to `.visual-frames/`, and lets a separate skeptical
subagent grade the output. Authors NEVER review their own UI work
(per `~/CLAUDE.md` § "TUI Visual Verification" + `<repo>/CLAUDE.md`).

## How to use

```bash
pnpm visual:3b1            # regenerate frames for Phase 3B.1
ls .visual-frames/         # 12 scenarios × {.ansi.txt, .plain.txt} + INDEX.md
```

Each scenario gets two files:

- `*.ansi.txt` — keeps the raw ANSI escape sequences. Grep for hex
  codes (`\x1b[38;2;124;111;235m` = violet `#7C6FEB`,
  `\x1b[7m` = inverse cursor, etc.) when the reviewer needs to
  verify color hierarchy.
- `*.plain.txt` — strips ANSI for human-readable review.

Plus an `INDEX.md` listing every scenario with a one-line description.

## Why a separate launcher (`run.mjs`)

`ink-testing-library`'s fake stdout doesn't claim TTY support, so
chalk emits zero ANSI by default. ESM hoisting blocks setting
`FORCE_COLOR=3` inside the harness file (chalk resolves its level
at import time, before user code runs). The launcher spawns the
harness as a child process with the env vars set at process boot,
which is the only seam that works cross-platform without
`cross-env`.

## Adding a new phase

1. Copy `3b1-frames.tsx` to `<phase>-frames.tsx`. Update the
   `SCENARIOS` array to cover the design spec — empty / streaming /
   error / typed input / multi-line / multi-turn — at minimum.
2. Add to `package.json`:

   ```json
   "visual:<phase>": "node tests/visual/run.mjs tests/visual/<phase>-frames.tsx"
   ```

3. Run `pnpm visual:<phase>`, then delegate review to a fresh skeptical
   subagent (Opus, fresh context). Provide the palette hex codes and
   the scenario list.
4. Fix Critical + Major findings. Regenerate. Re-review. Iterate.

## When the current stack falls short — upgrade trigger

`ink-testing-library` + `FORCE_COLOR=3` covers static frame snapshots.
It does NOT cover:

- **Frame-over-time animation** — Phase 3B.3's Equalizer (sine-staggered
  4-column EQ at 90 ms tick) and ShimmerText (24 phase-shifted gradients
  at 100 ms tick). Static `lastFrame()` doesn't tick `useAnimation`.
  `vi.useFakeTimers` + `vi.advanceTimersByTime` MAY work — verify when
  3B.3 lands.
- **Alt-screen / kitty-keyboard state** — 3B.3's kitty protocol push/pop
  (`\x1b[>3u` / `\x1b[<u`). `ink-testing-library` doesn't model
  alt-screen toggling.
- **Real cursor position** — 3B.2's scrolling needs "is the cursor in
  the visible viewport" not just "is it in the buffer."
- **Per-cell color metadata** — when the reviewer wants
  "is character X at row Y col Z violet on a black background, bold,"
  not a raw escape sequence.

When any of these become a blocker, install:

```bash
pnpm add -D @xterm/headless @xterm/addon-serialize node-pty
# Windows: prefer `@lydell/node-pty` to skip the VS Build Tools install
```

The upgrade pattern (sketch):

```ts
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { spawn } from 'node-pty';

const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
const ser = new SerializeAddon();
term.loadAddon(ser);

const pty = spawn(process.execPath, ['dist/index.js', 'start'], {
  name: 'xterm-256color', cols: 120, rows: 32, env: process.env,
});
pty.onData((d) => term.write(d));

await waitForRegex(term, /Ready/);
pty.write('hello\r');

// (a) ANSI replay (small, restorable)
const ansi = ser.serialize();
// (b) Plain text (token-cheap for the agent)
// (c) Per-cell { char, fg, bg, bold, italic } via `term.buffer.active.getLine(y).getCell(x)`
```

DON'T preemptively install. Wait until a blocker hits — premature
adoption pays the native-module cost (Windows install friction, CI
build) for benefits we don't currently need.

## Tools also evaluated, NOT chosen

- **VHS** (Charm, `charmbracelet/vhs`) — declarative `.tape` scripts
  → GIF / PNG / `.txt`. Native Windows is flaky in 2026 (multiple
  open issues); Docker path works. Use for marketing demos, NOT CI.
- **asciinema** — Linux + macOS only (no Windows binary as of
  2026-04). Records to NDJSON; agent-readable but verbose.
- **terminalizer** — looks abandoned; install issues open since
  2018. Skip.
- **freeze** (Charm) — beautiful PNG/SVG screenshots of code or
  terminal output, but requires external screen-scrape feed (e.g.,
  `tmux capture-pane`). Awkward in CI. Use for documentation
  screenshots, not testing.

Sources for the comparison are archived in the visual verification
research thread; if you need to revisit, ask Claude to re-run the
"Terminal screenshot tools research" agent prompt.
