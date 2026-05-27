"""pytest / unittest suite for ``voice_vocab.py``.

Runs against the on-disk source dir (no venv required for this file —
no native deps: ``json``, ``os``, ``re``, ``sys`` are stdlib only).

Run via the voice venv's pytest:
    ~/.symphony/voice-env/bin/pytest tests/voice/python/test_voice_vocab.py

Or against system Python with unittest (no extra installs):
    python -m unittest tests.voice.python.test_voice_vocab
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parents[2] / "src" / "voice" / "python"
sys.path.insert(0, str(SRC_DIR))

from voice_vocab import (  # noqa: E402
    Substituter,
    SubstitutionLoadStat,
    load_vocab,
)


def _write_vocab(tmpdir: str, name: str, payload: object) -> str:
    p = os.path.join(tmpdir, name)
    with open(p, "w", encoding="utf-8") as fh:
        if isinstance(payload, str):
            fh.write(payload)
        else:
            json.dump(payload, fh)
    return p


class SubstituterBasicTests(unittest.TestCase):
    def test_empty_merged_is_identity(self):
        sub = Substituter({})
        self.assertTrue(sub.is_empty)
        self.assertEqual(sub.apply("hello world"), "hello world")
        self.assertEqual(sub.entry_count, 0)

    def test_empty_merged_skips_regex_compile(self):
        """Audit-m13 regression: empty merged dict MUST NOT compile
        a `\\b\\b` always-match regex. The implementation skips the
        compile entirely; this test locks that behavior so a future
        refactor doesn't reintroduce the always-match foot-gun."""
        sub = Substituter({})
        # Private attribute access is the cleanest test seam for the
        # compile-skipped behavior; `is_empty` already covers the
        # observable contract.
        self.assertIsNone(sub._regex)  # noqa: SLF001 - intentional probe

    def test_simple_substitution(self):
        sub = Substituter({"use effect": "useEffect"})
        self.assertEqual(sub.apply("call use effect inside"), "call useEffect inside")

    def test_case_insensitive_match(self):
        sub = Substituter({"use effect": "useEffect"})
        self.assertEqual(sub.apply("Use Effect at top"), "useEffect at top")

    def test_word_boundary_left(self):
        # "pnpm install" must not match the "npm" inside it.
        sub = Substituter({"npm": "npm-replaced"})
        self.assertEqual(sub.apply("run pnpm install"), "run pnpm install")

    def test_word_boundary_right(self):
        # "useEffective" must not match "use effect".
        sub = Substituter({"use effect": "useEffect"})
        self.assertEqual(sub.apply("useEffective things"), "useEffective things")

    def test_multiple_substitutions_in_one_string(self):
        sub = Substituter({"use effect": "useEffect", "use state": "useState"})
        self.assertEqual(
            sub.apply("call use effect and use state please"),
            "call useEffect and useState please",
        )

    def test_longer_match_preferred_when_overlapping(self):
        # "ts config json" should win over "ts config" when both apply.
        sub = Substituter({"ts config": "tsconfig", "ts config json": "tsconfig.json"})
        self.assertEqual(sub.apply("edit ts config json now"), "edit tsconfig.json now")

    def test_empty_input_is_identity(self):
        sub = Substituter({"use effect": "useEffect"})
        self.assertEqual(sub.apply(""), "")

    def test_apply_does_not_recurse(self):
        # Output of one substitution must NOT feed back into the regex.
        sub = Substituter({"a": "ab", "ab": "ac"})
        # If recursive: "a" -> "ab" -> "ac". Non-recursive: a single pass
        # treats both alternatives independently; longer match first sees
        # only "a" in input "a", emits "ab", regex doesn't reapply.
        self.assertEqual(sub.apply("a"), "ab")

    def test_regex_metacharacters_in_spoken_key_escaped(self):
        # User might write spoken keys with regex metas; they must be
        # treated as literals.
        sub = Substituter({"a.b": "DOT", "c+d": "PLUS"})
        self.assertEqual(sub.apply("see a.b and c+d done"), "see DOT and PLUS done")


