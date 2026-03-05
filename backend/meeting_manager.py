"""
MM Zettai - Meeting WebSocket Manager
Handles real-time meeting communication, participant management, and audio processing.
"""

import asyncio
import logging
import os
import tempfile
from datetime import datetime
from typing import Dict, List, Optional, Set

from fastapi import WebSocket

import database as db
import models

logger = logging.getLogger("mm_zettai.meeting")

RECORDINGS_DIR = db.RECORDINGS_DIR
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
        self.notes: str = ""                         # shared meeting notes
        # Live streaming state
        self._user_audio_locks: Dict[int, asyncio.Lock] = {}
        self._user_context: Dict[int, list] = {}     # user_id -> list of recent transcript texts
        self._user_active_transcript: Dict[int, int] = {}   # user_id -> current transcript_id being built
        self._user_accumulated_text: Dict[int, str] = {}    # user_id -> full accumulated original text
        self._last_speaker_id: Optional[int] = None          # who spoke last (room-level)

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
            "message": "You have been approved to join the meeting.",
            "notes": self.notes
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
            "pendingParticipants": pending_list,
            "notes": self.notes
        })

    async def remove_connection(self, user_id: int):
        """Remove a connection from the meeting."""
        self.connections.pop(user_id, None)
        self.pending.pop(user_id, None)
        # Clean up per-user streaming state
        self._user_audio_locks.pop(user_id, None)
        self._user_context.pop(user_id, None)
        self._user_active_transcript.pop(user_id, None)
        self._user_accumulated_text.pop(user_id, None)
        if self._last_speaker_id == user_id:
            self._last_speaker_id = None
        await self._broadcast({
            "type": "participant_left",
            "userId": user_id,
            "name": self.user_names.get(user_id, "Unknown")
        })

    def _get_user_lock(self, user_id: int) -> asyncio.Lock:
        """Get or create a per-user lock for ordered audio processing."""
        if user_id not in self._user_audio_locks:
            self._user_audio_locks[user_id] = asyncio.Lock()
        return self._user_audio_locks[user_id]

    async def process_audio(self, user_id: int, audio_data: bytes, segment_id: int = None):
        """Process an audio segment: transcribe, translate, broadcast.

        Merges continuous speech from the same speaker into one growing paragraph.
        A different speaker triggers a new bubble.
        """
        async with self._get_user_lock(user_id):
            speaker_name = self.user_names.get(user_id, "Unknown")
            speaker_lang = self.user_languages.get(user_id, "en")

            # Save audio chunk in per-meeting subdirectory
            meeting_dir = db.get_meeting_recording_dir(self.meeting_id)
            chunk_filename = f"{self.chunk_counter:06d}_{user_id}.webm"
            chunk_path = os.path.join(meeting_dir, chunk_filename)
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
                    if user_id in self.connections:
                        await self._send(self.connections[user_id], {
                            "type": "transcript_ack",
                            "segmentId": segment_id,
                            "empty": True
                        })
                    return

                # Determine continuation vs new turn
                is_continuation = (
                    self._last_speaker_id == user_id
                    and user_id in self._user_active_transcript
                )

                # Get target languages
                target_languages = set()
                for uid, lang in self.user_languages.items():
                    if uid in self.connections and lang != speaker_lang:
                        target_languages.add(lang)

                if is_continuation:
                    # --- CONTINUATION: append to existing bubble ---
                    transcript_id = self._user_active_transcript[user_id]
                    self._user_accumulated_text[user_id] += " " + original_text
                    full_text = self._user_accumulated_text[user_id]

                    # Update DB transcript with full accumulated text
                    await db.update_transcript(transcript_id, original_text=full_text)

                    # Re-translate full paragraph and update DB
                    translations = {}
                    await self._retranslate_and_update(
                        transcript_id, full_text, speaker_lang, target_languages, translations
                    )

                    # Broadcast update (use "transcript" so late joiners auto-create the bubble)
                    for uid, ws in self.connections.items():
                        user_lang = self.user_languages.get(uid, "en")
                        message = {
                            "type": "transcript",
                            "transcriptId": transcript_id,
                            "status": "interim",
                            "speakerId": user_id,
                            "speakerName": speaker_name,
                            "originalText": full_text,
                            "originalLanguage": speaker_lang,
                            "timestamp": datetime.utcnow().isoformat()
                        }
                        if user_lang == speaker_lang:
                            message["displayText"] = full_text
                        else:
                            translated = translations.get(user_lang, full_text)
                            message["displayText"] = translated
                            if translated != full_text:
                                message["translatedText"] = full_text
                        try:
                            await self._send(ws, message)
                        except Exception as e:
                            logger.error(f"Failed to send update to user {uid}: {e}")

                else:
                    # --- NEW TURN: create a new bubble ---
                    transcript_id = await db.save_transcript(
                        self.meeting_id, user_id, speaker_name, original_text, speaker_lang
                    )

                    # Set up active transcript state
                    self._user_active_transcript[user_id] = transcript_id
                    self._user_accumulated_text[user_id] = original_text
                    self._last_speaker_id = user_id

                    # Translate first segment with context from previous paragraphs
                    translations = {}
                    context_texts = self._user_context.get(user_id, [])
                    translation_tasks = []
                    for target_lang in target_languages:
                        translation_tasks.append(
                            self._translate_and_store_with_context(
                                transcript_id, original_text, speaker_lang, target_lang,
                                translations, context_texts
                            )
                        )
                    if translation_tasks:
                        await asyncio.gather(*translation_tasks)

                    # Broadcast new bubble
                    for uid, ws in self.connections.items():
                        user_lang = self.user_languages.get(uid, "en")
                        message = {
                            "type": "transcript",
                            "transcriptId": transcript_id,
                            "status": "interim",
                            "speakerId": user_id,
                            "speakerName": speaker_name,
                            "originalText": original_text,
                            "originalLanguage": speaker_lang,
                            "timestamp": datetime.utcnow().isoformat()
                        }
                        if user_lang == speaker_lang:
                            message["displayText"] = original_text
                        else:
                            translated = translations.get(user_lang, original_text)
                            message["displayText"] = translated
                            if translated != original_text:
                                message["translatedText"] = original_text
                        try:
                            await self._send(ws, message)
                        except Exception as e:
                            logger.error(f"Failed to send to user {uid}: {e}")

                # Send ack back to speaker
                if user_id in self.connections:
                    await self._send(self.connections[user_id], {
                        "type": "transcript_ack",
                        "segmentId": segment_id,
                        "transcriptId": transcript_id,
                        "empty": False
                    })

            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    async def _retranslate_and_update(self, transcript_id: int, full_text: str,
                                       source_lang: str, target_languages: set,
                                       translations_dict: dict):
        """Re-translate full accumulated text and upsert translations in DB."""
        tasks = []
        for target_lang in target_languages:
            tasks.append(
                self._retranslate_one(transcript_id, full_text, source_lang, target_lang, translations_dict)
            )
        if tasks:
            await asyncio.gather(*tasks)

    async def _retranslate_one(self, transcript_id: int, full_text: str,
                                source_lang: str, target_lang: str, translations_dict: dict):
        """Re-translate full text for one target language and upsert in DB."""
        translated = await models.translate_text(full_text, source_lang, target_lang)
        translations_dict[target_lang] = translated
        await db.upsert_translation(transcript_id, target_lang, translated)

    async def finalize_speech(self, user_id: int):
        """Called when user stops speaking (mic off or 5s silence).
        Marks the active paragraph bubble as final."""
        async with self._get_user_lock(user_id):
            await self._do_finalize_speech(user_id)

    async def _do_finalize_speech(self, user_id: int):
        """Internal finalize logic, called under per-user lock."""
        transcript_id = self._user_active_transcript.pop(user_id, None)
        accumulated = self._user_accumulated_text.pop(user_id, None)

        # Save accumulated text as context for future paragraphs
        if accumulated:
            if user_id not in self._user_context:
                self._user_context[user_id] = []
            self._user_context[user_id].append(accumulated)
            self._user_context[user_id] = self._user_context[user_id][-5:]

        if transcript_id is not None:
            # Mark bubble as final
            for uid, ws in self.connections.items():
                try:
                    await self._send(ws, {
                        "type": "transcript_update",
                        "transcriptId": transcript_id,
                        "status": "final"
                    })
                except Exception:
                    pass

        # Broadcast coherence_complete (safety net for frontend)
        await self._broadcast({
            "type": "coherence_complete",
            "speakerId": user_id
        })

    async def handle_chat(self, user_id: int, message: str):
        """Handle a chat message: save to DB and broadcast."""
        user_name = self.user_names.get(user_id, "Unknown")
        await db.save_chat_message(self.meeting_id, user_id, user_name, message)
        await self._broadcast({
            "type": "chat",
            "userId": user_id,
            "userName": user_name,
            "message": message,
            "timestamp": datetime.utcnow().isoformat()
        })

    async def handle_reaction(self, user_id: int, reaction_type: str):
        """Handle a reaction: broadcast only (transient, no DB)."""
        await self._broadcast({
            "type": "reaction",
            "userId": user_id,
            "userName": self.user_names.get(user_id, "Unknown"),
            "reaction": reaction_type
        })

    async def handle_action_item(self, user_id: int, assigned_to: int, description: str):
        """Handle manual action item creation during a meeting."""
        user_name = self.user_names.get(user_id, "Unknown")
        item_id = await db.save_action_item(self.meeting_id, user_id, assigned_to, description)
        item = await db.get_action_item(item_id)
        if not item:
            return
        # Notify assignee if different from creator
        if assigned_to != user_id:
            meeting = await db.get_meeting(self.meeting_id)
            meeting_name = meeting["name"] if meeting else "a meeting"
            await db.create_notification(
                assigned_to, "action_item_assigned", "New Action Item",
                f'{user_name} assigned you a task in "{meeting_name}": {description[:100]}',
                self.meeting_id
            )
        # Broadcast to all participants
        await self._broadcast({
            "type": "action_item_created",
            "item": item
        })

    async def handle_note_update(self, user_id: int, content: str):
        """Handle shared notes update: save to DB and broadcast to others."""
        self.notes = content
        await db.update_meeting_notes(self.meeting_id, content)
        await self._broadcast({
            "type": "note_update",
            "userId": user_id,
            "content": content
        }, exclude={user_id})

    async def _translate_and_store(self, transcript_id, text, source_lang, target_lang, translations_dict):
        """Translate text and store result."""
        translated = await models.translate_text(text, source_lang, target_lang)
        translations_dict[target_lang] = translated
        await db.save_translation(transcript_id, target_lang, translated)

    async def _translate_and_store_with_context(self, transcript_id, text, source_lang,
                                                  target_lang, translations_dict, context_texts):
        """Translate text with context and store result."""
        translated = await models.translate_text_with_context(
            text, source_lang, target_lang, context_texts
        )
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
