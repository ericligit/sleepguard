"""
synthesize.py — Generate labelled synthetic audio clips for SleepGuard Phase 2.

5 classes (matching Android ApneaEvent types):
  0  silence      — baseline quiet breathing / room noise
  1  snoring      — rhythmic periodic low-frequency noise
  2  cessation    — abrupt silence after snoring (apnea onset)
  3  gasp         — short sharp transient, high-amplitude
  4  recovery     — resumed breathing, often irregular/noisy

Output layout:
  data/clips/<class_name>/<uuid>.wav  (16kHz mono, 2-second clips)
  data/manifest.csv                   (path, label, label_idx, split)

Usage:
  python data/synthesize.py --clips_per_class 2500 --seed 42
"""

import argparse
import csv
import os
import random
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from tqdm import tqdm

SR = 16000          # Hz — must match AudioRecordingService.SAMPLE_RATE
CLIP_DURATION = 2.0 # seconds
N_SAMPLES = int(SR * CLIP_DURATION)

CLASSES = ["silence", "snoring", "cessation", "gasp", "recovery"]

# ---------------------------------------------------------------------------
# Per-class signal generators
# ---------------------------------------------------------------------------

rng = np.random.default_rng()  # seeded in main

def _noise(amp: float = 0.01) -> np.ndarray:
    """White noise floor present in all clips."""
    return rng.standard_normal(N_SAMPLES).astype(np.float32) * amp


def gen_silence() -> np.ndarray:
    """Very quiet room noise, no periodic structure."""
    amp = rng.uniform(0.003, 0.012)
    return _noise(amp)


def gen_snoring() -> np.ndarray:
    """
    Periodic bursts at 1–3 Hz, each burst a band-limited noise envelope
    centred on 100–400 Hz (typical snore fundamental range).
    """
    audio = _noise(0.008)
    rate  = rng.uniform(1.0, 3.0)          # snore rate Hz
    f_lo  = rng.uniform(80, 200)            # fundamental band low
    f_hi  = f_lo + rng.uniform(100, 300)    # fundamental band high

    t = np.arange(N_SAMPLES) / SR
    # Envelope: raised-cosine bursts
    envelope = np.clip(np.cos(2 * np.pi * rate * t) + 0.3, 0, 1)
    # Band-limited noise carrier
    carrier = rng.standard_normal(N_SAMPLES).astype(np.float32)
    # Simple band-pass via difference of low-pass filters (IIR approx)
    from scipy.signal import butter, sosfilt
    sos = butter(4, [f_lo / (SR / 2), min(f_hi / (SR / 2), 0.99)], btype='band', output='sos')
    carrier = sosfilt(sos, carrier).astype(np.float32)

    amp = rng.uniform(0.15, 0.40)
    audio += carrier * envelope * amp
    return np.clip(audio, -1, 1).astype(np.float32)


def gen_cessation() -> np.ndarray:
    """
    Snoring for first 0.3–0.7 s, then abrupt silence (apnea).
    This represents the critical transition the model must detect.
    """
    snore_end = rng.uniform(0.3, 0.7)
    n_snore   = int(snore_end * SR)

    full_snore = gen_snoring()
    audio = np.zeros(N_SAMPLES, dtype=np.float32)
    audio[:n_snore] = full_snore[:n_snore]
    # Soft gate — 20 ms fade-out
    fade_len = int(0.020 * SR)
    fade      = np.linspace(1, 0, fade_len, dtype=np.float32)
    start     = max(0, n_snore - fade_len)
    audio[start:n_snore] *= fade
    # Residual noise floor after cessation
    audio += _noise(0.005)
    return np.clip(audio, -1, 1).astype(np.float32)


