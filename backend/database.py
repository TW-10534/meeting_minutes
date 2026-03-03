"""
MM Zettai - Database Layer
Async SQLite database for meetings, users, transcripts, and recordings.
"""

import aiosqlite
import os
import uuid
import random
import string
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "meetings.db")


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
        """)
        await db.commit()


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
    ALLOWED_COLUMNS = {"name", "status", "started_at", "ended_at", "summary", "recording_path", "scheduled_at"}
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
        await db.commit()
        return transcript_id


async def save_translation(transcript_id: int, target_language: str, translated_text: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO translations (transcript_id, target_language, translated_text) VALUES (?, ?, ?)",
            (transcript_id, target_language, translated_text)
        )
        await db.commit()


async def get_meeting_transcripts(meeting_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT t.*,
                   GROUP_CONCAT(tr.target_language || '::' || tr.translated_text, '|||') as translations_raw
            FROM transcripts t
            LEFT JOIN translations tr ON t.id = tr.transcript_id
            WHERE t.meeting_id = ?
            GROUP BY t.id
            ORDER BY t.timestamp ASC
        """, (meeting_id,))
        rows = await cursor.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            translations = {}
            if d.get("translations_raw"):
                for pair in d["translations_raw"].split("|||"):
                    if "::" in pair:
                        lang, text = pair.split("::", 1)
                        translations[lang] = text
            d["translations"] = translations
            del d["translations_raw"]
            results.append(d)
        return results
