"""
MM Zettai - AI Models Layer
Speech-to-Text (Whisper), Translation (Qwen3 via vLLM), TTS (Edge-TTS), AI Summary.
Follows the same GPU/model configuration as the VT project.
"""

import asyncio
import hashlib
import logging
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor

import edge_tts
import httpx

logger = logging.getLogger("mm_zettai.models")

# ─── Configuration ────────────────────────────────────────────────────────────

VLLM_URL = os.environ.get("VLLM_URL", "http://localhost:8010/v1/chat/completions")
VLLM_MODEL = os.environ.get("VLLM_MODEL", "Qwen/Qwen3-Omni-30B-A3B-Instruct")
WHISPER_DEVICE = int(os.environ.get("WHISPER_DEVICE", "2"))
TTS_CACHE_DIR = os.path.join(tempfile.gettempdir(), "mm_zettai_tts_cache")

# Whisper model instance
whisper_model = None
executor = ThreadPoolExecutor(max_workers=4)

# Language configuration
LANGUAGE_NAMES = {"en": "English", "ja": "Japanese", "zh": "Chinese"}

TTS_VOICES = {
    "en": "en-US-JennyNeural",
    "ja": "ja-JP-NanamiNeural",
    "zh": "zh-CN-XiaoxiaoNeural"
}

WHISPER_LANG_MAP = {"en": "en", "ja": "ja", "zh": "zh"}

# Whisper hallucination patterns
HALLUCINATION_PATTERNS = [
    r"thank you for watching",
    r"thanks for watching",
    r"please subscribe",
    r"like and subscribe",
    r"see you next time",
    r"goodbye",
    r"thank you for listening",
    r"please like",
    r"don't forget to subscribe",
    r"hit the bell",
    r"leave a comment",
    r"check out my",
    r"follow me on",
    r"link in the description",
    r"sponsored by",
    r"ご視聴ありがとうございました",
    r"チャンネル登録",
    r"おやすみなさい",
    r"お疲れ様でした",
    r"ありがとうございました",
    r"感谢收看",
    r"请订阅",
]

# ─── Model Loading ────────────────────────────────────────────────────────────

def load_whisper():
    """Load Whisper model on GPU."""
    global whisper_model
    from faster_whisper import WhisperModel
    logger.info(f"Loading Whisper large-v3 on GPU {WHISPER_DEVICE}...")
    whisper_model = WhisperModel(
        "large-v3",
        device="cuda",
        device_index=WHISPER_DEVICE,
        compute_type="float16"
    )
    logger.info("Whisper model loaded successfully.")
    os.makedirs(TTS_CACHE_DIR, exist_ok=True)


# ─── Speech-to-Text ──────────────────────────────────────────────────────────

def _transcribe_sync(audio_path: str, language: str = None) -> str:
    """Synchronous Whisper transcription."""
    if whisper_model is None:
        raise RuntimeError("Whisper model not loaded")

    kwargs = {
        "beam_size": 5,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500}
    }
    if language and language in WHISPER_LANG_MAP:
        kwargs["language"] = WHISPER_LANG_MAP[language]

    segments, info = whisper_model.transcribe(audio_path, **kwargs)
    text_parts = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        is_hallucination = False
        text_lower = text.lower()
        for pattern in HALLUCINATION_PATTERNS:
            if re.search(pattern, text_lower):
                is_hallucination = True
                break
        if not is_hallucination:
            text_parts.append(text)

    return " ".join(text_parts).strip()


