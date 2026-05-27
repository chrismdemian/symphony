"""Symphony voice vocabulary substitution (Phase 6B).

Loads layered JSON vocab files and produces a Substituter that rewrites
common dev-term mis-transcriptions before STT events leave the bridge
(e.g. spoken "use effect" -> written "useEffect").

Design notes:
- Two-tier merge: caller passes [user_global, project_local] (in that
  order). Project-local overrides user-global on key collision. This
  mirrors the documented merge order in PLAN.md Phase 6B.3.
- Single compiled regex over all spoken keys. Substitution is a single
  `re.sub` pass — sub-millisecond on typical utterances; deterministic.
- `\\b` word boundaries on both sides so "npm install" doesn't
  substitute inside "pnpm install".
- Case-insensitive matching: Moonshine emits lowercase punctuation-free
  text typically, but a user might add capitalized spoken forms.
- Empty merged dict -> identity apply (no regex compile, no work). Guards
  against `re.compile(r"\\b\\b")` always-match foot-gun.
- Bad files (missing, permission, malformed JSON, wrong shape) -> log to
  stderr, skip that layer, continue. The bridge MUST NOT crash on a bad
  vocab file.
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Iterable


# Vocab file shape:
#   {
#     "version": 1,
#     "substitutions": {
#       "<spoken phrase>": "<written replacement>",
#       ...
#     }
#   }
#
# Top-level keys other than "substitutions" / "version" are ignored.
# Spoken keys are lowercased on load (regex is case-insensitive) so the
# user can write either form. Both spoken and written must be non-empty
# strings; other shapes are dropped with a stderr warning.
SUPPORTED_VERSIONS: frozenset[int] = frozenset({1})


@dataclass(frozen=True)
class SubstitutionLoadStat:
    """Per-file load outcome — exposed for test assertions / diagnostics."""

    path: str
    loaded: bool
    entry_count: int
    skip_reason: str = ""


class Substituter:
    """Applies the merged vocab map to a text string.

    Construct via `load_vocab(paths)`. The empty-map case stays cheap:
    no regex is compiled and `apply()` returns its argument verbatim.
    """

    def __init__(self, merged: dict[str, str]) -> None:
        # Dedup happens implicitly at merge time (the layered loader uses
        # dict.update); here we just trust the input.
        self._merged: dict[str, str] = dict(merged)
        if self._merged:
            # Sort keys by descending length so the regex alternation
            # prefers longer matches (e.g. "ts config json" before
            # "ts config"). Python's re picks the FIRST matching
            # alternative, so order matters.
            keys_sorted = sorted(self._merged.keys(), key=len, reverse=True)
            pattern = r"\b(" + "|".join(re.escape(k) for k in keys_sorted) + r")\b"
            self._regex: re.Pattern[str] | None = re.compile(pattern, re.IGNORECASE)
        else:
            self._regex = None

    @property
    def is_empty(self) -> bool:
        return self._regex is None

    @property
    def entry_count(self) -> int:
        return len(self._merged)

    def apply(self, text: str) -> str:
        """Return `text` with all vocab substitutions applied.

        Returns the input verbatim when the merged map is empty.
        """
        if self._regex is None or not text:
            return text
        merged = self._merged

        def _replace(match: re.Match[str]) -> str:
            spoken = match.group(1).lower()
            return merged.get(spoken, match.group(0))

        return self._regex.sub(_replace, text)


def load_vocab(paths: Iterable[str]) -> tuple[Substituter, list[SubstitutionLoadStat]]:
    """Load layered vocab files; later layers override earlier ones.

    Returns the configured ``Substituter`` plus per-file load stats so
    the bridge / diagnose CLI can log what was loaded vs skipped.
    """
    merged: dict[str, str] = {}
    stats: list[SubstitutionLoadStat] = []
    for path in paths:
        stat = _load_one_into(path, merged)
        stats.append(stat)
    return Substituter(merged), stats


def _load_one_into(path: str, merged: dict[str, str]) -> SubstitutionLoadStat:
    """Read one file, merge its substitutions into `merged`, return stats."""
    if not path:
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="empty-path")
    if not os.path.exists(path):
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="missing")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as e:
        _warn(f"voice_vocab: cannot read {path}: {e!r}")
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason=f"read-failed:{type(e).__name__}")
    if not raw.strip():
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="empty-file")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        _warn(f"voice_vocab: invalid JSON in {path}: {e.msg} at line {e.lineno}")
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="malformed-json")
    if not isinstance(data, dict):
        _warn(f"voice_vocab: {path} root is not an object — dropped")
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="non-object-root")
    version = data.get("version")
    if version is not None and version not in SUPPORTED_VERSIONS:
        _warn(f"voice_vocab: {path} version {version!r} not in {sorted(SUPPORTED_VERSIONS)} — dropped")
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="unsupported-version")
    subs = data.get("substitutions", {})
    if not isinstance(subs, dict):
        _warn(f"voice_vocab: {path}.substitutions is not an object — dropped")
        return SubstitutionLoadStat(path=path, loaded=False, entry_count=0,
                                    skip_reason="non-object-substitutions")
    added = 0
    for spoken, written in subs.items():
        if not isinstance(spoken, str) or not isinstance(written, str):
            _warn(f"voice_vocab: {path} entry {spoken!r} -> {written!r} not (str,str) — dropped")
            continue
        spoken_key = spoken.strip().lower()
        written_val = written  # written casing preserved verbatim
        if not spoken_key or not written_val:
            _warn(f"voice_vocab: {path} entry {spoken!r} -> {written!r} empty after strip — dropped")
            continue
        merged[spoken_key] = written_val
        added += 1
    return SubstitutionLoadStat(path=path, loaded=True, entry_count=added)


def _warn(msg: str) -> None:
    """Diagnostic to stderr — Node-side prefixes every line with `[voice-bridge] `."""
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()
