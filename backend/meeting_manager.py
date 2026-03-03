"""
MM Zettai - Meeting WebSocket Manager
Handles real-time meeting communication, participant management, and audio processing.
"""

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime
from typing import Dict, List, Set

from fastapi import WebSocket

import database as db
import models

logger = logging.getLogger("mm_zettai.meeting")

RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)


class MeetingRoom:
    """Manages a single active meeting."""

    def __init__(self, meeting_id: str):
        self.meeting_id = meeting_id
        self.connections: Dict[int, WebSocket] = {}  # user_id -> websocket
        self.user_languages: Dict[int, str] = {}     # user_id -> language
        self.user_names: Dict[int, str] = {}         # user_id -> display name
        self.pending: Dict[int, WebSocket] = {}      # user_id -> websocket (waiting room)
        self.audio_chunks: List[str] = []            # paths to audio chunks
        self.chunk_counter = 0

    async def add_pending(self, user_id: int, ws: WebSocket, name: str, language: str):
        """Add a participant to the waiting room."""
        self.pending[user_id] = ws
        self.user_languages[user_id] = language
        self.user_names[user_id] = name
        await self._send(ws, {
            "type": "waiting",
            "message": "Waiting for host approval..."
        })
        # Notify host about pending participant
        host_id = await self._get_host_id()
        if host_id and host_id in self.connections:
            await self._send(self.connections[host_id], {
                "type": "pending_participant",
                "userId": user_id,
                "name": name,
                "language": language
            })

    async def approve_participant(self, user_id: int):
        """Move participant from waiting room to active meeting."""
        if user_id not in self.pending:
            return False
        ws = self.pending.pop(user_id)
        self.connections[user_id] = ws
        await db.update_participant_status(self.meeting_id, user_id, "approved")

        await self._send(ws, {
            "type": "approved",
            "message": "You have been approved to join the meeting."
        })

        # Send current participant list to the new participant
        participants = []
        for uid, name in self.user_names.items():
            if uid in self.connections:
                participants.append({
                    "userId": uid,
                    "name": name,
                    "language": self.user_languages.get(uid, "en")
                })
        await self._send(ws, {"type": "participant_list", "participants": participants})

        # Notify all existing participants about the new one
        await self._broadcast({
            "type": "participant_joined",
            "userId": user_id,
            "name": self.user_names.get(user_id, "Unknown"),
            "language": self.user_languages.get(user_id, "en")
        }, exclude={user_id})

        return True

    async def reject_participant(self, user_id: int):
        """Reject a pending participant."""
        if user_id not in self.pending:
            return False
        ws = self.pending.pop(user_id)
        await db.update_participant_status(self.meeting_id, user_id, "rejected")
        await self._send(ws, {
            "type": "rejected",
            "message": "Your request to join was declined."
        })
        try:
            await ws.close()
        except Exception:
            pass
        return True

    async def add_host(self, user_id: int, ws: WebSocket, name: str, language: str):
        """Add the host directly to the meeting."""
        self.connections[user_id] = ws
        self.user_languages[user_id] = language
        self.user_names[user_id] = name

        # Send pending participants list to host
        pending_list = [
            {"userId": uid, "name": self.user_names.get(uid, "Unknown"),
             "language": self.user_languages.get(uid, "en")}
            for uid in self.pending
        ]
        participants = [
            {"userId": uid, "name": self.user_names.get(uid, "Unknown"),
             "language": self.user_languages.get(uid, "en")}
            for uid in self.connections
        ]
        await self._send(ws, {
            "type": "host_joined",
            "participants": participants,
            "pendingParticipants": pending_list
        })

    async def remove_connection(self, user_id: int):
        """Remove a connection from the meeting."""
        self.connections.pop(user_id, None)
        self.pending.pop(user_id, None)
        await self._broadcast({
            "type": "participant_left",
            "userId": user_id,
            "name": self.user_names.get(user_id, "Unknown")
        })

    async def process_audio(self, user_id: int, audio_data: bytes):
        """Process an audio chunk: transcribe, translate, broadcast."""
        speaker_name = self.user_names.get(user_id, "Unknown")
        speaker_lang = self.user_languages.get(user_id, "en")

        # Save audio chunk for recording
        chunk_path = os.path.join(
            RECORDINGS_DIR,
            f"{self.meeting_id}_{self.chunk_counter:06d}_{user_id}.webm"
        )
        self.chunk_counter += 1
        with open(chunk_path, "wb") as f:
            f.write(audio_data)
        self.audio_chunks.append(chunk_path)

        # Save to temp file for Whisper
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(audio_data)
            tmp_path = tmp.name

        try:
            # Transcribe
            original_text = await models.transcribe_audio(tmp_path, speaker_lang)
            if not original_text.strip():
                return

            # Save transcript to DB
            transcript_id = await db.save_transcript(
                self.meeting_id, user_id, speaker_name, original_text, speaker_lang
            )

            # Get all unique target languages in the meeting (excluding speaker's language)
            target_languages = set()
            for uid, lang in self.user_languages.items():
                if uid in self.connections and lang != speaker_lang:
                    target_languages.add(lang)

            # Translate to each target language
            translations = {}
            translation_tasks = []
            for target_lang in target_languages:
                translation_tasks.append(
                    self._translate_and_store(
                        transcript_id, original_text, speaker_lang, target_lang, translations
                    )
                )
            if translation_tasks:
                await asyncio.gather(*translation_tasks)

            # Broadcast transcript and translations to all participants
            for uid, ws in self.connections.items():
                user_lang = self.user_languages.get(uid, "en")
                message = {
                    "type": "transcript",
                    "speakerId": user_id,
                    "speakerName": speaker_name,
                    "originalText": original_text,
                    "originalLanguage": speaker_lang,
                    "timestamp": datetime.utcnow().isoformat()
                }
                if user_lang == speaker_lang:
                    message["displayText"] = original_text
                else:
                    message["displayText"] = translations.get(user_lang, original_text)
                    message["translatedText"] = translations.get(user_lang, "")
                try:
                    await self._send(ws, message)
                except Exception as e:
                    logger.error(f"Failed to send to user {uid}: {e}")

        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    async def _translate_and_store(self, transcript_id, text, source_lang, target_lang, translations_dict):
        """Translate text and store result."""
        translated = await models.translate_text(text, source_lang, target_lang)
        translations_dict[target_lang] = translated
        await db.save_translation(transcript_id, target_lang, translated)

    async def _get_host_id(self):
        """Get the host user ID for this meeting."""
        meeting = await db.get_meeting(self.meeting_id)
        return meeting["host_id"] if meeting else None

    async def _send(self, ws: WebSocket, data: dict):
        """Send JSON message to a WebSocket."""
        try:
            await ws.send_json(data)
        except Exception as e:
            logger.error(f"WebSocket send error: {e}")

    async def _broadcast(self, data: dict, exclude: set = None):
        """Broadcast message to all active connections."""
        exclude = exclude or set()
        for uid, ws in self.connections.items():
            if uid not in exclude:
                await self._send(ws, data)

    def get_audio_chunks(self):
        return self.audio_chunks

    def is_empty(self):
        return len(self.connections) == 0 and len(self.pending) == 0


class MeetingManager:
    """Global meeting room manager."""

    def __init__(self):
        self.rooms: Dict[str, MeetingRoom] = {}

    def get_or_create_room(self, meeting_id: str) -> MeetingRoom:
        if meeting_id not in self.rooms:
            self.rooms[meeting_id] = MeetingRoom(meeting_id)
        return self.rooms[meeting_id]

    def get_room(self, meeting_id: str) -> MeetingRoom:
        return self.rooms.get(meeting_id)

    def remove_room(self, meeting_id: str):
        self.rooms.pop(meeting_id, None)


# Global instance
manager = MeetingManager()