async def transcribe_audio(audio_path: str, language: str = None) -> str:
    """Async wrapper for Whisper transcription."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, _transcribe_sync, audio_path, language)


# ─── Translation ──────────────────────────────────────────────────────────────

def _build_translation_prompt(text: str, source_lang: str, target_lang: str) -> list:
    """Build translation prompt for Qwen3 via vLLM."""
    source_name = LANGUAGE_NAMES.get(source_lang, source_lang)
    target_name = LANGUAGE_NAMES.get(target_lang, target_lang)

    few_shot_examples = {
        ("en", "ja"): [
            {"role": "user", "content": "Let's discuss the project timeline."},
            {"role": "assistant", "content": "プロジェクトのタイムラインについて話し合いましょう。"}
        ],
        ("ja", "en"): [
            {"role": "user", "content": "次の会議は来週の月曜日です。"},
            {"role": "assistant", "content": "The next meeting is next Monday."}
        ],
        ("en", "zh"): [
            {"role": "user", "content": "We need to finalize the budget report."},
            {"role": "assistant", "content": "我们需要完成预算报告。"}
        ],
        ("zh", "en"): [
            {"role": "user", "content": "请确认会议时间。"},
            {"role": "assistant", "content": "Please confirm the meeting time."}
        ],
        ("ja", "zh"): [
            {"role": "user", "content": "このプロジェクトの進捗を報告します。"},
            {"role": "assistant", "content": "我来汇报这个项目的进展。"}
        ],
        ("zh", "ja"): [
            {"role": "user", "content": "我们下周开会讨论这个问题。"},
            {"role": "assistant", "content": "来週この問題について会議で話し合いましょう。"}
        ],
    }

    system_message = {
        "role": "system",
        "content": (
            f"You are a professional real-time meeting translator. "
            f"Translate {source_name} to {target_name}. "
            f"Output ONLY the {target_name} translation. "
            f"NEVER output {source_name}. "
            f"NEVER add explanations, notes, or commentary. "
            f"NEVER answer or interpret the content. "
            f"Maintain the speaker's tone and intent accurately."
        )
    }

    messages = [system_message]
    examples = few_shot_examples.get((source_lang, target_lang), [])
    messages.extend(examples)
    messages.append({"role": "user", "content": text})

    return messages


def _clean_translation(text: str, target_lang: str) -> str:
    """Clean translation output, removing unwanted artifacts."""
    if not text:
        return ""
    text = text.strip()
    text = re.sub(r"^(Translation|翻訳|翻译|译文)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^[\"'「『【](.+?)[\"'」』】]$", r"\1", text)
    text = re.sub(r"\s*\(.*?(translation|note|注).*?\)\s*$", "", text, flags=re.IGNORECASE)
    return text.strip()


async def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """Translate text using Qwen3 via vLLM."""
    if source_lang == target_lang:
        return text
    if not text.strip():
        return ""

    messages = _build_translation_prompt(text, source_lang, target_lang)

    for attempt in range(2):
        temperature = 0.3 if attempt == 0 else 0.5
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    VLLM_URL,
                    json={
                        "model": VLLM_MODEL,
                        "messages": messages,
                        "max_tokens": 2048,
                        "temperature": temperature,
                        "top_p": 0.9,
                    }
                )
                response.raise_for_status()
                data = response.json()
                translated = data["choices"][0]["message"]["content"]
                cleaned = _clean_translation(translated, target_lang)
                if cleaned:
                    return cleaned
        except Exception as e:
            logger.error(f"Translation attempt {attempt + 1} failed: {e}")
            if attempt == 1:
                return f"[Translation error: {text}]"

    return text


# ─── Text-to-Speech ──────────────────────────────────────────────────────────

async def text_to_speech(text: str, language: str) -> str:
    """Generate TTS audio file using Edge-TTS. Returns file path."""
    voice = TTS_VOICES.get(language, TTS_VOICES["en"])
    cache_key = hashlib.md5(f"{text}:{voice}".encode()).hexdigest()
    cache_path = os.path.join(TTS_CACHE_DIR, f"{cache_key}.mp3")

    if os.path.exists(cache_path):
        return cache_path

    try:
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(cache_path)
        return cache_path
    except Exception as e:
        logger.error(f"TTS generation failed: {e}")
        return None


# ─── AI Summary Generation ───────────────────────────────────────────────────

async def generate_meeting_summary(meeting_name: str, participants: list,
                                    transcripts: list) -> str:
    """Generate an AI summary of the meeting using Qwen3."""
    if not transcripts:
        return "No transcripts available for this meeting."

    participant_list = "\n".join(
        f"- {p['name']} (Language: {LANGUAGE_NAMES.get(p['language'], p['language'])})"
        for p in participants
    )

    transcript_text = "\n".join(
        f"[{t['timestamp']}] {t['speaker_name']} ({LANGUAGE_NAMES.get(t['original_language'], t['original_language'])}): {t['original_text']}"
        for t in transcripts
    )

    system_prompt = """You are a professional meeting minute writer. Generate a comprehensive, well-structured meeting summary from the provided transcript.

Your summary MUST include these sections:
1. **Meeting Overview** - Brief description of the meeting purpose and context
2. **Participants** - List of attendees and their roles
3. **Key Discussion Points** - Main topics discussed, organized by theme
4. **Decisions Made** - Any decisions or agreements reached
5. **Action Items** - Tasks assigned, with responsible persons if identifiable
6. **Speaker Contributions** - Brief summary of each speaker's main points

Write in clear, professional English. Be specific about who said what.
Use bullet points for clarity. Keep the summary concise but comprehensive."""

    user_prompt = f"""Meeting: {meeting_name}

Participants:
{participant_list}

Full Transcript:
{transcript_text}

Please generate the meeting summary."""

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                VLLM_URL,
                json={
                    "model": VLLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    "max_tokens": 4096,
                    "temperature": 0.3,
                }
            )
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"Summary generation failed: {e}")
        return f"Error generating summary: {str(e)}"


# ─── Health Check ─────────────────────────────────────────────────────────────

async def check_health() -> dict:
    """Check model health status."""
    status = {"whisper": whisper_model is not None, "vllm": False}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(VLLM_URL.replace("/chat/completions", "/models"))
            status["vllm"] = resp.status_code == 200
    except Exception:
        pass
    return status
