"""Post-download transcription and reference-free subtitle selection."""

from __future__ import annotations

import json
import logging
import math
import os
import re
from datetime import datetime, timezone
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import aiohttp


log = logging.getLogger("transcription")
_TIMESTAMP_RE = re.compile(
    r"(?P<h>\d{1,2}):(?P<m>\d{2}):(?P<s>\d{2})[,.](?P<ms>\d{3})"
)
_TAG_RE = re.compile(r"<[^>]+>|\{\\[^}]+\}")
_WORD_RE = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.UNICODE)


@dataclass(frozen=True)
class CandidateScore:
    source: str
    score: float
    coverage: float
    repetition: float
    agreement: float
    confidence: float | None = None


def _seconds(value: str) -> float:
    match = _TIMESTAMP_RE.search(value)
    if not match:
        return 0.0
    return (
        int(match.group("h")) * 3600
        + int(match.group("m")) * 60
        + int(match.group("s"))
        + int(match.group("ms")) / 1000
    )


def parse_srt(text: str) -> list[tuple[float, float, str]]:
    cues: list[tuple[float, float, str]] = []
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n\s*\n", normalized.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timestamp_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timestamp_index is None:
            continue
        start_raw, end_raw = lines[timestamp_index].split("-->", 1)
        cue_text = " ".join(lines[timestamp_index + 1 :])
        cue_text = _TAG_RE.sub("", cue_text).strip()
        if cue_text:
            cues.append((_seconds(start_raw), _seconds(end_raw), cue_text))
    return cues


def _words(text: str) -> list[str]:
    return [word.casefold() for word in _WORD_RE.findall(text)]


