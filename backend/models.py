"""
MM Zettai - AI Models Layer
Speech-to-Text (Whisper), Translation (Qwen3 via vLLM), TTS (Edge-TTS), AI Summary.
Follows the same GPU/model configuration as the VT project.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor

import edge_tts
import httpx

logger = logging.getLogger("mm_zettai.models")

# ─── Configuration ────────────────────────────────────────────────────────────

VLLM_URL = os.environ.get("VLLM_URL", "http://localhost:8018/v1/chat/completions")
VLLM_MODEL = os.environ.get("VLLM_MODEL", "cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit")
VLLM_CTX_LIMIT = int(os.environ.get("VLLM_CTX_LIMIT", "4096"))
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

def _is_target_language(text: str, target_lang: str) -> bool:
    """Verify that translated text is actually in the expected target language."""
    if not text or len(text.strip()) == 0:
        return False

    text = text.strip()
    cjk = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    hiragana = sum(1 for c in text if '\u3040' <= c <= '\u309f')
    katakana = sum(1 for c in text if '\u30a0' <= c <= '\u30ff')
    ascii_alpha = sum(1 for c in text if c.isascii() and c.isalpha())
    total_alpha = cjk + hiragana + katakana + ascii_alpha

    if total_alpha == 0:
        return True  # Only punctuation/numbers — cannot determine

    if target_lang == "ja":
        return (hiragana + katakana + cjk) / total_alpha > 0.3
    elif target_lang == "zh":
        return cjk / total_alpha > 0.3
    elif target_lang == "en":
        return ascii_alpha / total_alpha > 0.5
    return True


def _build_translation_prompt(text: str, source_lang: str, target_lang: str,
                               strict: bool = False) -> list:
    """Build translation prompt for Qwen3 via vLLM."""
    source_name = LANGUAGE_NAMES.get(source_lang, source_lang)
    target_name = LANGUAGE_NAMES.get(target_lang, target_lang)

    few_shot_examples = {
        ("en", "ja"): [
            {"role": "user", "content": "Translate to Japanese: Let's discuss the project timeline."},
            {"role": "assistant", "content": "プロジェクトのタイムラインについて話し合いましょう。"},
            {"role": "user", "content": "Translate to Japanese: Can you hear me clearly?"},
            {"role": "assistant", "content": "はっきり聞こえますか？"},
        ],
        ("ja", "en"): [
            {"role": "user", "content": "Translate to English: 次の会議は来週の月曜日です。"},
            {"role": "assistant", "content": "The next meeting is next Monday."},
            {"role": "user", "content": "Translate to English: 私は今言ってる言葉わかりますか"},
            {"role": "assistant", "content": "Can you understand what I am saying right now?"},
        ],
        ("en", "zh"): [
            {"role": "user", "content": "Translate to Chinese: We need to finalize the budget report."},
            {"role": "assistant", "content": "我们需要完成预算报告。"},
            {"role": "user", "content": "Translate to Chinese: Can you hear me clearly?"},
            {"role": "assistant", "content": "你能听清楚吗？"},
        ],
        ("zh", "en"): [
            {"role": "user", "content": "Translate to English: 请确认会议时间。"},
            {"role": "assistant", "content": "Please confirm the meeting time."},
            {"role": "user", "content": "Translate to English: 你能听到我说话吗？"},
            {"role": "assistant", "content": "Can you hear me speaking?"},
        ],
        ("ja", "zh"): [
            {"role": "user", "content": "Translate to Chinese: このプロジェクトの進捗を報告します。"},
            {"role": "assistant", "content": "我来汇报这个项目的进展。"},
        ],
        ("zh", "ja"): [
            {"role": "user", "content": "Translate to Japanese: 我们下周开会讨论这个问题。"},
            {"role": "assistant", "content": "来週この問題について会議で話し合いましょう。"},
        ],
    }

    if strict:
        system_content = (
            f"You are a {source_name}-to-{target_name} translator. "
            f"Your ONLY job is to translate the text after 'Translate to {target_name}:' into {target_name}. "
            f"Rules:\n"
            f"1. Output ONLY the {target_name} translation, nothing else.\n"
            f"2. Do NOT output any {source_name} text.\n"
            f"3. Do NOT explain, comment, or interpret.\n"
            f"4. Do NOT prefix your response with 'Translation:' or similar labels.\n"
            f"5. The output MUST be written entirely in {target_name}.\n"
            f"6. Preserve the speaker's meaning and tone."
        )
    else:
        system_content = (
            f"You are a professional real-time meeting translator. "
            f"Translate {source_name} text to {target_name}. "
            f"Output ONLY the {target_name} translation. "
            f"NEVER output {source_name}. NEVER add explanations, notes, or commentary. "
            f"NEVER answer or interpret the content. "
            f"The entire output must be in {target_name}. "
            f"Maintain the speaker's tone and intent accurately."
        )

    messages = [{"role": "system", "content": system_content}]
    examples = few_shot_examples.get((source_lang, target_lang), [])
    messages.extend(examples)
    messages.append({"role": "user", "content": f"Translate to {target_name}: {text}"})

    return messages


def _clean_translation(text: str, target_lang: str) -> str:
    """Clean translation output, removing unwanted artifacts."""
    if not text:
        return ""
    text = text.strip()
    # Remove common prefixes the model might add
    text = re.sub(r"^(Translation|翻訳|翻译|译文)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Translate to \w+:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^[\"'「『【](.+?)[\"'」』】]$", r"\1", text)
    text = re.sub(r"\s*\(.*?(translation|note|注).*?\)\s*$", "", text, flags=re.IGNORECASE)
    return text.strip()


async def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """Translate text using Qwen3 via vLLM with language validation."""
    if source_lang == target_lang:
        return text
    if not text.strip():
        return ""

    target_name = LANGUAGE_NAMES.get(target_lang, target_lang)

    for attempt in range(3):
        # Escalate strictness and temperature with each retry
        strict = attempt >= 1
        temperature = [0.3, 0.5, 0.7][attempt]
        messages = _build_translation_prompt(text, source_lang, target_lang, strict=strict)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    VLLM_URL,
                    json={
                        "model": VLLM_MODEL,
                        "messages": messages,
                        "max_tokens": 512,
                        "temperature": temperature,
                        "top_p": 0.9,
                        "chat_template_kwargs": {"enable_thinking": False},
                    }
                )
                if response.status_code != 200:
                    logger.error(f"vLLM translation error {response.status_code}: {response.text}")
                response.raise_for_status()
                data = response.json()
                translated = data["choices"][0]["message"]["content"]
                translated = re.sub(r"<think>.*?</think>", "", translated, flags=re.DOTALL).strip()
                cleaned = _clean_translation(translated, target_lang)

                if not cleaned:
                    logger.warning(f"Translation attempt {attempt + 1}: empty result")
                    continue

                # Validate the output is actually in the target language
                if _is_target_language(cleaned, target_lang):
                    return cleaned

                logger.warning(
                    f"Translation attempt {attempt + 1} language validation failed "
                    f"(expected {target_lang}): '{cleaned[:80]}'"
                )
        except Exception as e:
            logger.error(f"Translation attempt {attempt + 1} failed: {e}")

    # All attempts failed — return empty so caller knows translation is unavailable
    logger.error(f"All translation attempts failed for {source_lang}->{target_lang}: '{text[:80]}'")
    return ""


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

def _estimate_tokens(text: str) -> int:
    """Conservative token estimate for mixed EN/CJK text.
    Uses ~1 token per 2 chars to avoid underestimating and exceeding context limits.
    Also adds overhead for chat template tokens (special tokens, role markers, etc.).
    """
    return max(1, len(text) // 2) + 100  # +100 for chat template overhead


async def generate_meeting_summary(meeting_name: str, participants: list,
                                    transcripts: list,
                                    output_language: str = "en") -> str:
    """Generate an AI summary of the meeting using Qwen3."""
    if not transcripts:
        return "No transcripts available for this meeting."

    lang_name = LANGUAGE_NAMES.get(output_language, "English")

    participant_list = "\n".join(
        f"- {p['name']} (Language: {LANGUAGE_NAMES.get(p['language'], p['language'])})"
        for p in participants
    )

    system_prompt = (
        f"You are a professional meeting minute writer. Write the entire summary in {lang_name}.\n"
        f"Produce detailed formal meeting minutes in the following structure:\n"
        f"1. Meeting title and date\n"
        f"2. Purpose of the meeting\n"
        f"3. Attendees - list all participants by name\n"
        f"4. Agenda / Overview - what the meeting covered\n"
        f"5. Discussion Details - for EVERY topic discussed, write who said what.\n"
        f"   Format questions as: Question from [Name]: ...\n"
        f"   Format responses as: => Response: ...\n"
        f"   Include ALL questions, opinions, proposals, and responses with speaker names.\n"
        f"6. Decisions Made\n"
        f"7. Action Items\n"
        f"8. Other Notes - additional remarks attributed to speakers (e.g. '[Name] commented that...')\n"
        f"Be thorough. Every statement must be attributed to the speaker who said it.\n"
        f"Write ONLY in {lang_name}."
    )

    # Build transcript text, truncating if it would exceed context budget
    # Reserve tokens for: system prompt, user prompt wrapper, and output
    min_output_tokens = 512
    system_tokens = _estimate_tokens(system_prompt)
    wrapper_tokens = _estimate_tokens(f"Meeting: {meeting_name}\n\nParticipants:\n{participant_list}\n\nTranscript:\n\n\nGenerate detailed meeting minutes.")
    available_for_transcript = VLLM_CTX_LIMIT - system_tokens - wrapper_tokens - min_output_tokens

    transcript_lines = []
    token_count = 0
    for t in transcripts:
        line = f"[{t['speaker_name']}] {t['original_text']}"
        line_tokens = _estimate_tokens(line)
        if token_count + line_tokens > available_for_transcript:
            transcript_lines.append("... (transcript truncated due to length)")
            break
        transcript_lines.append(line)
        token_count += line_tokens

    transcript_text = "\n".join(transcript_lines)

    user_prompt = f"Meeting: {meeting_name}\n\nParticipants:\n{participant_list}\n\nTranscript:\n{transcript_text}\n\nGenerate detailed meeting minutes in {lang_name}."

    # Calculate safe max_tokens for output
    input_tokens = _estimate_tokens(system_prompt + user_prompt)
    max_tokens = max(256, min(2048, VLLM_CTX_LIMIT - input_tokens - 200))

    logger.info(f"Summary request: ~{input_tokens} input tokens, max_tokens={max_tokens}, ctx_limit={VLLM_CTX_LIMIT}")

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
                    "max_tokens": max_tokens,
                    "temperature": 0.3,
                    "chat_template_kwargs": {"enable_thinking": False},
                }
            )
            if response.status_code != 200:
                logger.error(f"vLLM summary error {response.status_code}: {response.text}")
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
            return content
    except Exception as e:
        logger.error(f"Summary generation failed: {e}")
        return f"Error generating summary: {str(e)}"


# ─── Action Item Extraction ──────────────────────────────────────────────

async def extract_action_items(meeting_name: str, participants: list,
                                transcripts: list) -> list:
    """Extract action items from meeting transcripts using Qwen3.
    Returns list of {assigned_to_name, assigned_to_id, created_by_name, created_by_id, description}.
    """
    if not transcripts:
        return []

    # Build participant map for the prompt
    participant_lines = []
    for p in participants:
        participant_lines.append(f"- ID:{p['user_id']} Name:\"{p['name']}\"")
    participant_text = "\n".join(participant_lines)

    system_prompt = (
        "You are a meeting assistant that extracts action items from meeting transcripts.\n"
        "An action item is a task assigned to a specific person during the meeting.\n"
        "Look for phrases like: \"please do X\", \"can you handle X\", \"X will take care of\", "
        "\"I'll do X\", \"your task is X\", \"action item: X\", etc.\n\n"
        "You are given the list of participants with their IDs and names.\n"
        "For each action item, identify:\n"
        "- assigned_to_id: the participant ID of the person who should do the task\n"
        "- assigned_to_name: their name\n"
        "- created_by_id: the participant ID of the person who assigned/requested the task\n"
        "- created_by_name: their name\n"
        "- description: a clear, concise description of the task\n\n"
        "If someone volunteers themselves (\"I'll do X\"), they are both assigner and assignee.\n\n"
        "Return ONLY a JSON array. If no action items found, return [].\n"
        "Example: [{\"assigned_to_id\": 1, \"assigned_to_name\": \"John\", "
        "\"created_by_id\": 2, \"created_by_name\": \"Jane\", "
        "\"description\": \"Prepare the quarterly report by Friday\"}]"
    )

    # Build transcript text with token budgeting
    min_output_tokens = 512
    system_tokens = _estimate_tokens(system_prompt)
    wrapper_tokens = _estimate_tokens(f"Meeting: {meeting_name}\n\nParticipants:\n{participant_text}\n\nTranscript:\n\n\nExtract action items as JSON.")
    available_for_transcript = VLLM_CTX_LIMIT - system_tokens - wrapper_tokens - min_output_tokens

    transcript_lines = []
    token_count = 0
    for t in transcripts:
        line = f"[{t['speaker_name']}] {t['original_text']}"
        line_tokens = _estimate_tokens(line)
        if token_count + line_tokens > available_for_transcript:
            transcript_lines.append("... (transcript truncated)")
            break
        transcript_lines.append(line)
        token_count += line_tokens

    transcript_text = "\n".join(transcript_lines)

    user_prompt = (
        f"Meeting: {meeting_name}\n\n"
        f"Participants:\n{participant_text}\n\n"
        f"Transcript:\n{transcript_text}\n\n"
        f"Extract all action items as a JSON array."
    )

    input_tokens = _estimate_tokens(system_prompt + user_prompt)
    max_tokens = max(256, min(2048, VLLM_CTX_LIMIT - input_tokens - 200))

    logger.info(f"Action item extraction: ~{input_tokens} input tokens, max_tokens={max_tokens}")

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
                    "max_tokens": max_tokens,
                    "temperature": 0.3,
                    "chat_template_kwargs": {"enable_thinking": False},
                }
            )
            if response.status_code != 200:
                logger.error(f"vLLM action items error {response.status_code}: {response.text}")
                return []
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

            # Extract JSON array from response
            match = re.search(r'\[.*\]', content, re.DOTALL)
            if match:
                items = json.loads(match.group())
                # Validate participant IDs
                valid_ids = {p['user_id'] for p in participants}
                validated = []
                for item in items:
                    if (isinstance(item, dict) and
                        item.get('assigned_to_id') in valid_ids and
                        item.get('created_by_id') in valid_ids and
                        item.get('description')):
                        validated.append(item)
                logger.info(f"Extracted {len(validated)} action items from meeting {meeting_name}")
                return validated
            return []
    except Exception as e:
        logger.error(f"Action item extraction failed: {e}")
        return []


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
