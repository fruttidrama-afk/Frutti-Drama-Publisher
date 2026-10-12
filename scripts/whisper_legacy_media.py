#!/usr/bin/env python3
"""CPU-only, no-paid-API speech audit. Reports remain in private Supabase Storage."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
start = int(sys.argv[2])
count = int(sys.argv[3])
if start < 3 or count < 1 or count > 7 or start + count > 31:
    raise ValueError("FORBIDDEN_FORENSIC_RANGE")
from faster_whisper import WhisperModel

model = WhisperModel("base", device="cpu", compute_type="int8")
for index in range(start, start + count):
    report = ROOT / f"report-{index}.json"
    audio = ROOT / f"audio-{index}.wav"
    data = json.loads(report.read_text(encoding="utf-8"))
    data["transcription_engine"] = "faster-whisper/base/es/cpu/int8"
    data["transcription_pending"] = False
    data["transcript"] = ""
    data["transcript_language"] = None
    data["dialogue_segments"] = []
    if audio.is_file() and audio.stat().st_size > 1000:
        try:
            segment_iter, info = model.transcribe(
                str(audio), language="es", beam_size=5,
                vad_filter=False, condition_on_previous_text=False,
                without_timestamps=False
            )
            segments = []
            for segment in segment_iter:
                text = str(segment.text).strip()
                if not text:
                    continue
                segments.append({
                    "start": round(float(segment.start), 2),
                    "end": round(float(segment.end), 2),
                    "text": text,
                    "avg_logprob": round(float(segment.avg_logprob), 4),
                    "no_speech_prob": round(float(segment.no_speech_prob), 4)
                })
            data["dialogue_segments"] = segments
            data["transcript"] = " ".join(s["text"] for s in segments)
            data["transcript_language"] = info.language
            data["language_probability"] = round(float(info.language_probability), 4)
        except Exception as exc:
            data["transcription_error_type"] = type(exc).__name__
    else:
        data["transcription_error_type"] = "AUDIO_UNAVAILABLE"
    # No speech text in logs of a public GitHub repository.
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "index": index,
        "transcription_complete": bool(data.get("transcript")),
        "segment_count": len(data.get("dialogue_segments", [])),
        "language": data.get("transcript_language"),
        "error_type": data.get("transcription_error_type")
    }))
