from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .db import (
    create_job,
    create_project,
    delete_job,
    get_job,
    get_project,
    init_db,
    list_jobs,
    list_projects,
)


BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(title="SDAT Dashboard")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/", response_class=HTMLResponse)
def landing(request: Request) -> HTMLResponse:
    projects = list_projects()
    return templates.TemplateResponse(
        request, "landing.html", {"projects": projects, "page_title": "SDAT"}
    )


@app.post("/projects", response_class=HTMLResponse)
def create_project_route(
    request: Request,
    name: str = Form(...),
    description: str = Form(""),
) -> HTMLResponse:
    try:
        project_id = create_project(name=name.strip(), description=description.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    target = f"/projects/{project_id}"
    if request.headers.get("HX-Request") == "true":
        return Response(status_code=204, headers={"HX-Redirect": target})
    return RedirectResponse(url=target, status_code=303)


@app.get("/projects/{project_id}", response_class=HTMLResponse)
def dashboard(request: Request, project_id: int) -> HTMLResponse:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    jobs = list_jobs(project_id)
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {"project": project, "jobs": jobs, "page_title": f"Project {project_id}"},
    )


@app.get("/projects/{project_id}/jobs", response_class=HTMLResponse)
def jobs_partial(request: Request, project_id: int) -> HTMLResponse:
    jobs = list_jobs(project_id)
    return templates.TemplateResponse(request, "partials/jobs_table.html", {"jobs": jobs})


@app.get("/api/projects/{project_id}/jobs")
def jobs_json(project_id: int) -> JSONResponse:
    rows = list_jobs(project_id)
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload_json"] or "{}")
        except json.JSONDecodeError:
            payload = {}
        out.append(
            {
                "id": r["id"],
                "run_name": r["run_name"],
                "input_type": r["input_type"],
                "filename": r["filename"],
                "status": r["status"],
                "created_at": r["created_at"],
                "payload": payload,
            }
        )
    return JSONResponse(out)


class JobPayload(BaseModel):
    run_name: str
    input_type: str
    filename: str = ""
    status: str = "done"
    payload: dict


@app.post("/api/projects/{project_id}/jobs")
def log_job(project_id: int, data: JobPayload) -> JSONResponse:
    if not get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        job_id = create_job(
            project_id=project_id,
            run_name=data.run_name.strip(),
            input_type=data.input_type,
            filename=data.filename,
            status=data.status,
            payload=data.payload,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JSONResponse({"ok": True, "job_id": job_id})


@app.get("/api/projects/{project_id}/jobs/{job_id}")
def get_job_payload(project_id: int, job_id: int) -> JSONResponse:
    row = get_job(project_id, job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    payload = {}
    try:
        payload = json.loads(row["payload_json"] or "{}")
    except json.JSONDecodeError:
        payload = {}
    return JSONResponse(
        {
            "id": row["id"],
            "run_name": row["run_name"],
            "input_type": row["input_type"],
            "filename": row["filename"],
            "status": row["status"],
            "created_at": row["created_at"],
            "payload": payload,
        }
    )


@app.delete("/api/projects/{project_id}/jobs/{job_id}")
def delete_job_api(project_id: int, job_id: int) -> JSONResponse:
    if not delete_job(project_id, job_id):
        raise HTTPException(status_code=404, detail="Run not found")
    return JSONResponse({"ok": True})


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/sample-csv")
def sample_csv() -> RedirectResponse:
    return RedirectResponse(url="/static/data/Sample.csv")


@app.get("/go/{project_id}")
def go(project_id: int) -> RedirectResponse:
    return RedirectResponse(url=f"/projects/{project_id}")
