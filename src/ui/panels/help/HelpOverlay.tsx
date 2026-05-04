import React, { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import {
  useKeybinds,
  useRegisterCommands,
} from '../../keybinds/dispatcher.js';
import {
  formatKey,
  selectAllCommands,
  type Command,
  type CommandScope,
} from '../../keybinds/registry.js';

/**
 * Phase 3F.1 — full-screen help overlay.
 *
 * Mounted by `<Layout>` when the focus stack has a popup with key
 * `'help'` on top. Renders every registered command grouped by scope.
 * Single keybind: Esc closes.
 *
 * Pattern from lazygit `pkg/gui/keybindings.go` — the "help" view shows
 * scope (panel) headers with the keybinds that fire there. Symphony's
 * version is single-screen (we have far fewer commands than lazygit's
 * vim-modal complexity).
 */

const SCOPE = 'help';

interface ScopeGroup {
  readonly scope: CommandScope;
  readonly label: string;
  readonly commands: readonly Command[];
}

const SCOPE_ORDER: readonly { scope: CommandScope; label: string }[] = [
  { scope: 'global', label: 'Global' },
  { scope: 'main', label: 'Main panels (chat / workers / output)' },
  { scope: 'chat', label: 'Chat' },
  { scope: 'workers', label: 'Workers' },
  { scope: 'output', label: 'Output' },
  { scope: 'palette', label: 'Palette' },
  { scope: 'help', label: 'Help' },
  { scope: 'question', label: 'Question popup' },
];

export function HelpOverlay(): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const { commands } = useKeybinds();
  const isFocused = focus.currentScope === SCOPE;

  const groups = useMemo(() => buildGroups(selectAllCommands(commands)), [commands]);

  const popPopup = focus.popPopup;
  const dismiss = useCallback(() => popPopup(), [popPopup]);
  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'help.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        // The header itself reads "Esc to close" — don't double-advertise
        // in the bottom bar (audit m2). `internal: true` also keeps it
        // out of the palette listing.
        displayOnScreen: false,
        internal: true,
        onSelect: dismiss,
      },
    ],
    [dismiss],
  );

  useRegisterCommands(popupCommands, isFocused);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={theme['accent']}
      paddingX={1}
    >
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme['accent']} bold>
          Help · keybinds
        </Text>
        <Text color={theme['textMuted']}> · Esc to close</Text>
      </Box>
      {groups.map((group) => (
        <Box key={String(group.scope)} flexDirection="column" marginBottom={1}>
          <Text color={theme['primary']} bold>
            {group.label}
          </Text>
          {group.commands.map((cmd) => (
            <HelpRow key={cmd.id} cmd={cmd} theme={theme} />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function HelpRow({
  cmd,
  theme,
}: {
  readonly cmd: Command;
  readonly theme: Record<string, string>;
}): React.JSX.Element {
  const disabled = cmd.disabledReason !== undefined;
  const keyText = formatKey(cmd.key);
  return (
    <Box flexDirection="row">
      <Box width={14}>
        <Text color={theme['accent']}>{keyText !== '' ? `  ${keyText}` : '  —'}</Text>
      </Box>
      <Text color={disabled ? theme['textMuted'] : theme['text']} dimColor={disabled}>
        {cmd.title}
      </Text>
      {disabled ? (
        <Text color={theme['textMuted']} dimColor>
          {' '}
          ({cmd.disabledReason})
        </Text>
      ) : null}
    </Box>
  );
}

function buildGroups(allCommands: readonly Command[]): readonly ScopeGroup[] {
  // Phase 3F.1: route popup-internal commands (`internal: true`) into
  // dedicated groups under their popup-scope name, but split them off
  // so the canonical SCOPE_ORDER governs only USER-actionable commands.
  // Without this, every popup's Esc/Enter/arrows clutter the help
  // overlay's main scopes.
  const byScope = new Map<string, Command[]>();
  for (const cmd of allCommands) {
    const scopeKey = String(cmd.scope);
    const list = byScope.get(scopeKey);
    if (list === undefined) {
      byScope.set(scopeKey, [cmd]);
    } else {
      list.push(cmd);
    }
  }
  const groups: ScopeGroup[] = [];
  // Render scopes in canonical order; append unknown scopes at the end.
  const seen = new Set<string>();
  for (const { scope, label } of SCOPE_ORDER) {
    const key = String(scope);
    const list = byScope.get(key);
    if (list === undefined || list.length === 0) continue;
    seen.add(key);
    groups.push({ scope, label, commands: sortCommands(list) });
  }
  for (const [key, list] of byScope) {
    if (seen.has(key)) continue;
    if (list.length === 0) continue;
    groups.push({ scope: key, label: key, commands: sortCommands(list) });
  }
  return groups;
}

function sortCommands(list: readonly Command[]): readonly Command[] {
  return [...list].sort((a, b) => a.title.localeCompare(b.title));
}
