"""生成 RB Code 的提示音（多种风格）。

流程：纯 Python 写出 MIDI → FluidSynth + GeneralUser GS 渲染成 WAV →
ffmpeg 编码成 mp3。产物落在 web/public/sounds/*.mp3，前端用 <audio> 播放。

依赖：
    - FluidSynth 2.x
    - 一个 GM SoundFont（默认 GeneralUser GS）
    - ffmpeg

可用环境变量覆盖工具路径（在 PATH 里找不到时必须指定）：
    FLUIDSYNTH   fluidsynth 可执行文件
    SOUNDFONT    .sf2 / .sf3 音色库（例如 GeneralUser GS）

用法（在 web/ 目录下）：
    python scripts/make-sounds.py
"""

from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sounds"

DEFAULT_FLUIDSYNTH = "fluidsynth"
DEFAULT_SOUNDFONT = os.environ.get("SOUNDFONT", "GeneralUser-GS.sf2")

TICKS_PER_BEAT = 480
TEMPO_US_PER_BEAT = 500_000  # 120 BPM


# ---------------------------------- MIDI 写入 ----------------------------------

def _vlq(value: int) -> bytes:
    """可变长度量：MIDI 的 delta-time 编码。"""
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def _seconds_to_ticks(seconds: float) -> int:
    return round(seconds * TICKS_PER_BEAT * 1_000_000 / TEMPO_US_PER_BEAT)


def build_midi(program: int, notes: list[tuple[float, float, int, int]]) -> bytes:
    """notes: (start_seconds, duration_seconds, midi_note, velocity)"""
    events: list[tuple[int, bytes]] = []

    # 速度 + 音色
    events.append((0, b"\xff\x51\x03" + struct.pack(">I", TEMPO_US_PER_BEAT)[1:]))
    events.append((0, bytes([0xC0, program & 0x7F])))

    channel = 0
    for start, dur, note, velocity in notes:
        on = _seconds_to_ticks(start)
        off = _seconds_to_ticks(start + dur)
        events.append((on, bytes([0x90 | channel, note & 0x7F, max(1, min(127, velocity))])))
        events.append((off, bytes([0x80 | channel, note & 0x7F, 0])))

    events.sort(key=lambda item: item[0])
    events.append((events[-1][0] + TICKS_PER_BEAT // 2, b"\xff\x2f\x00"))

    track = bytearray()
    previous = 0
    for tick, data in events:
        track += _vlq(max(0, tick - previous))
        track += data
        previous = tick

    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, TICKS_PER_BEAT)
    return header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


# ----------------------------------- 音色设计 -----------------------------------
# GM 音色号：8 Celesta 9 Glockenspiel 11 Vibraphone 12 Marimba 14 Tubular Bells 56 Trumpet
# 每项：(文件名, GM 音色, 结束时长, [(起始秒, 时值秒, MIDI 音高, 力度)])
# MIDI 音高参考：C4=60, C5=72, C6=84, E5=76, G5=79, A5=81

SOUNDS: dict[str, tuple[int, float, list[tuple[float, float, int, int]]]] = {
    # 清铃：钟琴两音，轻快
    "chime": (9, 0.9, [(0.0, 0.55, 84, 100), (0.12, 0.7, 91, 88)]),
    # 钟声：管钟，低而长
    "bell": (14, 1.6, [(0.0, 1.4, 72, 105)]),
    # 气泡：马林巴，极短
    "pop": (12, 0.25, [(0.0, 0.12, 96, 115)]),
    # 提示：钢片琴，单点高音
    "ping": (8, 0.6, [(0.0, 0.45, 91, 100)]),
    # 完成音：马林巴 C5-E5-G5 上行
    "success": (12, 1.1, [(0.0, 0.35, 72, 105), (0.11, 0.35, 76, 105), (0.22, 0.55, 79, 110)]),
    # 警示：小号两声短促
    "alert": (56, 0.7, [(0.0, 0.13, 81, 100), (0.2, 0.16, 81, 100)]),
    # 柔和：颤音琴低音，慢衰减
    "soft": (11, 1.3, [(0.0, 1.1, 67, 72)]),
}


# ------------------------------------ 渲染 ------------------------------------

def find_tool() -> tuple[str, str]:
    fluidsynth = os.environ.get("FLUIDSYNTH") or shutil.which("fluidsynth") or DEFAULT_FLUIDSYNTH
    soundfont = os.environ.get("SOUNDFONT") or DEFAULT_SOUNDFONT
    if not Path(fluidsynth).exists() and not shutil.which(fluidsynth):
        raise SystemExit(f"找不到 fluidsynth：{fluidsynth}（可用 FLUIDSYNTH 环境变量指定）")
    if not Path(soundfont).exists():
        raise SystemExit(f"找不到 SoundFont：{soundfont}（可用 SOUNDFONT 环境变量指定）")
    return fluidsynth, soundfont


def render(fluidsynth: str, soundfont: str, midi: bytes, wav: Path, seconds: float) -> None:
    with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as fp:
        fp.write(midi)
        mid_path = Path(fp.name)
    try:
        subprocess.run(
            [
                fluidsynth, "-ni", "-F", str(wav), "-r", "44100", "-g", "0.7",
                "-o", "synth.reverb.active=0", "-o", "synth.chorus.active=0",
                "-o", "synth.polyphony=64",
                soundfont, str(mid_path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    finally:
        mid_path.unlink(missing_ok=True)
    # 截到设计时长 + 一点尾巴，避免留一长段静音
    if shutil.which("ffmpeg"):
        trimmed = wav.with_name(wav.stem + "-trim.wav")
        subprocess.run(
            [shutil.which("ffmpeg"), "-y", "-loglevel", "error", "-i", str(wav),
             "-t", f"{seconds:.2f}", str(trimmed)],
            check=True,
        )
        trimmed.replace(wav)


def peak_db(wav: Path) -> float | None:
    """测出音频峰值（dBFS），用于把每个提示音归一到一致的响度。"""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(wav), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    match = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB", proc.stderr)
    return float(match.group(1)) if match else None


def to_mp3(wav: Path) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("找不到 ffmpeg，无法编码 mp3")
    mp3 = wav.with_suffix(".mp3")

    # 峰值归一到 -1 dBFS，并限制增益范围（不给过轻的音过度放大）
    peak = peak_db(wav)
    filters = ["afade=t=in:st=0:d=0.004"]
    if peak is not None:
        gain = max(-6.0, min(18.0, -1.0 - peak))
        if abs(gain) > 0.1:
            filters.insert(0, f"volume={gain:.1f}dB")

    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame",
         "-b:a", "96k", "-ar", "44100", "-ac", "1", "-af", ",".join(filters), str(mp3)],
        check=True,
    )
    wav.unlink(missing_ok=True)
    return mp3


def main() -> int:
    fluidsynth, soundfont = find_tool()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"fluidsynth : {fluidsynth}")
    print(f"soundfont  : {soundfont}")
    with tempfile.TemporaryDirectory() as tmp:
        for name, (program, seconds, notes) in SOUNDS.items():
            midi = build_midi(program, notes)
            wav = Path(tmp) / f"{name}.wav"
            render(fluidsynth, soundfont, midi, wav, seconds)
            mp3 = to_mp3(wav)
            target = OUT / f"{name}.mp3"
            target.write_bytes(mp3.read_bytes())
            print(f"  {name:8s} {target.stat().st_size / 1024:6.1f} KB")
    print(f"输出目录：{OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