class LoadVocabTests(unittest.TestCase):
    def test_load_single_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", {
                "version": 1,
                "substitutions": {"use effect": "useEffect"},
            })
            sub, stats = load_vocab([p])
            self.assertEqual(len(stats), 1)
            self.assertTrue(stats[0].loaded)
            self.assertEqual(stats[0].entry_count, 1)
            self.assertEqual(sub.apply("hi use effect bye"), "hi useEffect bye")

    def test_missing_file_skipped_no_crash(self):
        sub, stats = load_vocab(["/does/not/exist.json"])
        self.assertEqual(len(stats), 1)
        self.assertFalse(stats[0].loaded)
        self.assertEqual(stats[0].skip_reason, "missing")
        self.assertTrue(sub.is_empty)

    def test_malformed_json_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", "{ this is not json")
            sub, stats = load_vocab([p])
            self.assertFalse(stats[0].loaded)
            self.assertEqual(stats[0].skip_reason, "malformed-json")
            self.assertTrue(sub.is_empty)

    def test_non_object_root_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", ["not", "an", "object"])
            sub, stats = load_vocab([p])
            self.assertFalse(stats[0].loaded)
            self.assertEqual(stats[0].skip_reason, "non-object-root")
            self.assertTrue(sub.is_empty)

    def test_unsupported_version_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", {
                "version": 2,
                "substitutions": {"x": "Y"},
            })
            sub, stats = load_vocab([p])
            self.assertFalse(stats[0].loaded)
            self.assertEqual(stats[0].skip_reason, "unsupported-version")

    def test_substitutions_not_object_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", {
                "version": 1,
                "substitutions": ["use effect", "useEffect"],
            })
            sub, stats = load_vocab([p])
            self.assertFalse(stats[0].loaded)
            self.assertEqual(stats[0].skip_reason, "non-object-substitutions")

    def test_empty_file_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", "")
            sub, stats = load_vocab([p])
            self.assertFalse(stats[0].loaded)
            self.assertEqual(stats[0].skip_reason, "empty-file")

    def test_non_string_entries_dropped_silently_within_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", {
                "version": 1,
                "substitutions": {
                    "use effect": "useEffect",   # valid
                    "use state": 42,             # written non-string => drop
                    "use ref": "",               # empty written => drop
                    "  ": "X",                   # empty spoken after strip => drop
                },
            })
            sub, stats = load_vocab([p])
            self.assertTrue(stats[0].loaded)
            self.assertEqual(stats[0].entry_count, 1)
            self.assertEqual(sub.apply("use effect"), "useEffect")
            # Other entries dropped — passthrough.
            self.assertEqual(sub.apply("use state"), "use state")

    def test_two_tier_merge_project_overrides_global(self):
        with tempfile.TemporaryDirectory() as tmp:
            global_path = _write_vocab(tmp, "global.json", {
                "version": 1,
                "substitutions": {"main row": "Maestro", "pull request": "PR"},
            })
            project_path = _write_vocab(tmp, "project.json", {
                "version": 1,
                "substitutions": {"main row": "Conductor"},  # overrides
            })
            sub, stats = load_vocab([global_path, project_path])
            self.assertEqual(len(stats), 2)
            self.assertTrue(all(s.loaded for s in stats))
            # Project wins for "main row"
            self.assertEqual(sub.apply("main row says hi"), "Conductor says hi")
            # Global-only key still survives
            self.assertEqual(sub.apply("send pull request"), "send PR")

    def test_cross_tier_longest_match_preference(self):
        """Audit-m18: longest-match preference must hold ACROSS tiers
        as well as within one tier. If global has the shorter key and
        project has the longer key, the regex alternation should still
        prefer the longer match."""
        with tempfile.TemporaryDirectory() as tmp:
            global_path = _write_vocab(tmp, "g.json", {
                "version": 1,
                "substitutions": {"ts config": "tsconfig"},
            })
            project_path = _write_vocab(tmp, "p.json", {
                "version": 1,
                "substitutions": {"ts config json": "tsconfig.json"},
            })
            sub, _ = load_vocab([global_path, project_path])
            # Longer key (cross-tier) wins
            self.assertEqual(sub.apply("edit ts config json now"),
                             "edit tsconfig.json now")
            # Shorter key (global) still substitutes when it appears alone
            self.assertEqual(sub.apply("edit ts config now"),
                             "edit tsconfig now")

    def test_load_order_matters(self):
        # Reverse order from above: project FIRST, global SECOND -> global wins.
        with tempfile.TemporaryDirectory() as tmp:
            project_path = _write_vocab(tmp, "p.json", {
                "version": 1,
                "substitutions": {"main row": "Conductor"},
            })
            global_path = _write_vocab(tmp, "g.json", {
                "version": 1,
                "substitutions": {"main row": "Maestro"},
            })
            sub, _ = load_vocab([project_path, global_path])
            self.assertEqual(sub.apply("main row"), "Maestro")

    def test_empty_paths_iterable(self):
        sub, stats = load_vocab([])
        self.assertEqual(stats, [])
        self.assertTrue(sub.is_empty)
        self.assertEqual(sub.apply("anything"), "anything")

    def test_spoken_key_case_normalized_at_load(self):
        # Mixed-case spoken keys are lowercased so the regex (case-insensitive)
        # can look them up consistently.
        with tempfile.TemporaryDirectory() as tmp:
            p = _write_vocab(tmp, "v.json", {
                "version": 1,
                "substitutions": {"Use Effect": "useEffect"},
            })
            sub, _ = load_vocab([p])
            self.assertEqual(sub.apply("use effect"), "useEffect")
            self.assertEqual(sub.apply("USE EFFECT"), "useEffect")


class EdgeCaseTests(unittest.TestCase):
    def test_substituter_dedup_at_construction(self):
        # Constructing directly with a dict (rather than via load_vocab)
        # — duplicates in source dict already collapsed by Python.
        sub = Substituter({"x": "Y"})
        self.assertEqual(sub.entry_count, 1)

    def test_no_match_returns_input_verbatim(self):
        sub = Substituter({"use effect": "useEffect"})
        self.assertEqual(sub.apply("unrelated text here"), "unrelated text here")


if __name__ == "__main__":
    unittest.main()
