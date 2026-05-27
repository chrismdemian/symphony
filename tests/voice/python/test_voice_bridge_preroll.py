"""unittest suite for Bridge pre-roll ring buffer (Phase 6B audit-M2).

Asserts the invariant: the FRAME that triggers `speech_start` appears
in the per-segment audio buffer EXACTLY ONCE, even though the bridge:
  1. Appends every frame to the pre-roll deque BEFORE calling
     `segmenter.push(frame)`.
  2. On `SpeechStart`, copies the ENTIRE deque (including the trigger
     frame at the back) into `segment_buffer`.
  3. Skips the post-events mid-segment append for the trigger frame
     via `started_this_frame`.

Without the `started_this_frame` skip, the trigger frame would land in
segment_buffer twice — once via the deque copy, once via the regular
mid-segment append. That duplication would corrupt the audio passed to
Moonshine by a half-frame.

Run via stdlib unittest (no extra installs):
    python tests/voice/python/test_voice_bridge_preroll.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parents[2] / "src" / "voice" / "python"
sys.path.insert(0, str(SRC_DIR))

from vad_segmenter import (  # noqa: E402
    SpeechEnd,
    SpeechStart,
    VadConfig,
    VadSegmenter,
)
from voice_bridge import Bridge  # noqa: E402


FRAME_SAMPLES = 480
FRAME_BYTES = FRAME_SAMPLES * 2  # int16
SAMPLE_RATE = 16000


def make_marker_frame(marker_byte: int) -> bytes:
    """Build a frame filled with a single byte marker so we can grep
    the segment buffer for which frames landed where."""
    return bytes([marker_byte, 0x00] * FRAME_SAMPLES)


def make_bridge(min_speech_ms: int = 100) -> Bridge:
    """Construct a Bridge instance and INJECT a deterministic
    VadSegmenter directly so we don't depend on Silero. Setting
    `stt_enabled=False` skips the Moonshine worker thread."""
    bridge = Bridge(
        input_mode="stdin-pcm",
        sample_rate=SAMPLE_RATE,
        frame_samples=FRAME_SAMPLES,
        vad_threshold=0.5,
        vad_min_speech_ms=min_speech_ms,
        vad_min_silence_ms=400,
        force_backend=None,
        stt_enabled=False,
        stt_model="moonshine/base",
        max_utterance_seconds=30,
        partial_interval_ms=200,
        stt_vocab_paths=[],
    )
    return bridge


class PrerollTriggerFrameTests(unittest.TestCase):
    def test_trigger_frame_appears_in_segment_buffer_exactly_once(self):
        """Audit-M2 regression lock.

        Setup: 4 frames of silence (preroll fills); next 4 frames are
        speech with min_speech_ms = 4 frames * 30ms = 120ms (just under
        the run-up gate of 100ms means the 4th speech frame triggers
        SpeechStart). After SpeechStart, push 2 more frames marked
        distinctly. Assert each marker appears in segment_buffer
        exactly the right number of times.
        """
        bridge = make_bridge(min_speech_ms=100)
        bridge.segmenter = VadSegmenter(
            VadConfig(
                sample_rate=SAMPLE_RATE,
                frame_samples=FRAME_SAMPLES,
                threshold=0.5,
                min_speech_ms=100,
                min_silence_ms=400,
            ),
            self._stepwise_prob([0.0] * 4 + [0.9] * 4 + [0.9] * 2),
        )

        # 8 frames: 4 silence + 4 speech. The 4th speech frame triggers
        # SpeechStart because the run-up reached 120ms (>= 100ms). The
        # preroll deque holds the last (min_speech_ms+30)//frame_ms
        # frames; with default frame_ms = 30, that's (100+30)//30 = 4.
        # So at SpeechStart the deque contains the 4 most recent
        # frames (silence frames 2-4 + the trigger speech frame).
        events: list = []
        marker_silence = make_marker_frame(0x11)  # bytes: 11 00 11 00 ...
        marker_speech = [
            make_marker_frame(0x20),
            make_marker_frame(0x21),
            make_marker_frame(0x22),
            make_marker_frame(0x23),  # trigger frame
        ]
        marker_post = [
            make_marker_frame(0x30),
            make_marker_frame(0x31),
        ]
        all_frames = (
            [marker_silence] * 4
            + marker_speech
            + marker_post
        )

        self._drive_bridge_inline(bridge, all_frames, events)

        # Locate the SpeechStart event index in the frame timeline.
        # In our schedule it fires on frame index 7 (1-indexed: the
        # 4th speech frame).
        starts = [e for e in events if isinstance(e, SpeechStart)]
        self.assertEqual(len(starts), 1)

        # Now compute the marker frequencies in segment_buffer.
        # Expected (preroll = last 4 frames at SpeechStart moment,
        # which are speech frames 1-4 = 0x20, 0x21, 0x22, 0x23):
        #   - 0x20, 0x21, 0x22: 1 each (from preroll only)
        #   - 0x23 (trigger):   1 (from preroll only — the mid-segment
        #                          append path is skipped for the
        #                          trigger frame via started_this_frame)
        #   - 0x30, 0x31:       1 each (mid-segment append, post-trigger)
        buf = bytes(bridge.segment_buffer)
        # Count occurrences of each marker. Since each frame fills the
        # buffer with that marker byte every other position, we just
        # divide the count by FRAME_SAMPLES (one marker byte per sample).
        counts = {
            byte: buf.count(bytes([byte])) // FRAME_SAMPLES
            for byte in [0x11, 0x20, 0x21, 0x22, 0x23, 0x30, 0x31]
        }
        # The pre-trigger silence frames (0x11) are no longer in the
        # preroll deque (deque maxlen = 4, filled by speech frames).
        self.assertEqual(counts[0x11], 0)
        self.assertEqual(counts[0x20], 1)
        self.assertEqual(counts[0x21], 1)
        self.assertEqual(counts[0x22], 1)
        # THE INVARIANT — trigger frame appears exactly once
        self.assertEqual(counts[0x23], 1,
                         "trigger frame must appear in segment_buffer EXACTLY once")
        # Post-trigger frames are mid-segment-appended once each
        self.assertEqual(counts[0x30], 1)
        self.assertEqual(counts[0x31], 1)
        # Total frame count: preroll (4) + mid-segment (2) = 6 frames
        total_frames = len(buf) // FRAME_BYTES
        self.assertEqual(total_frames, 6)

    def test_first_frame_post_speech_start_does_not_duplicate(self):
        """Audit-M2 — same invariant restricted to the most-frequently-
        broken corner case: the very first segment of a session, where
        the preroll deque starts EMPTY and fills with the run-up
        frames. The trigger frame goes in via deque copy AT speech_start
        time; the next frame goes in via mid-segment append (`if
        self.in_segment and not started_this_frame`). No duplication.
        """
        bridge = make_bridge(min_speech_ms=100)
        bridge.segmenter = VadSegmenter(
            VadConfig(
                sample_rate=SAMPLE_RATE,
                frame_samples=FRAME_SAMPLES,
                threshold=0.5,
                min_speech_ms=100,
                min_silence_ms=400,
            ),
            self._stepwise_prob([0.9] * 4 + [0.9]),
        )
        events: list = []
        trigger = make_marker_frame(0x33)
        post = make_marker_frame(0x44)
        # 4 frames of 0x33 (the 4th one triggers SpeechStart since
        # 4 * 30ms = 120ms > min_speech_ms 100ms). Then 1 frame of 0x44.
        self._drive_bridge_inline(bridge, [trigger] * 4 + [post], events)

        starts = [e for e in events if isinstance(e, SpeechStart)]
        self.assertEqual(len(starts), 1)
        buf = bytes(bridge.segment_buffer)
        # The 4 preroll trigger frames are all 0x33; they ALL went in
        # via deque copy. Then 0x44 was the SOLE mid-segment frame.
        # Total: 5 frames = preroll (4) + post (1).
        self.assertEqual(buf.count(bytes([0x33])) // FRAME_SAMPLES, 4)
        self.assertEqual(buf.count(bytes([0x44])) // FRAME_SAMPLES, 1)
        # 5 frames total — no duplicate of any one frame
        self.assertEqual(len(buf) // FRAME_BYTES, 5)

    # --- helpers ----------------------------------------------------

    @staticmethod
    def _stepwise_prob(probabilities):
        """Probability function that returns scripted values per call."""
        idx = [0]

        def _fn(frame):
            i = idx[0]
            idx[0] += 1
            if i >= len(probabilities):
                return 0.0
            return probabilities[i]

        return _fn

    @staticmethod
    def _drive_bridge_inline(bridge, frames, events_out):
        """Replay the SAME frame-by-frame loop body that `Bridge.run`
        uses, but inline (no audio iter / no stdin / no threads). This
        exercises the EXACT control flow we need to regression-lock:
        preroll.append → segmenter.push → SpeechStart bookkeeping →
        mid-segment append gated by started_this_frame.
        """
        for frame in frames:
            bridge.preroll.append(frame)
            push_events = list(bridge.segmenter.push(frame))
            started_this_frame = False
            for e in push_events:
                if isinstance(e, SpeechStart):
                    bridge._on_speech_start(e)
                    events_out.append(e)
                    started_this_frame = True
                elif isinstance(e, SpeechEnd):
                    bridge._on_speech_end(e)
                    events_out.append(e)
            if bridge.in_segment and not started_this_frame:
                bridge._on_mid_segment_frame(frame)


if __name__ == "__main__":
    unittest.main()
