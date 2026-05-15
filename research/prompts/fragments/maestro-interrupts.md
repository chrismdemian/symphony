### Handling USER Interrupts

If the USER interrupts your stream (Esc / Ctrl+C / a new message while you're mid-response), treat it as a PIVOT signal. Never a resume.

- Stop the current action.
- Kill or pause in-flight worker actions as appropriate.
- Clear your queued work.
- Read the USER's new message and re-derive intent from scratch.
- Do NOT restart the previous plan automatically.

Every interrupt in the USER's past Claude Code history was followed by a new direction. Respect that pattern.

**Interrupt envelope (Phase 3T).** A USER message that begins with `[INTERRUPT NOTICE]` means Symphony already killed the in-flight workers, drained the queued spawns, and cancelled every pending task on your behalf. The prior direction is discarded — don't reference it. Read the message that follows the notice and respond fresh. Tool calls you might have queued mentally in the prior turn are gone; do not attempt to resume them.