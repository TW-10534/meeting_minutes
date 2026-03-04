"""
MM Zettai - Main Backend Application
FastAPI server with REST API and WebSocket endpoints for the meeting system.
"""

import asyncio
import base64
import logging
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
import models
from auth import (
    hash_password, verify_password, create_access_token,
    get_current_user, get_user_from_token, decode_token
)
from meeting_manager import manager, RECORDINGS_DIR

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("mm_zettai")


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting MM Zettai backend...")
    await db.init_db()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, models.load_whisper)
    logger.info("MM Zettai backend ready.")
    yield
    logger.info("Shutting down MM Zettai backend.")


app = FastAPI(title="MM Zettai", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Request Models ───────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    employee_id: str
    password: str

class RegisterRequest(BaseModel):
    employee_id: str
    password: str
    name: str
    preferred_language: str = "en"

class CreateMeetingRequest(BaseModel):
    name: str
    language: str = "en"
    scheduled_at: Optional[str] = None

class JoinMeetingRequest(BaseModel):
    code: str
    language: str = "en"

class UpdateSettingsRequest(BaseModel):
    name: Optional[str] = None
    preferred_language: Optional[str] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None

class InviteUsersRequest(BaseModel):
    user_ids: list[int]

class UpdateTranscriptRequest(BaseModel):
    original_text: Optional[str] = None
    speaker_name: Optional[str] = None

class CreateActionItemRequest(BaseModel):
    assigned_to: int
    description: str

class UpdateActionItemRequest(BaseModel):
    status: Optional[str] = None
    description: Optional[str] = None


# ─── Auth Endpoints ───────────────────────────────────────────────────────────

@app.post("/api/auth/register")
async def register(req: RegisterRequest):
    existing = await db.get_user_by_employee_id(req.employee_id)
    if existing:
        raise HTTPException(status_code=400, detail="Employee ID already registered")
    hashed = hash_password(req.password)
    user = await db.create_user(req.employee_id, hashed, req.name, req.preferred_language)
    token = create_access_token(user["id"], user["employee_id"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "employee_id": user["employee_id"],
            "name": user["name"],
            "preferred_language": user["preferred_language"]
        }
    }


@app.post("/api/auth/login")
async def login(req: LoginRequest):
    user = await db.get_user_by_employee_id(req.employee_id)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user["id"], user["employee_id"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "employee_id": user["employee_id"],
            "name": user["name"],
            "preferred_language": user["preferred_language"]
        }
    }


@app.get("/api/auth/me")
async def get_me(user=Depends(get_current_user)):
    return {
        "id": user["id"],
        "employee_id": user["employee_id"],
        "name": user["name"],
        "preferred_language": user["preferred_language"]
    }


@app.put("/api/auth/settings")
async def update_settings(req: UpdateSettingsRequest, user=Depends(get_current_user)):
    updates = {}
    if req.name:
        updates["name"] = req.name
    if req.preferred_language:
        updates["preferred_language"] = req.preferred_language
    if req.new_password:
        if not req.current_password:
            raise HTTPException(status_code=400, detail="Current password required")
        if not verify_password(req.current_password, user["password_hash"]):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        updates["password_hash"] = hash_password(req.new_password)
    if updates:
        await db.update_user(user["id"], **updates)
    return {"status": "ok"}


# ─── Users Endpoint ──────────────────────────────────────────────────────

SUPERADMIN_EID = "10534"


@app.get("/api/users")
async def list_users(user=Depends(get_current_user)):
    users = await db.get_all_users()
    return users


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, user=Depends(get_current_user)):
    if user["employee_id"] != SUPERADMIN_EID:
        raise HTTPException(status_code=403, detail="Only super admin can delete users")
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    target = await db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await db.delete_user(user_id)
    logger.info(f"Super admin {user['employee_id']} deleted user {target['employee_id']} ({target['name']})")
    return {"status": "deleted", "user_id": user_id}


# ─── Meeting Endpoints ────────────────────────────────────────────────────────