def _coverage(cues: list[tuple[float, float, str]], duration: float | None) -> float:
    if not cues:
        return 0.0
    intervals = sorted((max(0.0, start), max(start, end)) for start, end, _ in cues)
    covered = 0.0
    current_start, current_end = intervals[0]
    for start, end in intervals[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
        else:
            covered += current_end - current_start
            current_start, current_end = start, end
    covered += current_end - current_start
    total = duration or max(end for _, end, _ in cues)
    return min(1.0, covered / total) if total > 0 else 0.0


def _repetition(cues: list[tuple[float, float, str]]) -> float:
    words = _words(" ".join(text for _, _, text in cues))
    if len(words) < 2:
        return 0.0
    repeated_adjacent = sum(a == b for a, b in zip(words, words[1:]))
    repeated_cues = sum(
        SequenceMatcher(None, _words(left[2]), _words(right[2])).ratio() > 0.92
        for left, right in zip(cues, cues[1:])
    )
    return min(1.0, (repeated_adjacent + repeated_cues * 2) / len(words))


def _agreement(left: list[tuple[float, float, str]], right: list[tuple[float, float, str]]) -> float:
    return SequenceMatcher(
        None,
        _words(" ".join(text for _, _, text in left)),
        _words(" ".join(text for _, _, text in right)),
        autojunk=False,
    ).ratio()


def _whisper_confidence(payload: dict[str, Any]) -> float:
    segments = payload.get("segments") or []
    weighted = 0.0
    weight = 0.0
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        duration = max(0.01, float(segment.get("end", 0)) - float(segment.get("start", 0)))
        avg_logprob = float(segment.get("avg_logprob", -1.0))
        no_speech = float(segment.get("no_speech_prob", 0.0))
        confidence = max(0.0, min(1.0, math.exp(avg_logprob) * (1.0 - no_speech)))
        weighted += confidence * duration
        weight += duration
    return weighted / weight if weight else 0.5


def choose_best(
    source_cues: list[tuple[float, float, str]],
    whisper_cues: list[tuple[float, float, str]],
    *,
    duration: float | None,
    source_is_manual: bool,
    whisper_confidence: float,
) -> tuple[str, CandidateScore, CandidateScore]:
    """Rank two hypotheses without pretending one is ground truth.

    Manual captions receive a modest prior. Coverage, pathological repetition,
    cross-system agreement and Whisper acoustic confidence provide the remaining
    evidence. A near tie is resolved in favour of manual captions.
    """
    agreement = _agreement(source_cues, whisper_cues)
    source_coverage = _coverage(source_cues, duration)
    whisper_coverage = _coverage(whisper_cues, duration)
    source_repetition = _repetition(source_cues)
    whisper_repetition = _repetition(whisper_cues)
    source_score = (
        0.48 * source_coverage
        + 0.22 * agreement
        + (0.22 if source_is_manual else 0.10)
        + 0.08 * (1.0 - source_repetition)
    )
    whisper_score = (
        0.42 * whisper_coverage
        + 0.22 * agreement
        + 0.28 * whisper_confidence
        + 0.08 * (1.0 - whisper_repetition)
    )
    source = CandidateScore(
        "source_manual" if source_is_manual else "source_auto",
        round(source_score, 4), source_coverage, source_repetition, agreement,
    )
    whisper = CandidateScore(
        "whisper", round(whisper_score, 4), whisper_coverage,
        whisper_repetition, agreement, whisper_confidence,
    )
    if source_is_manual and abs(source_score - whisper_score) < 0.06:
        return "source", source, whisper
    return ("source" if source_score >= whisper_score else "whisper"), source, whisper


def _clock(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def cues_to_markdown(cues: list[tuple[float, float, str]], metadata: dict[str, Any]) -> str:
    """Build readable Markdown with YAML 1.2-compatible front matter."""
    lines = ["---"]
    for key in (
        "title", "source_url", "media_file", "language", "generated_at",
        "selected_source", "model", "duration_seconds",
    ):
        value = metadata.get(key)
        if value is not None:
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    lines.extend(["quality:"])
    for candidate, score in (metadata.get("quality") or {}).items():
        lines.append(f"  {candidate}:")
        if score is None:
            lines.append("    available: false")
            continue
        lines.append("    available: true")
        for key, value in score.items():
            lines.append(f"    {key}: {json.dumps(value, ensure_ascii=False)}")
    lines.extend(["---", "", f"# {metadata.get('title') or 'Transcrição'}", ""])
    if metadata.get("source_url"):
        lines.extend([f"> Fonte: {metadata['source_url']}", ""])
    lines.extend(["## Transcrição", ""])
    current_section = None
    paragraph: list[str] = []
    for start, _, text in cues:
        section = int(start // 300) * 300
        if section != current_section:
            if paragraph:
                lines.extend([" ".join(paragraph), ""])
                paragraph = []
            lines.extend([f"### {_clock(start)}", ""])
            current_section = section
        paragraph.append(text.strip())
    if paragraph:
        lines.extend([" ".join(paragraph), ""])
    return "\n".join(lines).rstrip() + "\n"


class TranscriptionService:
    def __init__(self, config):
        self.endpoint = str(config.TRANSCRIPTION_URL).rstrip("/")
        self.api_key = str(config.TRANSCRIPTION_API_KEY)
        self.model = str(config.TRANSCRIPTION_MODEL)
        self.timeout = int(config.TRANSCRIPTION_TIMEOUT)
        self.download_dir = os.path.realpath(config.DOWNLOAD_DIR)

    async def transcribe(self, info) -> dict[str, Any]:
        relative_name = getattr(info, "filename", None)
        if not relative_name:
            raise ValueError("download finished without a media filename")
        media_path = os.path.realpath(os.path.join(self.download_dir, relative_name))
        if os.path.commonpath((self.download_dir, media_path)) != self.download_dir:
            raise ValueError("media path is outside DOWNLOAD_DIR")
        if not os.path.isfile(media_path):
            raise FileNotFoundError(media_path)

        form = aiohttp.FormData()
        form.add_field("model", self.model)
        form.add_field("response_format", "verbose_json")
        language = getattr(info, "transcription_language", "auto")
        if language and language != "auto":
            form.add_field("language", language)
        file_handle = open(media_path, "rb")
        form.add_field(
            "file", file_handle, filename=os.path.basename(media_path),
            content_type="application/octet-stream",
        )
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        try:
            timeout = aiohttp.ClientTimeout(total=self.timeout)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(self.endpoint, data=form, headers=headers) as response:
                    body = await response.text()
                    if response.status >= 400:
                        raise RuntimeError(f"transcription server returned {response.status}: {body[:300]}")
        finally:
            file_handle.close()
        payload = json.loads(body)
        segments = payload.get("segments") or []
        whisper_cues = [
            (float(segment["start"]), float(segment["end"]), str(segment["text"]).strip())
            for segment in segments
            if isinstance(segment, dict) and str(segment.get("text", "")).strip()
        ]
        if not whisper_cues and payload.get("text"):
            duration = float(getattr(info, "entry", {}).get("duration") or 0)
            whisper_cues = [(0.0, duration, str(payload["text"]).strip())]
        if not whisper_cues:
            raise RuntimeError("transcription server returned no text")

        base = Path(media_path).with_suffix("")
        source_path = self._source_subtitle(info)
        winner = "whisper"
        source_score = None
        whisper_score = None
        if source_path:
            source_cues = parse_srt(source_path.read_text(encoding="utf-8", errors="replace"))
            source_is_manual = self._source_is_manual(info, source_path)
            winner, source_score, whisper_score = choose_best(
                source_cues,
                whisper_cues,
                duration=float(getattr(info, "entry", {}).get("duration") or 0) or None,
                source_is_manual=source_is_manual,
                whisper_confidence=_whisper_confidence(payload),
            )
            selected_cues = source_cues if winner == "source" else whisper_cues
        else:
            selected_cues = whisper_cues

        markdown_path = Path(f"{base}.md")
        markdown_metadata = {
            "title": getattr(info, "title", None) or base.name,
            "source_url": getattr(info, "url", None),
            "media_file": os.path.relpath(media_path, self.download_dir),
            "language": payload.get("language") or language,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "selected_source": winner,
            "model": self.model,
            "duration_seconds": float(getattr(info, "entry", {}).get("duration") or 0) or None,
            "quality": {
                "source": source_score.__dict__ if source_score else None,
                "whisper": whisper_score.__dict__ if whisper_score else {
                    "source": "whisper",
                    "confidence": _whisper_confidence(payload),
                },
            },
        }
        markdown_path.write_text(
            cues_to_markdown(selected_cues, markdown_metadata), encoding="utf-8"
        )

        # Captions requested by the transcription workflow are comparison inputs,
        # not user-facing outputs. Keep the media and its Markdown sidecar only.
        self._remove_source_subtitles(info)

        report = {
            "winner": winner,
            "markdown": os.path.relpath(markdown_path, self.download_dir),
            "source_score": source_score.__dict__ if source_score else None,
            "whisper_score": whisper_score.__dict__ if whisper_score else None,
        }
        return report

    def _remove_source_subtitles(self, info) -> None:
        for item in getattr(info, "subtitle_files", []) or []:
            relative = item.get("filename") if isinstance(item, dict) else None
            if not relative:
                continue
            path = Path(os.path.realpath(os.path.join(self.download_dir, relative)))
            if (
                os.path.commonpath((self.download_dir, str(path))) == self.download_dir
                and path.suffix.lower() in {".srt", ".vtt"}
            ):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    log.warning("Could not remove transcription caption input %s: %s", path, exc)

    @staticmethod
    def _source_is_manual(info, source_path: Path) -> bool:
        entry = getattr(info, "entry", {}) or {}
        manual_languages = entry.get("subtitles") or {}
        configured = str(getattr(info, "transcription_language", "auto"))
        if configured != "auto":
            return configured in manual_languages
        stem_parts = source_path.name.split(".")
        language = stem_parts[-2] if len(stem_parts) > 2 else ""
        return language in manual_languages

    def _source_subtitle(self, info) -> Path | None:
        for item in getattr(info, "subtitle_files", []) or []:
            relative = item.get("filename") if isinstance(item, dict) else None
            if not relative:
                continue
            path = Path(os.path.realpath(os.path.join(self.download_dir, relative)))
            if os.path.commonpath((self.download_dir, str(path))) == self.download_dir and path.suffix.lower() == ".srt" and path.is_file():
                return path
        return None
