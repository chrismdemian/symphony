"""unittest suite for ``stt_moonshine.py``.

Tests run without ``useful-moonshine-onnx`` installed — the module
imports the package LAZILY inside ``load()``, so import-time failure
is testable independently of any inference path.

Run via stdlib unittest (no extra installs):
    python tests/voice/python/test_stt_moonshine.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parents[2] / "src" / "voice" / "python"
sys.path.insert(0, str(SRC_DIR))

import numpy as np  # noqa: E402

from stt_moonshine import (  # noqa: E402
    MoonshineLoadError,
    MoonshineTranscriber,
    SUPPORTED_MODELS,
    int16_pcm_to_float32,
)


class ConstructionTests(unittest.TestCase):
    def test_default_model(self):
        t = MoonshineTranscriber()
        self.assertEqual(t.model_id, "moonshine/base")
        self.assertFalse(t.is_loaded)

    def test_tiny_accepted(self):
        t = MoonshineTranscriber("moonshine/tiny")
        self.assertEqual(t.model_id, "moonshine/tiny")

    def test_unsupported_model_rejected(self):
        with self.assertRaises(ValueError) as cm:
            MoonshineTranscriber("whisper-large")
        self.assertIn("unsupported model", str(cm.exception))

    def test_supported_models_set(self):
        self.assertEqual(
            SUPPORTED_MODELS,
            frozenset({"moonshine/base", "moonshine/tiny"}),
        )


class LoadFailureTests(unittest.TestCase):
    def test_load_raises_moonshine_load_error_when_missing(self):
        # `useful-moonshine-onnx` is intentionally NOT a dev dep of
        # this repo — only installed inside the voice venv. Calling
        # load() outside the venv must raise MoonshineLoadError.
        t = MoonshineTranscriber()
        try:
            import moonshine_onnx  # type: ignore[import-not-found]  # noqa: F401
        except ImportError:
            with self.assertRaises(MoonshineLoadError):
                t.load()
        else:
            self.skipTest("moonshine_onnx is importable in this env")


class TranscribePayloadShapeTests(unittest.TestCase):
    """Shape / dtype validation runs before _call_transcribe even when
    moonshine_onnx isn't installed — we stub the internal call to
    isolate the validation logic."""

    def setUp(self):
        self.t = MoonshineTranscriber()
        # Inject a stub so .transcribe() doesn't reach the real model.
        self.t._loaded = True
        self.t._moonshine_onnx = self._make_stub()  # type: ignore[assignment]

    def _make_stub(self):
        captured = []

        class Stub:
            @staticmethod
            def transcribe(payload, model_id):
                captured.append((payload.shape, model_id))
                return ["hello world"]

        Stub.captured = captured  # type: ignore[attr-defined]
        return Stub

    def test_rejects_non_float32(self):
        with self.assertRaises(TypeError):
            self.t.transcribe(np.zeros(1000, dtype=np.float64))

    def test_rejects_3d_shape(self):
        with self.assertRaises(ValueError):
            self.t.transcribe(np.zeros((1, 1, 1000), dtype=np.float32))

    def test_rejects_two_row_batch(self):
        with self.assertRaises(ValueError):
            self.t.transcribe(np.zeros((2, 1000), dtype=np.float32))

    def test_accepts_1d_array(self):
        out = self.t.transcribe(np.zeros(1000, dtype=np.float32))
        self.assertEqual(out, "hello world")

    def test_accepts_1xN_array(self):
        out = self.t.transcribe(np.zeros((1, 1000), dtype=np.float32))
        self.assertEqual(out, "hello world")

    def test_returns_first_batch_entry(self):
        class TupleStub:
            @staticmethod
            def transcribe(payload, model_id):
                return ("first", "second")

        self.t._moonshine_onnx = TupleStub  # type: ignore[assignment]
        out = self.t.transcribe(np.zeros(1000, dtype=np.float32))
        self.assertEqual(out, "first")

    def test_returns_empty_string_for_empty_list_result(self):
        class EmptyStub:
            @staticmethod
            def transcribe(payload, model_id):
                return []

        self.t._moonshine_onnx = EmptyStub  # type: ignore[assignment]
        out = self.t.transcribe(np.zeros(1000, dtype=np.float32))
        self.assertEqual(out, "")

    def test_coerces_non_list_return(self):
        class ScalarStub:
            @staticmethod
            def transcribe(payload, model_id):
                return "raw scalar text"

        self.t._moonshine_onnx = ScalarStub  # type: ignore[assignment]
        out = self.t.transcribe(np.zeros(1000, dtype=np.float32))
        self.assertEqual(out, "raw scalar text")


class PcmConversionTests(unittest.TestCase):
    def test_int16_zero_maps_to_float_zero(self):
        pcm = (np.zeros(100, dtype=np.int16)).tobytes()
        arr = int16_pcm_to_float32(pcm)
        self.assertEqual(arr.dtype, np.float32)
        self.assertEqual(arr.shape, (100,))
        self.assertTrue(np.all(arr == 0.0))

    def test_int16_max_maps_to_near_one(self):
        # 32767 / 32768 = 0.99996...
        pcm = (np.full(10, 32767, dtype=np.int16)).tobytes()
        arr = int16_pcm_to_float32(pcm)
        self.assertAlmostEqual(float(arr[0]), 32767 / 32768.0, places=6)

    def test_int16_min_maps_to_negative_one(self):
        pcm = (np.full(10, -32768, dtype=np.int16)).tobytes()
        arr = int16_pcm_to_float32(pcm)
        self.assertAlmostEqual(float(arr[0]), -1.0, places=6)

    def test_empty_returns_empty(self):
        arr = int16_pcm_to_float32(b"")
        self.assertEqual(arr.shape, (0,))
        self.assertEqual(arr.dtype, np.float32)


if __name__ == "__main__":
    unittest.main()
