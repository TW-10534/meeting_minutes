"""
MM Zettai - Database Layer
Async SQLite database for meetings, users, transcripts, and recordings.
"""

import aiosqlite
import logging
import os
import shutil
import uuid
import random
import string
from datetime import datetime, timedelta

logger = logging.getLogger("mm_zettai.db")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "meetings.db")
RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
RECORDING_RETENTION_DAYS = 90  # Auto-delete recordings older than this


def generate_meeting_code():
    """Generate a short 6-character meeting code like MTG-XXXX."""
    chars = string.ascii_uppercase + string.digits
    code = "".join(random.choices(chars, k=6))
    return f"MTG-{code}"


async def init_db():
    """Initialize database schema."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                preferred_language TEXT DEFAULT 'en',
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                code TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                host_id INTEGER NOT NULL REFERENCES users(id),
                status TEXT DEFAULT 'scheduled',
                scheduled_at TEXT,
                started_at TEXT,
                ended_at TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                summary TEXT,
                recording_path TEXT
            );

            CREATE TABLE IF NOT EXISTS meeting_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL REFERENCES meetings(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                language TEXT NOT NULL DEFAULT 'en',
                role TEXT DEFAULT 'participant',
                status TEXT DEFAULT 'pending',
                joined_at TEXT,
                UNIQUE(meeting_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL REFERENCES meetings(id),
                speaker_id INTEGER NOT NULL REFERENCES users(id),
                speaker_name TEXT NOT NULL,
                original_text TEXT NOT NULL,
                original_language TEXT NOT NULL,
                timestamp TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS translations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transcript_id INTEGER NOT NULL REFERENCES transcripts(id),
                target_language TEXT NOT NULL,
                translated_text TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_meetings_host ON meetings(host_id);
            CREATE INDEX IF NOT EXISTS idx_meetings_code ON meetings(code);
            CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
            CREATE INDEX IF NOT EXISTS idx_participants_meeting ON meeting_participants(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_participants_user ON meeting_participants(user_id);
            CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_translations_transcript ON translations(transcript_id);

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                meeting_id TEXT,
                is_read INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL REFERENCES meetings(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                user_name TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_meeting ON chat_messages(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(meeting_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(user_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_transcripts_timestamp ON transcripts(meeting_id, timestamp);

            CREATE TABLE IF NOT EXISTS action_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL REFERENCES meetings(id),
                created_by INTEGER NOT NULL REFERENCES users(id),
                assigned_to INTEGER NOT NULL REFERENCES users(id),
                description TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_action_items_assigned ON action_items(assigned_to);
            CREATE INDEX IF NOT EXISTS idx_action_items_created_by ON action_items(created_by);
        """)

        # Add notes column to meetings if not present
        try:
            await db.execute("ALTER TABLE meetings ADD COLUMN notes TEXT DEFAULT ''")
        except Exception:
            pass  # Column already exists

        # Create FTS5 virtual table for full-text search
        try:
            await db.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
                    original_text,
                    content='transcripts',
                    content_rowid='id'
                )
            """)
        except Exception:
            pass  # FTS5 may not be available

        await db.commit()

    # Run recording retention cleanup on startup
    await cleanup_old_recordings()


def _row_to_dict(row, columns):
    """Convert a sqlite row to dictionary."""
    return dict(zip(columns, row)) if row else None


async def get_db():
    """Get database connection."""
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


# ─── User Operations ─────────────────────────────────────────────────────────

async def create_user(employee_id: str, password_hash: str, name: str, preferred_language: str = "en"):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute(
            "INSERT INTO users (employee_id, password_hash, name, preferred_language) VALUES (?, ?, ?, ?)",
            (employee_id, password_hash, name, preferred_language)
        )
        await db.commit()
        cursor = await db.execute("SELECT * FROM users WHERE employee_id = ?", (employee_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_user_by_employee_id(employee_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM users WHERE employee_id = ?", (employee_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_all_users():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, employee_id, name, preferred_language, created_at FROM users ORDER BY name"
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_user_by_id(user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_user(user_id: int, **kwargs):
    ALLOWED_COLUMNS = {"name", "preferred_language", "password_hash"}
    fields = {k: v for k, v in kwargs.items() if k in ALLOWED_COLUMNS and v is not None}
    if not fields:
        return
    # Safe: column names are validated against a strict allowlist above
    set_parts = []
    values = []
    for col_name in fields:
        set_parts.append(col_name + " = ?")
        values.append(fields[col_name])
    values.append(user_id)
    query = "UPDATE users SET " + ", ".join(set_parts) + " WHERE id = ?"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(query, values)
        await db.commit()


async def delete_user(user_id: int):
    """Delete a user and all their associated data, including recording files."""
    async with aiosqlite.connect(DB_PATH) as db:
        # Get meeting IDs hosted by this user (for recording cleanup)
        cursor = await db.execute("SELECT id FROM meetings WHERE host_id = ?", (user_id,))
        hosted_meeting_ids = [r[0] for r in await cursor.fetchall()]

        # Clean up FTS entries for transcripts we're about to delete
        try:
            cursor = await db.execute("SELECT id FROM transcripts WHERE speaker_id = ?", (user_id,))
            for row in await cursor.fetchall():
                await db.execute(
                    "INSERT INTO transcripts_fts(transcripts_fts, rowid, original_text) VALUES('delete', ?, '')",
                    (row[0],)
                )
            for mid in hosted_meeting_ids:
                cursor = await db.execute("SELECT id FROM transcripts WHERE meeting_id = ?", (mid,))
                for row in await cursor.fetchall():
                    await db.execute(
                        "INSERT INTO transcripts_fts(transcripts_fts, rowid, original_text) VALUES('delete', ?, '')",
                        (row[0],)
                    )
        except Exception:
            pass  # FTS not available

        # Delete translations for this user's transcripts
        await db.execute(
            "DELETE FROM translations WHERE transcript_id IN (SELECT id FROM transcripts WHERE speaker_id = ?)",
            (user_id,)
        )
        # Delete transcripts by this user
        await db.execute("DELETE FROM transcripts WHERE speaker_id = ?", (user_id,))
        # Delete meeting participations
        await db.execute("DELETE FROM meeting_participants WHERE user_id = ?", (user_id,))
        # Delete meetings hosted by this user (cascade)
        await db.execute(
            "DELETE FROM translations WHERE transcript_id IN (SELECT id FROM transcripts WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = ?))",
            (user_id,)
        )
        await db.execute(
            "DELETE FROM transcripts WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = ?)",
            (user_id,)
        )
        await db.execute(
            "DELETE FROM meeting_participants WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = ?)",
            (user_id,)
        )
        await db.execute(
            "DELETE FROM chat_messages WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = ?)",
            (user_id,)
        )
        await db.execute(
            "DELETE FROM notifications WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = ?)",
            (user_id,)
        )
        await db.execute(
            "DELETE FROM action_items WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = ?)",
            (user_id,)
        )
        await db.execute("DELETE FROM meetings WHERE host_id = ?", (user_id,))
        # Delete notifications, chat messages, and action items by this user
        await db.execute("DELETE FROM notifications WHERE user_id = ?", (user_id,))
        await db.execute("DELETE FROM chat_messages WHERE user_id = ?", (user_id,))
        await db.execute("DELETE FROM action_items WHERE assigned_to = ? OR created_by = ?", (user_id, user_id))
        # Delete user
        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await db.commit()

    # Clean up recording files for hosted meetings
    for mid in hosted_meeting_ids:
        delete_meeting_recordings(mid)


# ─── Meeting Operations ──────────────────────────────────────────────────────

async def create_meeting(name: str, host_id: int, host_language: str, scheduled_at: str = None):
    meeting_id = str(uuid.uuid4())
    code = generate_meeting_code()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute(
            "INSERT INTO meetings (id, code, name, host_id, status, scheduled_at) VALUES (?, ?, ?, ?, ?, ?)",
            (meeting_id, code, name, host_id, "scheduled", scheduled_at)
        )
        await db.execute(
            "INSERT INTO meeting_participants (meeting_id, user_id, language, role, status) VALUES (?, ?, ?, 'host', 'approved')",
            (meeting_id, host_id, host_language)
        )
        await db.commit()
        cursor = await db.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_meeting(meeting_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_meeting_by_code(code: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM meetings WHERE code = ?", (code.upper(),))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_user_meetings(user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT m.*, mp.role, mp.language as my_language, mp.status as my_status,
                   u.name as host_name
            FROM meetings m
            JOIN meeting_participants mp ON m.id = mp.meeting_id AND mp.user_id = ?
            JOIN users u ON m.host_id = u.id
            ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC
        """, (user_id,))
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def update_meeting(meeting_id: str, **kwargs):
    ALLOWED_COLUMNS = {"name", "status", "started_at", "ended_at", "summary", "recording_path", "scheduled_at", "notes"}
    fields = {k: v for k, v in kwargs.items() if k in ALLOWED_COLUMNS}
    if not fields:
        return
    # Safe: column names are validated against a strict allowlist above
    set_parts = []
    values = []
    for col_name in fields:
        set_parts.append(col_name + " = ?")
        values.append(fields[col_name])
    values.append(meeting_id)
    query = "UPDATE meetings SET " + ", ".join(set_parts) + " WHERE id = ?"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(query, values)
        await db.commit()