def gen_gasp() -> np.ndarray:
    """
    Short (50–300 ms) high-amplitude transient.
    Could be one or two gasp events within the clip.
    """
    audio = _noise(0.008)
    n_gasps = rng.integers(1, 3)
    for _ in range(n_gasps):
        onset    = rng.uniform(0.1, 1.6)
        duration = rng.uniform(0.05, 0.30)
        n_start  = int(onset * SR)
        n_end    = min(N_SAMPLES, n_start + int(duration * SR))
        # Gasp: broadband noise with sharp attack, fast decay
        length   = n_end - n_start
        if length <= 0:
            continue
        carrier  = rng.standard_normal(length).astype(np.float32)
        env_up   = int(length * 0.15)
        env_down = length - env_up
        envelope = np.concatenate([
            np.linspace(0, 1, env_up, dtype=np.float32),
            np.linspace(1, 0.1, env_down, dtype=np.float32),
        ])
        amp = rng.uniform(0.4, 0.85)
        audio[n_start:n_end] += carrier * envelope * amp
    return np.clip(audio, -1, 1).astype(np.float32)


def gen_recovery() -> np.ndarray:
    """
    Resumed breathing after apnea: irregular, noisy, moderate amplitude.
    Mix of low snoring and occasional gasps.
    """
    audio = _noise(0.012)
    # Irregular breathing pattern — variable rate 0.3–1.5 Hz, variable amplitude
    n_breaths = rng.integers(1, 5)
    for _ in range(n_breaths):
        onset    = rng.uniform(0, 1.5)
        duration = rng.uniform(0.1, 0.5)
        n_start  = int(onset * SR)
        n_end    = min(N_SAMPLES, n_start + int(duration * SR))
        length   = n_end - n_start
        if length <= 0:
            continue
        carrier = rng.standard_normal(length).astype(np.float32)
        from scipy.signal import butter, sosfilt
        sos     = butter(3, [60 / (SR / 2), 800 / (SR / 2)], btype='band', output='sos')
        carrier = sosfilt(sos, carrier).astype(np.float32)
        env     = np.hanning(length).astype(np.float32)
        amp     = rng.uniform(0.08, 0.30)
        audio[n_start:n_end] += carrier * env * amp
    return np.clip(audio, -1, 1).astype(np.float32)


GENERATORS = [gen_silence, gen_snoring, gen_cessation, gen_gasp, gen_recovery]

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clips_per_class", type=int, default=2500)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--val_split", type=float, default=0.15,
                        help="Fraction of clips reserved for validation")
    parser.add_argument("--test_split", type=float, default=0.10)
    parser.add_argument("--out_dir", type=str, default="data/clips")
    args = parser.parse_args()

    global rng
    rng = np.random.default_rng(args.seed)
    random.seed(args.seed)

    out_root = Path(args.out_dir)
    for cls in CLASSES:
        (out_root / cls).mkdir(parents=True, exist_ok=True)

    manifest_path = Path("data/manifest.csv")
    rows = []

    print(f"Generating {args.clips_per_class} clips × {len(CLASSES)} classes "
          f"= {args.clips_per_class * len(CLASSES):,} total clips …")

    for label_idx, (cls, gen_fn) in enumerate(zip(CLASSES, GENERATORS)):
        for _ in tqdm(range(args.clips_per_class), desc=cls, unit="clip"):
            audio = gen_fn()
            fname = f"{uuid.uuid4().hex}.wav"
            fpath = out_root / cls / fname
            sf.write(str(fpath), audio, SR, subtype="PCM_16")
            rows.append((str(fpath), cls, label_idx))

    # Shuffle and assign splits
    random.shuffle(rows)
    total = len(rows)
    n_val  = int(total * args.val_split)
    n_test = int(total * args.test_split)

    def split_tag(i):
        if i < n_val:
            return "val"
        if i < n_val + n_test:
            return "test"
        return "train"

    with open(manifest_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["path", "label", "label_idx", "split"])
        for i, (path, label, label_idx) in enumerate(rows):
            writer.writerow([path, label, label_idx, split_tag(i)])

    # Summary
    from collections import Counter
    splits = Counter(split_tag(i) for i in range(total))
    print(f"\nDone. Manifest: {manifest_path}")
    print(f"  train: {splits['train']:,}  val: {splits['val']:,}  test: {splits['test']:,}")
    print(f"  Total WAV size ≈ {total * N_SAMPLES * 2 / 1e6:.0f} MB (16-bit PCM)")


if __name__ == "__main__":
    main()
