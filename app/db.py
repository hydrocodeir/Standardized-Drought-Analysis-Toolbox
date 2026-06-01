from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


DB_PATH = Path(__file__).resolve().parent / "data" / "sdat.db"


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              description TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              run_name TEXT,
              input_type TEXT NOT NULL,
              filename TEXT,
              status TEXT NOT NULL,
              payload_json TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY(project_id) REFERENCES projects(id)
            );
            """
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_name ON projects(name)"
        )
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(jobs)").fetchall()]
        if "run_name" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN run_name TEXT")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_project_run_name ON jobs(project_id, run_name)"
        )


def create_project(name: str, description: str) -> int:
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO projects(name, description) VALUES (?, ?)",
                (name, description),
            )
            return int(cur.lastrowid)
        except sqlite3.IntegrityError as exc:
            raise ValueError("Project name must be unique.") from exc


def list_projects() -> list[sqlite3.Row]:
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT id, name, description, created_at FROM projects ORDER BY id DESC"
        )
        return list(cur.fetchall())


def get_project(project_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT id, name, description, created_at FROM projects WHERE id = ?",
            (project_id,),
        )
        return cur.fetchone()


def create_job(
    project_id: int,
    run_name: str,
    input_type: str,
    filename: str,
    status: str,
    payload: dict[str, Any],
) -> int:
    with get_conn() as conn:
        try:
            cur = conn.execute(
                """
                INSERT INTO jobs(project_id, run_name, input_type, filename, status, payload_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (project_id, run_name, input_type, filename, status, json.dumps(payload)),
            )
            return int(cur.lastrowid)
        except sqlite3.IntegrityError as exc:
            raise ValueError("Run name must be unique within this project.") from exc


def list_jobs(project_id: int) -> list[sqlite3.Row]:
    with get_conn() as conn:
        cur = conn.execute(
            """
            SELECT id, input_type, filename, status, created_at, payload_json
                 , run_name
            FROM jobs
            WHERE project_id = ?
            ORDER BY id DESC
            """,
            (project_id,),
        )
        return list(cur.fetchall())


def get_job(project_id: int, job_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        cur = conn.execute(
            """
            SELECT id, input_type, filename, status, created_at, payload_json
                 , run_name
            FROM jobs
            WHERE project_id = ? AND id = ?
            """,
            (project_id, job_id),
        )
        return cur.fetchone()


def delete_job(project_id: int, job_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM jobs WHERE project_id = ? AND id = ?",
            (project_id, job_id),
        )
        return cur.rowcount > 0