# ─── Participant Operations ───────────────────────────────────────────────────

async def add_participant(meeting_id: str, user_id: int, language: str, role: str = "participant"):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # Check if participant already exists
        cursor = await db.execute(
            "SELECT status FROM meeting_participants WHERE meeting_id = ? AND user_id = ?",
            (meeting_id, user_id)
        )
        existing = await cursor.fetchone()
        if existing:
            # If already approved or host, keep their status; only update language
            if existing["status"] in ("approved",):
                await db.execute(
                    "UPDATE meeting_participants SET language = ? WHERE meeting_id = ? AND user_id = ?",
                    (language, meeting_id, user_id)
                )
            else:
                await db.execute(
                    "UPDATE meeting_participants SET language = ?, status = 'pending' WHERE meeting_id = ? AND user_id = ?",
                    (language, meeting_id, user_id)
                )
            await db.commit()
        else:
            await db.execute(
                "INSERT INTO meeting_participants (meeting_id, user_id, language, role, status) VALUES (?, ?, ?, ?, 'pending')",
                (meeting_id, user_id, language, role)
            )
            await db.commit()
        cursor = await db.execute(
            "SELECT mp.*, u.name, u.employee_id FROM meeting_participants mp JOIN users u ON mp.user_id = u.id WHERE mp.meeting_id = ? AND mp.user_id = ?",
            (meeting_id, user_id)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_participant_status(meeting_id: str, user_id: int, status: str):
    async with aiosqlite.connect(DB_PATH) as db:
        joined = datetime.utcnow().isoformat() if status == "approved" else None
        if joined:
            await db.execute(
                "UPDATE meeting_participants SET status = ?, joined_at = ? WHERE meeting_id = ? AND user_id = ?",
                (status, joined, meeting_id, user_id)
            )
        else:
            await db.execute(
                "UPDATE meeting_participants SET status = ? WHERE meeting_id = ? AND user_id = ?",
                (status, meeting_id, user_id)
            )
        await db.commit()


async def get_meeting_participants(meeting_id: str, status: str = None):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if status:
            cursor = await db.execute(
                "SELECT mp.*, u.name, u.employee_id FROM meeting_participants mp JOIN users u ON mp.user_id = u.id WHERE mp.meeting_id = ? AND mp.status = ?",
                (meeting_id, status)
            )
        else:
            cursor = await db.execute(
                "SELECT mp.*, u.name, u.employee_id FROM meeting_participants mp JOIN users u ON mp.user_id = u.id WHERE mp.meeting_id = ?",
                (meeting_id,)
            )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_participant(meeting_id: str, user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT mp.*, u.name, u.employee_id FROM meeting_participants mp JOIN users u ON mp.user_id = u.id WHERE mp.meeting_id = ? AND mp.user_id = ?",
            (meeting_id, user_id)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


# ─── Transcript Operations ────────────────────────────────────────────────────

async def save_transcript(meeting_id: str, speaker_id: int, speaker_name: str,
                          original_text: str, original_language: str):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO transcripts (meeting_id, speaker_id, speaker_name, original_text, original_language) VALUES (?, ?, ?, ?, ?)",
            (meeting_id, speaker_id, speaker_name, original_text, original_language)
        )
        transcript_id = cursor.lastrowid
        # Update FTS index
        try:
            await db.execute(
                "INSERT INTO transcripts_fts(rowid, original_text) VALUES (?, ?)",
                (transcript_id, original_text)
            )
        except Exception:
            pass  # FTS not available
        await db.commit()
        return transcript_id


async def save_translation(transcript_id: int, target_language: str, translated_text: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO translations (transcript_id, target_language, translated_text) VALUES (?, ?, ?)",
            (transcript_id, target_language, translated_text)
        )
        await db.commit()


async def get_transcript_by_id(transcript_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM transcripts WHERE id = ?", (transcript_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_transcript(transcript_id: int, **kwargs):
    ALLOWED_COLUMNS = {"original_text", "speaker_name"}
    fields = {k: v for k, v in kwargs.items() if k in ALLOWED_COLUMNS and v is not None}
    if not fields:
        return
    set_parts = []
    values = []
    for col_name in fields:
        set_parts.append(col_name + " = ?")
        values.append(fields[col_name])
    values.append(transcript_id)
    query = "UPDATE transcripts SET " + ", ".join(set_parts) + " WHERE id = ?"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(query, values)
        # Sync FTS index if text changed
        if "original_text" in fields:
            try:
                await db.execute(
                    "INSERT INTO transcripts_fts(transcripts_fts, rowid, original_text) VALUES('delete', ?, ?)",
                    (transcript_id, "")  # delete old
                )
                await db.execute(
                    "INSERT INTO transcripts_fts(rowid, original_text) VALUES (?, ?)",
                    (transcript_id, fields["original_text"])
                )
            except Exception:
                pass
        await db.commit()


async def get_meeting_transcripts(meeting_id: str, limit: int = 0, offset: int = 0):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Get transcripts with pagination
        if limit > 0:
            cursor = await db.execute(
                "SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?",
                (meeting_id, limit, offset)
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY timestamp ASC",
                (meeting_id,)
            )
        rows = await cursor.fetchall()
        if not rows:
            return []

        results = [dict(row) for row in rows]
        transcript_ids = [r["id"] for r in results]

        # Batch-fetch all translations for these transcripts
        placeholders = ",".join("?" * len(transcript_ids))
        cursor = await db.execute(
            f"SELECT transcript_id, target_language, translated_text FROM translations WHERE transcript_id IN ({placeholders})",
            transcript_ids
        )
        translation_rows = await cursor.fetchall()

        # Group translations by transcript_id
        trans_map = {}
        for tr in translation_rows:
            tid = tr[0]
            if tid not in trans_map:
                trans_map[tid] = {}
            trans_map[tid][tr[1]] = tr[2]

        for r in results:
            r["translations"] = trans_map.get(r["id"], {})

        return results


async def get_meeting_transcript_count(meeting_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?",
            (meeting_id,)
        )
        row = await cursor.fetchone()
        return row[0] if row else 0


# ─── Notification Operations ─────────────────────────────────────────────────

async def create_notification(user_id: int, type: str, title: str, message: str, meeting_id: str = None):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO notifications (user_id, type, title, message, meeting_id) VALUES (?, ?, ?, ?, ?)",
            (user_id, type, title, message, meeting_id)
        )
        await db.commit()


async def get_user_notifications(user_id: int, limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_unread_notification_count(user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0",
            (user_id,)
        )
        row = await cursor.fetchone()
        return row[0] if row else 0


async def mark_notification_read(notification_id: int, user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
            (notification_id, user_id)
        )
        await db.commit()


async def mark_all_notifications_read(user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
            (user_id,)
        )
        await db.commit()


# ─── Chat Operations ────────────────────────────────────────────────────────

async def save_chat_message(meeting_id: str, user_id: int, user_name: str, message: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO chat_messages (meeting_id, user_id, user_name, message) VALUES (?, ?, ?, ?)",
            (meeting_id, user_id, user_name, message)
        )
        await db.commit()


async def get_meeting_chat_messages(meeting_id: str, limit: int = 0, offset: int = 0):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if limit > 0:
            cursor = await db.execute(
                "SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
                (meeting_id, limit, offset)
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY created_at ASC",
                (meeting_id,)
            )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_meeting_chat_count(meeting_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM chat_messages WHERE meeting_id = ?",
            (meeting_id,)
        )
        row = await cursor.fetchone()
        return row[0] if row else 0


# ─── Notes Operations ───────────────────────────────────────────────────────

async def update_meeting_notes(meeting_id: str, notes: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE meetings SET notes = ? WHERE id = ?",
            (notes, meeting_id)
        )
        await db.commit()


# ─── Action Item Operations ──────────────────────────────────────────────

async def save_action_item(meeting_id: str, created_by: int, assigned_to: int, description: str):
    async with aiosqlite.connect(DB_PATH) as conn:
        cursor = await conn.execute(
            "INSERT INTO action_items (meeting_id, created_by, assigned_to, description) VALUES (?, ?, ?, ?)",
            (meeting_id, created_by, assigned_to, description)
        )
        item_id = cursor.lastrowid
        await conn.commit()
        return item_id


async def get_meeting_action_items(meeting_id: str):
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute("""
            SELECT ai.*,
                   creator.name as created_by_name,
                   assignee.name as assigned_to_name
            FROM action_items ai
            JOIN users creator ON ai.created_by = creator.id
            JOIN users assignee ON ai.assigned_to = assignee.id
            WHERE ai.meeting_id = ?
            ORDER BY ai.created_at ASC
        """, (meeting_id,))
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def update_action_item(item_id: int, **kwargs):
    ALLOWED_COLUMNS = {"status", "description", "completed_at"}
    fields = {k: v for k, v in kwargs.items() if k in ALLOWED_COLUMNS}
    if not fields:
        return None
    set_parts = []
    values = []
    for col_name in fields:
        set_parts.append(col_name + " = ?")
        values.append(fields[col_name])
    values.append(item_id)
    query = "UPDATE action_items SET " + ", ".join(set_parts) + " WHERE id = ?"
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute(query, values)
        await conn.commit()
    return await get_action_item(item_id)


async def get_action_item(item_id: int):
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute("""
            SELECT ai.*,
                   creator.name as created_by_name,
                   assignee.name as assigned_to_name
            FROM action_items ai
            JOIN users creator ON ai.created_by = creator.id
            JOIN users assignee ON ai.assigned_to = assignee.id
            WHERE ai.id = ?
        """, (item_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_user_action_items(user_id: int):
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute("""
            SELECT ai.*,
                   creator.name as created_by_name,
                   assignee.name as assigned_to_name,
                   m.name as meeting_name
            FROM action_items ai
            JOIN users creator ON ai.created_by = creator.id
            JOIN users assignee ON ai.assigned_to = assignee.id
            JOIN meetings m ON ai.meeting_id = m.id
            WHERE ai.assigned_to = ?
            ORDER BY ai.created_at DESC
        """, (user_id,))
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ─── Search Operations ──────────────────────────────────────────────────────

async def search_meetings_and_transcripts(query: str, user_id: int,
                                           from_date: str = None, to_date: str = None,
                                           participant_id: int = None, language: str = None,
                                           limit: int = 50, offset: int = 0):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        like_q = f"%{query}%"

        # Try FTS5 first for transcript matching
        fts_transcript_ids = set()
        try:
            fts_cursor = await db.execute(
                "SELECT rowid FROM transcripts_fts WHERE original_text MATCH ?",
                (query,)
            )
            fts_rows = await fts_cursor.fetchall()
            fts_transcript_ids = {r[0] for r in fts_rows}
        except Exception:
            pass  # FTS not available, fall back to LIKE

        conditions = ["mp.user_id = ?"]
        params = [user_id]

        if from_date:
            conditions.append("COALESCE(m.started_at, m.created_at) >= ?")
            params.append(from_date)
        if to_date:
            conditions.append("COALESCE(m.started_at, m.created_at) <= ?")
            params.append(to_date + "T23:59:59")
        if language:
            conditions.append("t.original_language = ?")
            params.append(language)

        where_clause = " AND ".join(conditions)

        if fts_transcript_ids:
            # Use FTS results: match by meeting name/summary with LIKE, or transcript via FTS rowids
            placeholders = ",".join("?" * len(fts_transcript_ids))
            search_clause = f"(m.name LIKE ? OR m.summary LIKE ? OR t.id IN ({placeholders}))"
            search_params = params + [like_q, like_q] + list(fts_transcript_ids)
        else:
            # Fallback to LIKE on all fields
            search_clause = "(m.name LIKE ? OR t.original_text LIKE ? OR m.summary LIKE ?)"
            search_params = params + [like_q, like_q, like_q]

        sql = f"""
            SELECT DISTINCT m.id as meeting_id, m.name as meeting_name, m.code, m.status,
                   m.started_at, m.ended_at, m.created_at, m.summary,
                   t.id as transcript_id, t.speaker_name, t.original_text,
                   t.original_language, t.timestamp as transcript_timestamp
            FROM meetings m
            JOIN meeting_participants mp ON m.id = mp.meeting_id
            LEFT JOIN transcripts t ON m.id = t.meeting_id
            WHERE {where_clause}
              AND {search_clause}
            ORDER BY COALESCE(m.started_at, m.created_at) DESC
            LIMIT ? OFFSET ?
        """
        search_params += [limit, offset]

        cursor = await db.execute(sql, search_params)
        rows = await cursor.fetchall()

        # Group results by meeting
        meetings = {}
        for row in rows:
            d = dict(row)
            mid = d["meeting_id"]
            if mid not in meetings:
                meetings[mid] = {
                    "meeting_id": mid,
                    "meeting_name": d["meeting_name"],
                    "code": d["code"],
                    "status": d["status"],
                    "started_at": d["started_at"],
                    "ended_at": d["ended_at"],
                    "created_at": d["created_at"],
                    "summary": d["summary"],
                    "matching_transcripts": []
                }
            if d.get("transcript_id") and query.lower() in (d.get("original_text") or "").lower():
                meetings[mid]["matching_transcripts"].append({
                    "transcript_id": d["transcript_id"],
                    "speaker_name": d["speaker_name"],
                    "original_text": d["original_text"],
                    "original_language": d["original_language"],
                    "timestamp": d["transcript_timestamp"]
                })

        return list(meetings.values())


# ─── Recording Management ─────────────────────────────────────────────────

def get_meeting_recording_dir(meeting_id: str) -> str:
    """Get per-meeting recording subdirectory path."""
    meeting_dir = os.path.join(RECORDINGS_DIR, meeting_id)
    os.makedirs(meeting_dir, exist_ok=True)
    return meeting_dir


def get_meeting_recording_files(meeting_id: str) -> list:
    """Get sorted list of recording files for a meeting (checks both old flat and new subdirectory)."""
    files = []

    # Check new per-meeting subdirectory
    meeting_dir = os.path.join(RECORDINGS_DIR, meeting_id)
    if os.path.isdir(meeting_dir):
        for f in sorted(os.listdir(meeting_dir)):
            if f.endswith((".webm", ".ogg", ".mp3")):
                files.append(f)

    # Also check old flat directory for backwards compatibility
    if not files and os.path.isdir(RECORDINGS_DIR):
        for f in sorted(os.listdir(RECORDINGS_DIR)):
            if f.startswith(meeting_id) and f.endswith((".webm", ".ogg", ".mp3")):
                files.append(f)

    return files


def get_recording_file_path(meeting_id: str, filename: str) -> str:
    """Resolve recording file path (checks subdirectory first, then flat)."""
    safe_name = os.path.basename(filename)

    # Check per-meeting subdirectory first
    sub_path = os.path.join(RECORDINGS_DIR, meeting_id, safe_name)
    if os.path.exists(sub_path):
        return sub_path

    # Fallback to flat directory
    flat_path = os.path.join(RECORDINGS_DIR, safe_name)
    if os.path.exists(flat_path):
        return flat_path

    return None


def delete_meeting_recordings(meeting_id: str):
    """Delete all recording files for a meeting."""
    # Delete per-meeting subdirectory
    meeting_dir = os.path.join(RECORDINGS_DIR, meeting_id)
    if os.path.isdir(meeting_dir):
        shutil.rmtree(meeting_dir, ignore_errors=True)
        logger.info(f"Deleted recording directory for meeting {meeting_id}")

    # Also clean up any old flat-directory files
    if os.path.isdir(RECORDINGS_DIR):
        for f in os.listdir(RECORDINGS_DIR):
            if f.startswith(meeting_id) and os.path.isfile(os.path.join(RECORDINGS_DIR, f)):
                try:
                    os.unlink(os.path.join(RECORDINGS_DIR, f))
                except Exception:
                    pass


async def delete_meeting_cascade(meeting_id: str):
    """Delete a meeting and ALL related data (transcripts, translations, chat, notifications, recordings)."""
    async with aiosqlite.connect(DB_PATH) as db:
        # Clean FTS entries
        try:
            cursor = await db.execute("SELECT id FROM transcripts WHERE meeting_id = ?", (meeting_id,))
            for row in await cursor.fetchall():
                await db.execute(
                    "INSERT INTO transcripts_fts(transcripts_fts, rowid, original_text) VALUES('delete', ?, '')",
                    (row[0],)
                )
        except Exception:
            pass

        # Delete in dependency order
        await db.execute(
            "DELETE FROM translations WHERE transcript_id IN (SELECT id FROM transcripts WHERE meeting_id = ?)",
            (meeting_id,)
        )
        await db.execute("DELETE FROM transcripts WHERE meeting_id = ?", (meeting_id,))
        await db.execute("DELETE FROM meeting_participants WHERE meeting_id = ?", (meeting_id,))
        await db.execute("DELETE FROM action_items WHERE meeting_id = ?", (meeting_id,))
        await db.execute("DELETE FROM chat_messages WHERE meeting_id = ?", (meeting_id,))
        await db.execute("DELETE FROM notifications WHERE meeting_id = ?", (meeting_id,))
        await db.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
        await db.commit()

    # Delete recording files
    delete_meeting_recordings(meeting_id)
    logger.info(f"Cascade-deleted meeting {meeting_id}")


async def cleanup_old_recordings():
    """Delete recordings older than RECORDING_RETENTION_DAYS."""
    if not os.path.isdir(RECORDINGS_DIR):
        return

    cutoff = datetime.utcnow() - timedelta(days=RECORDING_RETENTION_DAYS)
    cutoff_ts = cutoff.timestamp()
    cleaned_count = 0

    # Clean per-meeting subdirectories
    for entry in os.listdir(RECORDINGS_DIR):
        entry_path = os.path.join(RECORDINGS_DIR, entry)
        if os.path.isdir(entry_path):
            # Check if all files in dir are old
            all_old = True
            has_files = False
            for f in os.listdir(entry_path):
                fpath = os.path.join(entry_path, f)
                if os.path.isfile(fpath):
                    has_files = True
                    if os.path.getmtime(fpath) > cutoff_ts:
                        all_old = False
                        break
            if has_files and all_old:
                shutil.rmtree(entry_path, ignore_errors=True)
                cleaned_count += 1
        elif os.path.isfile(entry_path) and entry.endswith((".webm", ".ogg", ".mp3")):
            # Clean old flat-directory files
            if os.path.getmtime(entry_path) < cutoff_ts:
                try:
                    os.unlink(entry_path)
                    cleaned_count += 1
                except Exception:
                    pass

    if cleaned_count > 0:
        logger.info(f"Recording retention cleanup: removed {cleaned_count} old recordings/directories")


# ─── Batch Operations ─────────────────────────────────────────────────────

async def batch_invite_users(meeting_id: str, user_ids: list, host_name: str, meeting_name: str):
    """Invite multiple users in a single transaction (fixes N+1 query pattern)."""
    if not user_ids:
        return []

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Batch-fetch all target users
        placeholders = ",".join("?" * len(user_ids))
        cursor = await db.execute(
            f"SELECT id, name, preferred_language FROM users WHERE id IN ({placeholders})",
            user_ids
        )
        users = {row[0]: dict(row) for row in await cursor.fetchall()}

        invited = []
        for uid in user_ids:
            if uid not in users:
                continue
            target_user = users[uid]

            # Upsert participant
            cursor = await db.execute(
                "SELECT status FROM meeting_participants WHERE meeting_id = ? AND user_id = ?",
                (meeting_id, uid)
            )
            existing = await cursor.fetchone()
            if existing:
                await db.execute(
                    "UPDATE meeting_participants SET language = ?, status = 'approved' WHERE meeting_id = ? AND user_id = ?",
                    (target_user["preferred_language"], meeting_id, uid)
                )
            else:
                await db.execute(
                    "INSERT INTO meeting_participants (meeting_id, user_id, language, role, status) VALUES (?, ?, ?, 'participant', 'approved')",
                    (meeting_id, uid, target_user["preferred_language"])
                )

            # Create notification
            await db.execute(
                "INSERT INTO notifications (user_id, type, title, message, meeting_id) VALUES (?, ?, ?, ?, ?)",
                (uid, "invitation", "Meeting Invitation",
                 f'You have been invited to "{meeting_name}" by {host_name}',
                 meeting_id)
            )
            invited.append({"user_id": uid, "name": target_user["name"]})

        await db.commit()
        return invited


async def rebuild_fts_index():
    """Rebuild the FTS index from scratch (maintenance operation)."""
    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute("INSERT INTO transcripts_fts(transcripts_fts) VALUES('rebuild')")
            await db.commit()
            logger.info("FTS index rebuilt successfully")
        except Exception as e:
            logger.error(f"Failed to rebuild FTS index: {e}")
