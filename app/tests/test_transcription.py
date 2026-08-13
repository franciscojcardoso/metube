from pathlib import Path
from types import SimpleNamespace

from aiohttp import web

from transcription import TranscriptionService, choose_best, cues_to_markdown, parse_srt


def test_parse_srt_accepts_comma_and_dot_timestamps():
    cues = parse_srt(
        "1\n00:00:00,500 --> 00:00:02.000\nOlá mundo\n\n"
        "2\n00:00:02,100 --> 00:00:03,000\nTudo bem?\n"
    )
    assert cues == [(0.5, 2.0, "Olá mundo"), (2.1, 3.0, "Tudo bem?")]


def test_high_confidence_whisper_beats_sparse_automatic_caption():
    source = [(0, 1, "ola ola ola")]
    whisper = [(0, 9, "Olá, este é um conteúdo completo e bem transcrito.")]
    winner, source_score, whisper_score = choose_best(
        source,
        whisper,
        duration=10,
        source_is_manual=False,
        whisper_confidence=0.95,
    )
    assert winner == "whisper"
    assert whisper_score.score > source_score.score


def test_near_tie_prefers_manual_caption():
    source = [(0, 9, "Esta é uma transcrição de boa qualidade")]
    whisper = [(0, 9, "Esta é uma transcrição com boa qualidade")]
    winner, _, _ = choose_best(
        source,
        whisper,
        duration=10,
        source_is_manual=True,
        whisper_confidence=0.9,
    )
    assert winner == "source"


def test_markdown_has_yaml_metadata_and_timestamp_sections():
    markdown = cues_to_markdown(
        [(1, 3, "Primeiro trecho."), (301, 304, "Segundo trecho.")],
        {
            "title": "Vídeo: exemplo",
            "source_url": "https://example.com/video",
            "selected_source": "whisper",
            "model": "whisper-1",
            "quality": {"source": None, "whisper": {"score": 0.9}},
        },
    )
    assert markdown.startswith('---\ntitle: "Vídeo: exemplo"')
    assert "selected_source: \"whisper\"" in markdown
    assert "quality:\n  source:\n    available: false" in markdown
    assert "### 00:00:01" in markdown
    assert "### 00:05:01" in markdown


async def test_transcription_writes_only_markdown_next_to_media(tmp_path, aiohttp_server):
    async def transcriptions(request):
        await request.post()
        return web.json_response({
            "language": "pt",
            "text": "Olá mundo",
            "segments": [{
                "start": 0,
                "end": 2,
                "text": "Olá mundo",
                "avg_logprob": -0.1,
                "no_speech_prob": 0.01,
            }],
        })

    app = web.Application()
    app.router.add_post("/v1/audio/transcriptions", transcriptions)
    server = await aiohttp_server(app)
    config = SimpleNamespace(
        TRANSCRIPTION_URL=str(server.make_url("/v1/audio/transcriptions")),
        TRANSCRIPTION_API_KEY="",
        TRANSCRIPTION_MODEL="small",
        TRANSCRIPTION_TIMEOUT=30,
        DOWNLOAD_DIR=str(tmp_path),
    )
    media_dir = tmp_path / "curso"
    media_dir.mkdir()
    media = media_dir / "aula.m4a"
    media.write_bytes(b"audio")

    result = await TranscriptionService(config).transcribe(SimpleNamespace(
        filename="curso/aula.m4a",
        title="Aula",
        url=None,
        subtitle_files=[],
        entry={"duration": 2},
        transcription_language="auto",
    ))

    markdown = media_dir / "aula.md"
    assert result["markdown"] == "curso/aula.md"
    assert markdown.is_file()
    assert markdown.parent == media.parent
    assert "Olá mundo" in markdown.read_text(encoding="utf-8")
    assert sorted(path.name for path in media_dir.iterdir()) == ["aula.m4a", "aula.md"]
    assert set(result) == {"winner", "markdown", "source_score", "whisper_score"}


async def test_comparison_caption_is_removed_after_markdown_is_written(tmp_path, aiohttp_server):
    async def transcriptions(request):
        await request.post()
        return web.json_response({
            "language": "pt",
            "segments": [{"start": 0, "end": 2, "text": "Texto Whisper"}],
        })

    app = web.Application()
    app.router.add_post("/transcribe", transcriptions)
    server = await aiohttp_server(app)
    config = SimpleNamespace(
        TRANSCRIPTION_URL=str(server.make_url("/transcribe")),
        TRANSCRIPTION_API_KEY="",
        TRANSCRIPTION_MODEL="small",
        TRANSCRIPTION_TIMEOUT=30,
        DOWNLOAD_DIR=str(tmp_path),
    )
    media = tmp_path / "video.mp4"
    media.write_bytes(b"video")
    subtitle = tmp_path / "video.pt.srt"
    subtitle.write_text(
        "1\n00:00:00,000 --> 00:00:02,000\nTexto da legenda\n",
        encoding="utf-8",
    )
    info = SimpleNamespace(
        filename="video.mp4",
        title="Vídeo",
        url="https://example.com/video",
        subtitle_files=[{"filename": "video.pt.srt"}],
        entry={"duration": 2, "subtitles": {"pt": [{}]}},
        transcription_language="pt",
    )

    result = await TranscriptionService(config).transcribe(info)

    assert Path(tmp_path / result["markdown"]).is_file()
    assert not subtitle.exists()
    assert sorted(path.name for path in tmp_path.iterdir()) == ["video.md", "video.mp4"]