@app.post("/api/meetings")
async def create_meeting(req: CreateMeetingRequest, user=Depends(get_current_user)):
    meeting = await db.create_meeting(req.name, user["id"], req.language, req.scheduled_at)
    return meeting


@app.get("/api/meetings")
async def list_meetings(user=Depends(get_current_user)):
    meetings = await db.get_user_meetings(user["id"])
    return meetings


@app.post("/api/meetings/join")
async def request_join(req: JoinMeetingRequest, user=Depends(get_current_user)):
    meeting = await db.get_meeting_by_code(req.code)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting["status"] not in ("scheduled", "active"):
        raise HTTPException(status_code=400, detail="Meeting is not active")
    participant = await db.add_participant(meeting["id"], user["id"], req.language)
    return {"meeting_id": meeting["id"], "participant": participant}


@app.get("/api/meetings/code/{code}")
async def get_meeting_by_code(code: str, user=Depends(get_current_user)):
    meeting = await db.get_meeting_by_code(code)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting


@app.get("/api/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    participants = await db.get_meeting_participants(meeting_id)
    return {**meeting, "participants": participants}


@app.post("/api/meetings/{meeting_id}/start")
async def start_meeting(meeting_id: str, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only host can start meeting")
    await db.update_meeting(meeting_id, status="active", started_at=datetime.utcnow().isoformat())
    return {"status": "active"}


@app.post("/api/meetings/{meeting_id}/end")
async def end_meeting(meeting_id: str, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only host can end meeting")

    await db.update_meeting(meeting_id, status="completed", ended_at=datetime.utcnow().isoformat())

    # Save notes from meeting room if available
    room = manager.get_room(meeting_id)
    if room and room.notes:
        await db.update_meeting_notes(meeting_id, room.notes)

    # Generate AI summary
    participants = await db.get_meeting_participants(meeting_id, status="approved")
    transcripts = await db.get_meeting_transcripts(meeting_id)
    summary = await models.generate_meeting_summary(meeting["name"], participants, transcripts)
    await db.update_meeting(meeting_id, summary=summary)

    # Extract action items
    action_items_data = await models.extract_action_items(meeting["name"], participants, transcripts)
    saved_items = []
    for ai_item in action_items_data:
        item_id = await db.save_action_item(
            meeting_id, ai_item["created_by_id"], ai_item["assigned_to_id"], ai_item["description"]
        )
        item = await db.get_action_item(item_id)
        if item:
            saved_items.append(item)
            # Notify assignee
            if ai_item["assigned_to_id"] != ai_item["created_by_id"]:
                await db.create_notification(
                    ai_item["assigned_to_id"], "action_item_assigned", "New Action Item",
                    f'Task from "{meeting["name"]}": {ai_item["description"][:100]}',
                    meeting_id
                )

    # Create "Summary Ready" notification for all participants
    for p in participants:
        await db.create_notification(
            p["user_id"], "summary_ready", "Summary Ready",
            f"The summary for \"{meeting['name']}\" is now available",
            meeting_id
        )

    # Notify all participants via WebSocket
    if room:
        for uid, ws in room.connections.items():
            try:
                await ws.send_json({
                    "type": "meeting_ended",
                    "summary": summary,
                    "actionItems": saved_items
                })
            except Exception:
                pass
        manager.remove_room(meeting_id)

    return {"status": "completed", "summary": summary, "actionItems": saved_items}


@app.get("/api/meetings/{meeting_id}/participants")
async def list_participants(meeting_id: str, user=Depends(get_current_user)):
    participants = await db.get_meeting_participants(meeting_id)
    return participants


@app.post("/api/meetings/{meeting_id}/approve/{user_id}")
async def approve_participant(meeting_id: str, user_id: int, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting or meeting["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only host can approve")
    room = manager.get_room(meeting_id)
    if room:
        await room.approve_participant(user_id)
    else:
        await db.update_participant_status(meeting_id, user_id, "approved")
    return {"status": "approved"}


@app.post("/api/meetings/{meeting_id}/reject/{user_id}")
async def reject_participant(meeting_id: str, user_id: int, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting or meeting["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only host can reject")
    room = manager.get_room(meeting_id)
    if room:
        await room.reject_participant(user_id)
    else:
        await db.update_participant_status(meeting_id, user_id, "rejected")
    return {"status": "rejected"}


@app.post("/api/meetings/{meeting_id}/invite")
async def invite_users(meeting_id: str, req: InviteUsersRequest, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only host can invite users")
    # Filter out self, then batch-invite all users in a single transaction
    user_ids = [uid for uid in req.user_ids if uid != user["id"]]
    invited = await db.batch_invite_users(meeting_id, user_ids, user["name"], meeting["name"])
    return {"invited": invited}


# ─── Transcript & Minutes Endpoints ──────────────────────────────────────────

@app.get("/api/meetings/{meeting_id}/transcripts")
async def get_transcripts(meeting_id: str, limit: int = 0, offset: int = 0,
                          user=Depends(get_current_user)):
    transcripts = await db.get_meeting_transcripts(meeting_id, limit=limit, offset=offset)
    total = await db.get_meeting_transcript_count(meeting_id) if limit > 0 else len(transcripts)
    return {"transcripts": transcripts, "total": total}


@app.get("/api/meetings/{meeting_id}/summary")
async def get_summary(meeting_id: str, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"summary": meeting.get("summary", "")}


# ─── Transcript Edit Endpoint ─────────────────────────────────────────────

@app.put("/api/transcripts/{transcript_id}")
async def edit_transcript(transcript_id: int, req: UpdateTranscriptRequest, user=Depends(get_current_user)):
    transcript = await db.get_transcript_by_id(transcript_id)
    if not transcript:
        raise HTTPException(status_code=404, detail="Transcript not found")
    meeting = await db.get_meeting(transcript["meeting_id"])
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    # Only host or superadmin can edit
    if meeting["host_id"] != user["id"] and user["employee_id"] != SUPERADMIN_EID:
        raise HTTPException(status_code=403, detail="Only host or admin can edit transcripts")
    updates = {}
    if req.original_text is not None:
        updates["original_text"] = req.original_text
    if req.speaker_name is not None:
        updates["speaker_name"] = req.speaker_name
    if updates:
        await db.update_transcript(transcript_id, **updates)
    return {"status": "ok"}


# ─── Notification Endpoints ──────────────────────────────────────────────

@app.get("/api/notifications")
async def get_notifications(user=Depends(get_current_user)):
    notifications = await db.get_user_notifications(user["id"])
    unread_count = await db.get_unread_notification_count(user["id"])
    return {"notifications": notifications, "unread_count": unread_count}


@app.post("/api/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: int, user=Depends(get_current_user)):
    await db.mark_notification_read(notification_id, user["id"])
    return {"status": "ok"}


@app.post("/api/notifications/read-all")
async def mark_all_notifications_read(user=Depends(get_current_user)):
    await db.mark_all_notifications_read(user["id"])
    return {"status": "ok"}


# ─── Search Endpoint ─────────────────────────────────────────────────────

@app.get("/api/search")
async def search(q: str = "", from_date: str = None, to_date: str = None,
                 participant: int = None, language: str = None,
                 user=Depends(get_current_user)):
    if not q.strip():
        return []
    results = await db.search_meetings_and_transcripts(
        q.strip(), user["id"], from_date, to_date, participant, language
    )
    return results


# ─── Delete Meeting Endpoint ─────────────────────────────────────────────

@app.delete("/api/meetings/{meeting_id}")
async def delete_meeting_endpoint(meeting_id: str, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    # Any participant can delete
    participant = await db.get_participant(meeting_id, user["id"])
    is_host = meeting["host_id"] == user["id"]
    if not participant and not is_host:
        raise HTTPException(status_code=403, detail="You are not a participant of this meeting")
    await db.delete_meeting_cascade(meeting_id)
    logger.info(f"User {user['employee_id']} ({user['name']}) deleted meeting {meeting_id} ({meeting['name']})")
    return {"status": "deleted"}


# ─── Chat History Endpoint ───────────────────────────────────────────────

@app.get("/api/meetings/{meeting_id}/chat")
async def get_meeting_chat(meeting_id: str, limit: int = 0, offset: int = 0,
                           user=Depends(get_current_user)):
    messages = await db.get_meeting_chat_messages(meeting_id, limit=limit, offset=offset)
    total = await db.get_meeting_chat_count(meeting_id) if limit > 0 else len(messages)
    return {"messages": messages, "total": total}


# ─── Action Item Endpoints ───────────────────────────────────────────

@app.get("/api/meetings/{meeting_id}/action-items")
async def get_action_items(meeting_id: str, user=Depends(get_current_user)):
    items = await db.get_meeting_action_items(meeting_id)
    return items


@app.post("/api/meetings/{meeting_id}/action-items")
async def create_action_item(meeting_id: str, req: CreateActionItemRequest, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    # Verify assignee exists
    assignee = await db.get_user_by_id(req.assigned_to)
    if not assignee:
        raise HTTPException(status_code=400, detail="Assigned user not found")
    item_id = await db.save_action_item(meeting_id, user["id"], req.assigned_to, req.description)
    # Create notification for assignee
    if req.assigned_to != user["id"]:
        await db.create_notification(
            req.assigned_to, "action_item_assigned", "New Action Item",
            f'{user["name"]} assigned you a task in "{meeting["name"]}": {req.description[:100]}',
            meeting_id
        )
    item = await db.get_action_item(item_id)
    return item


@app.put("/api/action-items/{item_id}")
async def update_action_item(item_id: int, req: UpdateActionItemRequest, user=Depends(get_current_user)):
    item = await db.get_action_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Action item not found")
    # Only assignee, creator, or host can update
    meeting = await db.get_meeting(item["meeting_id"])
    if user["id"] not in (item["assigned_to"], item["created_by"]) and (not meeting or meeting["host_id"] != user["id"]):
        raise HTTPException(status_code=403, detail="Not authorized to update this action item")
    updates = {}
    if req.status:
        valid_statuses = {"pending", "accepted", "declined", "completed"}
        if req.status not in valid_statuses:
            raise HTTPException(status_code=400, detail="Invalid status")
        updates["status"] = req.status
        if req.status == "completed":
            updates["completed_at"] = datetime.utcnow().isoformat()
    if req.description is not None:
        updates["description"] = req.description
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    updated = await db.update_action_item(item_id, **updates)
    # Notify creator when completed
    if req.status == "completed" and item["created_by"] != user["id"]:
        await db.create_notification(
            item["created_by"], "action_item_completed", "Action Item Completed",
            f'{user["name"]} completed: {item["description"][:100]}',
            item["meeting_id"]
        )
    return updated


@app.get("/api/my-action-items")
async def get_my_action_items(user=Depends(get_current_user)):
    items = await db.get_user_action_items(user["id"])
    return items


class RegenerateSummaryRequest(BaseModel):
    language: str = "en"


@app.post("/api/meetings/{meeting_id}/regenerate-summary")
async def regenerate_summary(meeting_id: str, req: RegenerateSummaryRequest, user=Depends(get_current_user)):
    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only host can regenerate summary")
    participants = await db.get_meeting_participants(meeting_id, status="approved")
    transcripts = await db.get_meeting_transcripts(meeting_id)
    summary = await models.generate_meeting_summary(
        meeting["name"], participants, transcripts, output_language=req.language
    )
    await db.update_meeting(meeting_id, summary=summary)
    return {"summary": summary}


@app.get("/api/meetings/{meeting_id}/recording")
async def get_recording(meeting_id: str, user=Depends(get_current_user)):
    """List available recording chunks for a meeting."""
    chunks = db.get_meeting_recording_files(meeting_id)
    if not chunks:
        raise HTTPException(status_code=404, detail="No recordings found")
    return {"chunks": chunks, "meeting_id": meeting_id}


@app.get("/api/recordings/{meeting_id}/{filename}")
async def serve_recording_new(meeting_id: str, filename: str):
    """Serve recording file from per-meeting subdirectory."""
    path = db.get_recording_file_path(meeting_id, filename)
    if not path:
        raise HTTPException(status_code=404, detail="Recording not found")
    return FileResponse(path, media_type="audio/webm")


@app.get("/api/recordings/{filename}")
async def serve_recording(filename: str):
    """Serve recording file (legacy flat directory fallback)."""
    safe_name = os.path.basename(filename)
    path = os.path.join(RECORDINGS_DIR, safe_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Recording not found")
    return FileResponse(path, media_type="audio/webm")


# ─── Audio Processing Endpoint ────────────────────────────────────────────────

@app.post("/api/meetings/{meeting_id}/audio")
async def process_audio(
    meeting_id: str,
    audio: UploadFile = File(...),
    user=Depends(get_current_user)
):
    """Process audio from a meeting participant - transcribe and translate."""
    meeting = await db.get_meeting(meeting_id)
    if not meeting or meeting["status"] != "active":
        raise HTTPException(status_code=400, detail="Meeting not active")

    participant = await db.get_participant(meeting_id, user["id"])
    if not participant or participant["status"] != "approved":
        raise HTTPException(status_code=403, detail="Not an approved participant")

    audio_data = await audio.read()
    if len(audio_data) < 100:
        return {"status": "empty"}

    room = manager.get_room(meeting_id)
    if room:
        await room.process_audio(user["id"], audio_data)

    return {"status": "processed"}


# ─── TTS Endpoint ─────────────────────────────────────────────────────────────

@app.post("/api/tts")
async def generate_tts(text: str = Form(...), language: str = Form("en")):
    path = await models.text_to_speech(text, language)
    if not path:
        raise HTTPException(status_code=500, detail="TTS generation failed")
    return FileResponse(path, media_type="audio/mpeg")


# ─── Health Check ─────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    status = await models.check_health()
    return status


# ─── WebSocket Endpoint ──────────────────────────────────────────────────────

@app.websocket("/ws/meeting/{meeting_id}")
async def meeting_websocket(websocket: WebSocket, meeting_id: str):
    await websocket.accept()

    # Authenticate via query param
    token = websocket.query_params.get("token")
    language = websocket.query_params.get("language", "en")

    if not token:
        await websocket.send_json({"type": "error", "message": "Authentication required"})
        await websocket.close()
        return

    token_data = get_user_from_token(token)
    if not token_data:
        await websocket.send_json({"type": "error", "message": "Invalid token"})
        await websocket.close()
        return

    user_id = token_data["id"]
    user = await db.get_user_by_id(user_id)
    if not user:
        await websocket.send_json({"type": "error", "message": "User not found"})
        await websocket.close()
        return

    meeting = await db.get_meeting(meeting_id)
    if not meeting:
        await websocket.send_json({"type": "error", "message": "Meeting not found"})
        await websocket.close()
        return

    room = manager.get_or_create_room(meeting_id)
    is_host = meeting["host_id"] == user_id

    try:
        if is_host:
            await room.add_host(user_id, websocket, user["name"], language)
        else:
            participant = await db.get_participant(meeting_id, user_id)
            if participant and participant["status"] == "approved":
                room.connections[user_id] = websocket
                room.user_languages[user_id] = language
                room.user_names[user_id] = user["name"]
                participants = [
                    {"userId": uid, "name": room.user_names.get(uid, "Unknown"),
                     "language": room.user_languages.get(uid, "en")}
                    for uid in room.connections
                ]
                await websocket.send_json({
                    "type": "approved",
                    "participants": participants,
                    "notes": room.notes
                })
                await room._broadcast({
                    "type": "participant_joined",
                    "userId": user_id,
                    "name": user["name"],
                    "language": language
                }, exclude={user_id})
            else:
                await db.add_participant(meeting_id, user_id, language)
                await room.add_pending(user_id, websocket, user["name"], language)

        # Message loop
        while True:
            try:
                data = await websocket.receive_json()
            except Exception:
                # Malformed JSON or connection issue
                break
            msg_type = data.get("type")

            if msg_type == "approve" and is_host:
                target_id = data.get("userId")
                if target_id:
                    await room.approve_participant(int(target_id))

            elif msg_type == "reject" and is_host:
                target_id = data.get("userId")
                if target_id:
                    await room.reject_participant(int(target_id))

            elif msg_type == "audio":
                audio_b64 = data.get("data")
                if audio_b64:
                    audio_bytes = base64.b64decode(audio_b64)
                    await room.process_audio(user_id, audio_bytes)

            elif msg_type == "chat":
                chat_msg = (data.get("message") or "").strip()
                if chat_msg and len(chat_msg) <= 2000:
                    await room.handle_chat(user_id, chat_msg)

            elif msg_type == "reaction":
                reaction_type = data.get("reaction")
                allowed_reactions = {"hand", "thumbsup", "clap", "heart", "laugh"}
                if reaction_type in allowed_reactions:
                    await room.handle_reaction(user_id, reaction_type)

            elif msg_type == "note_update":
                content = data.get("content", "")
                if len(content) <= 50000:
                    await room.handle_note_update(user_id, content)

            elif msg_type == "add_action_item":
                assigned_to = data.get("assignedTo")
                desc = (data.get("description") or "").strip()
                if assigned_to and desc and len(desc) <= 2000:
                    await room.handle_action_item(user_id, int(assigned_to), desc)

            elif msg_type == "end_meeting" and is_host:
                # Save notes before ending
                if room.notes:
                    await db.update_meeting_notes(meeting_id, room.notes)
                # End meeting via WebSocket
                await db.update_meeting(meeting_id, status="completed",
                                       ended_at=datetime.utcnow().isoformat())
                participants = await db.get_meeting_participants(meeting_id, status="approved")
                transcripts = await db.get_meeting_transcripts(meeting_id)
                summary = await models.generate_meeting_summary(
                    meeting["name"], participants, transcripts
                )
                await db.update_meeting(meeting_id, summary=summary)

                # Extract action items
                action_items_data = await models.extract_action_items(
                    meeting["name"], participants, transcripts
                )
                saved_items = []
                for ai_item in action_items_data:
                    item_id = await db.save_action_item(
                        meeting_id, ai_item["created_by_id"],
                        ai_item["assigned_to_id"], ai_item["description"]
                    )
                    item = await db.get_action_item(item_id)
                    if item:
                        saved_items.append(item)
                        if ai_item["assigned_to_id"] != ai_item["created_by_id"]:
                            await db.create_notification(
                                ai_item["assigned_to_id"], "action_item_assigned",
                                "New Action Item",
                                f'Task from "{meeting["name"]}": {ai_item["description"][:100]}',
                                meeting_id
                            )

                # Create "Summary Ready" notification for all participants
                for p in participants:
                    await db.create_notification(
                        p["user_id"], "summary_ready", "Summary Ready",
                        f"The summary for \"{meeting['name']}\" is now available",
                        meeting_id
                    )
                await room._broadcast({
                    "type": "meeting_ended",
                    "summary": summary,
                    "actionItems": saved_items
                })
                manager.remove_room(meeting_id)
                break

    except WebSocketDisconnect:
        logger.info(f"User {user_id} disconnected from meeting {meeting_id}")
    except Exception as e:
        logger.error(f"WebSocket error for user {user_id}: {e}")
    finally:
        if manager.get_room(meeting_id):
            await room.remove_connection(user_id)
            if room.is_empty():
                manager.remove_room(meeting_id)


# ─── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_NOFILE, (4096, 4096))
    except (ImportError, Exception):
        pass

    import uvicorn
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8003,
        workers=1,
        timeout_keep_alive=300,
        log_level="info"
    )
