import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider } from '../../src/ui/focus/focus.js';
import { KeybindProvider, useKeybinds } from '../../src/ui/keybinds/dispatcher.js';
import type { Command } from '../../src/ui/keybinds/registry.js';
import { Text } from 'ink';

/**
 * Phase 3F.2 — leader-chord dispatcher integration tests.
 *
 * Validates: arming on lead, firing on second match, timeout clearing,
 * non-leader command suppression while armed, and leader hint exposure
 * via `useKeybinds().leaderActive`.
 */

const CTRL_X = '\x18';

interface ProbeProps {
  readonly setRef: (cb: () => string | null) => void;
}

function LeaderProbe({ setRef }: ProbeProps): React.JSX.Element {
  const { leaderActive } = useKeybinds();
  React.useEffect(() => {
    setRef(() => {
      if (leaderActive === null) return null;
      if (leaderActive.kind === 'ctrl') return `Ctrl+${leaderActive.char.toUpperCase()}`;
      return leaderActive.kind;
    });
  }, [leaderActive, setRef]);
  return <Text>probe</Text>;
}

describe('KeybindProvider — leader-chord dispatch', () => {
  it('Ctrl+X then m fires a leader command', async () => {
    const fired = vi.fn();
    const cmd: Command = {
      id: 'leader.modeSwitch',
      title: 'mode',
      key: {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'm' },
      },
      scope: 'global',
      displayOnScreen: false,
      onSelect: fired,
    };
    let getLeader: () => string | null = () => null;
    const { stdin } = render(
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider initialCommands={[cmd]} leaderTimeoutMs={500}>
            <LeaderProbe setRef={(cb) => (getLeader = cb)} />
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(CTRL_X);
    await new Promise((r) => setTimeout(r, 50));
    expect(getLeader()).toBe('Ctrl+X'); // armed
    expect(fired).not.toHaveBeenCalled();

    stdin.write('m');
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toHaveBeenCalledTimes(1);
    expect(getLeader()).toBeNull(); // cleared after fire
  });

  it('leader times out after timeoutMs without second keystroke', async () => {
    const fired = vi.fn();
    const cmd: Command = {
      id: 'leader.modeSwitch',
      title: 'mode',
      key: {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'm' },
      },
      scope: 'global',
      displayOnScreen: false,
      onSelect: fired,
    };
    let getLeader: () => string | null = () => null;
    const { stdin } = render(
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider initialCommands={[cmd]} leaderTimeoutMs={100}>
            <LeaderProbe setRef={(cb) => (getLeader = cb)} />
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(CTRL_X);
    await new Promise((r) => setTimeout(r, 50));
    expect(getLeader()).toBe('Ctrl+X');

    // Wait beyond the timeout (cushion for timer dispatch + re-render).
    await new Promise((r) => setTimeout(r, 350));
    expect(getLeader()).toBeNull();

    // Second keystroke after timeout does NOT fire the leader command.
    stdin.write('m');
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).not.toHaveBeenCalled();
  });

  it('non-leader commands are suppressed while leader is armed', async () => {
    const leaderFired = vi.fn();
    const charFired = vi.fn();
    const leaderCmd: Command = {
      id: 'leader',
      title: 'leader',
      key: {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'a' },
      },
      scope: 'global',
      displayOnScreen: false,
      onSelect: leaderFired,
    };
    const charCmd: Command = {
      id: 'plain',
      title: 'plain',
      key: { kind: 'char', char: 'm' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: charFired,
    };
    const { stdin } = render(
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider initialCommands={[leaderCmd, charCmd]} leaderTimeoutMs={500}>
            <Text>x</Text>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(CTRL_X);
    await new Promise((r) => setTimeout(r, 50));
    // While armed, pressing `m` should NOT fire the plain `m` command —
    // it's a stray second-key for the armed leader (which doesn't have
    // a leader{lead:Ctrl+X, second:m} entry, so it's a no-op + clear).
    stdin.write('m');
    await new Promise((r) => setTimeout(r, 50));
    expect(charFired).not.toHaveBeenCalled();
    expect(leaderFired).not.toHaveBeenCalled();
  });

  it('after a non-matching second keystroke, leader clears so subsequent presses work normally', async () => {
    const charFired = vi.fn();
    const leaderCmd: Command = {
      id: 'leader',
      title: 'leader',
      key: {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'a' },
      },
      scope: 'global',
      displayOnScreen: false,
      onSelect: () => undefined,
    };
    const charCmd: Command = {
      id: 'plain',
      title: 'plain',
      key: { kind: 'char', char: 'q' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: charFired,
    };
    const { stdin } = render(
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider initialCommands={[leaderCmd, charCmd]} leaderTimeoutMs={500}>
            <Text>x</Text>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(CTRL_X);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('q'); // second is non-matching → should clear leader, NOT fire plain `q`
    await new Promise((r) => setTimeout(r, 50));
    expect(charFired).not.toHaveBeenCalled();

    // Now press `q` again — leader should be cleared, plain `q` fires.
    stdin.write('q');
    await new Promise((r) => setTimeout(r, 50));
    expect(charFired).toHaveBeenCalledTimes(1);
  });

  it('two back-to-back writes within one JS frame still fire the leader (audit C1)', async () => {
    // Pre-fix, the ref-mirror was updated via useEffect (passive —
    // fires AFTER the frame). Two writes in the same frame triggered
    // two synchronous useInput callbacks; the second read stale
    // `armed=null` because React hadn't yet re-rendered. Post-fix,
    // the dispatch path syncs `leaderActiveRef` synchronously inside
    // the callback so the second call sees the freshly-armed state.
    const fired = vi.fn();
    const cmd: Command = {
      id: 'leader.modeSwitch',
      title: 'mode',
      key: {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'm' },
      },
      scope: 'global',
      displayOnScreen: false,
      onSelect: fired,
    };
    const { stdin } = render(
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider initialCommands={[cmd]} leaderTimeoutMs={500}>
            <Text>x</Text>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    // Two writes with NO await between — each emits 'readable'
    // synchronously inside Ink's stdin handler, so both useInput
    // callbacks fire in the same JS frame before React commits the
    // first arm-dispatch.
    stdin.write(CTRL_X);
    stdin.write('m');
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('two leader commands share the same lead and dispatch on different seconds', async () => {
    const mFired = vi.fn();
    const tFired = vi.fn();
    const cmds: Command[] = [
      {
        id: 'leader.m',
        title: 'mode',
        key: {
          kind: 'leader',
          lead: { kind: 'ctrl', char: 'x' },
          second: { kind: 'char', char: 'm' },
        },
        scope: 'global',
        displayOnScreen: false,
        onSelect: mFired,
      },
      {
        id: 'leader.t',
        title: 'theme',
        key: {
          kind: 'leader',
          lead: { kind: 'ctrl', char: 'x' },
          second: { kind: 'char', char: 't' },
        },
        scope: 'global',
        displayOnScreen: false,
        onSelect: tFired,
      },
    ];
    const { stdin } = render(
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider initialCommands={cmds} leaderTimeoutMs={500}>
            <Text>x</Text>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(CTRL_X);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('m');
    await new Promise((r) => setTimeout(r, 50));
    expect(mFired).toHaveBeenCalledTimes(1);
    expect(tFired).not.toHaveBeenCalled();

    stdin.write(CTRL_X);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('t');
    await new Promise((r) => setTimeout(r, 50));
    expect(tFired).toHaveBeenCalledTimes(1);
  });
});
