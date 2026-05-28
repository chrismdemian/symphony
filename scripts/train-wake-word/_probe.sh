#!/usr/bin/env bash
set -u
cd /mnt/c/Users/chris/projects/symphony
"${HOME}/.symphony-train/venv/bin/python" - <<'PY'
import sys, numpy as np
sys.path.insert(0, "src/voice/python")
from wake_word_detector import WakeWordConfig, WakeWordDetector

with open("tests/fixtures/voice/wake-symphony-3s.pcm", "rb") as f:
    pcm_bytes = f.read()
pcm = np.frombuffer(pcm_bytes, dtype=np.int16)
print(f"fixture: {len(pcm)} samples")

cfg = WakeWordConfig(sample_rate=16000, frame_samples=512, window_samples=1280,
                     threshold=0.4, sustain_frames=2, cooldown_ms=2000,
                     model_name="hey-symphony")
det = WakeWordDetector(cfg, "assets/wake-models/hey-symphony.onnx")

# Feed the fixture as 512-sample (1024-byte) frames, exactly like the bridge.
fires = []
frame_bytes = 512 * 2
for i in range(0, len(pcm_bytes) - frame_bytes, frame_bytes):
    frame = pcm_bytes[i:i+frame_bytes]
    fire = det.push(frame, t_ms=(i // frame_bytes) * 32)
    if fire is not None:
        fires.append((fire.t_ms, round(fire.score, 3)))
print(f"DETECTOR fires: {len(fires)} -> {fires}")
PY
