"""unittest suite for ``summarizer.py`` (Phase 6D.2).

Model-free tests run without onnxruntime / sentencepiece / the model
(the module imports them LAZILY inside ``load()``), so the empty-input
short-circuit, the load-failure signalling, and the constants are
testable on any Python. A final end-to-end test runs ONLY when the
model + deps are present (skip-graceful otherwise).

Run via stdlib unittest (no extra installs for the model-free tests):
    python tests/voice/python/test_summarizer.py
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parents[2] / "src" / "voice" / "python"
sys.path.insert(0, str(SRC_DIR))

from summarizer import (  # noqa: E402
    ALLOW_PATTERNS,
    DECODER_START_TOKEN_ID,
    EOS_TOKEN_ID,
    MAX_INPUT_TOKENS,
    PREFIX,
    SummarizerLoadError,
    T5Summarizer,
)


def _have(mod: str) -> bool:
    return importlib.util.find_spec(mod) is not None


class ConstantsTests(unittest.TestCase):
    def test_t5_special_tokens(self):
        self.assertEqual(DECODER_START_TOKEN_ID, 0)
        self.assertEqual(EOS_TOKEN_ID, 1)
        self.assertEqual(PREFIX, "summarize: ")
        self.assertEqual(MAX_INPUT_TOKENS, 512)

    def test_allow_patterns_cover_the_no_cache_path(self):
        self.assertIn("onnx/encoder_model_int8.onnx", ALLOW_PATTERNS)
        self.assertIn("onnx/decoder_model_int8.onnx", ALLOW_PATTERNS)
        self.assertIn("tokenizer.json", ALLOW_PATTERNS)


class EmptyInputTests(unittest.TestCase):
    """Empty input must short-circuit to '' WITHOUT loading the model."""

    def test_empty_list(self):
        s = T5Summarizer(model_dir="/nonexistent")
        self.assertEqual(s.summarize([]), "")
        self.assertFalse(s.is_loaded)

    def test_whitespace_only(self):
        s = T5Summarizer(model_dir="/nonexistent")
        self.assertEqual(s.summarize(["", "   ", "\n\t"]), "")
        self.assertFalse(s.is_loaded)


class LoadFailureTests(unittest.TestCase):
    def test_missing_model_files_raise_load_error(self):
        # A real (empty) dir as model_dir: deps may import, but the ONNX
        # files are absent -> SummarizerLoadError. Skip if onnxruntime/
        # sentencepiece aren't even importable (then the import guard fires
        # first, which ALSO raises SummarizerLoadError — still the contract).
        with tempfile.TemporaryDirectory() as d:
            s = T5Summarizer(model_dir=d)
            with self.assertRaises(SummarizerLoadError):
                s.load()


@unittest.skipUnless(
    _have("onnxruntime") and _have("tokenizers") and _have("huggingface_hub"),
    "summarizer deps not installed (run `symphony voice install`)",
)
class ModelEndToEndTests(unittest.TestCase):
    """Runs only when the model + deps are present (skip-graceful)."""

    def test_summarizes_to_nonempty_text(self):
        s = T5Summarizer()
        try:
            s.load()
        except SummarizerLoadError as e:
            self.skipTest(f"model not cached: {e}")
        out = s.summarize(
            [
                "I need to refactor the authentication module.",
                "We should also update the login flow and add tests.",
                "The session handling has a bug with token expiry.",
            ]
        )
        self.assertIsInstance(out, str)
        self.assertGreater(len(out.strip()), 0)


if __name__ == "__main__":
    unittest.main()
