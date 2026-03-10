"""
FastAPI server for the general-purpose agent (same stack as main.py / cli.main).

Uses: SessionManager, run_turn from cli.main, storage backend, memory/skills stores,
file-access and executor-approval callbacks. Serves web chat UI at /.
Supports SSE streaming via POST /sessions/{session_id}/turn/stream.
Supports human-in-the-loop via POST /sessions/{session_id}/answer.
"""

import asyncio
import collections
import json
import logging
import queue
import threading
import time as _time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from config import MODEL, setup_agent_logging
from context_core import LifecycleManager, get_budget
from session_core import SessionManager
from tools_core import set_executor_approval_callback, set_file_access_callback, set_human_input_callback
from storage import get_storage_backend
from memory_core import set_memory_store
from skills_core import SKILLS
from human_loop import human_loop_manager

logger = logging.getLogger("agent")

_STATIC_DIR = Path(__file__).resolve().parent / "static"

# Singleton SessionManager (created on startup)
session_mgr: Optional[SessionManager] = None

# Request-scoped pending approvals (tool_name, tool_args) when agent requests tool approval
pending_approvals_var: ContextVar[List[Dict[str, Any]]] = ContextVar(
    "pending_approvals", default=[]
)

# Request-scoped SSE queue (for streaming human input events to client)
_sse_queue_var: ContextVar[Optional[queue.Queue]] = ContextVar(
    "_sse_queue", default=None
)

# Request-scoped session ID (for human input callback to know which session)
_current_session_id_var: ContextVar[str] = ContextVar(
    "_current_session_id", default=""
)


def get_session_mgr() -> SessionManager:
    if session_mgr is None:
        _init_server()
    if session_mgr is None:
        raise RuntimeError("SessionManager not initialized")
    return session_mgr


def _server_approval_callback(tool_name: str, tool_args: dict) -> bool:
    """Record pending approval and deny (no interactive input in server)."""
    pending_approvals_var.get().append({"tool_name": tool_name, "tool_args": tool_args})
    return False


def _server_human_input_callback(question: str) -> str:
    """Human input callback for server mode.

    When the agent calls ask_user, this pushes the question to the SSE stream
    (if available) and blocks until the client posts to /sessions/{id}/answer.
    """
    sid = _current_session_id_var.get()
    if not sid:
        return "[Human input not available] No active session for human input. Proceed with your best judgment."

    # Push question to SSE queue if we're in a streaming context
    sse_q = _sse_queue_var.get()
    if sse_q is not None:
        sse_q.put(("ask_user", question))

    # Block until answer arrives (or timeout)
    return human_loop_manager.ask(sid, question)


def _init_server() -> None:
    """Initialize same agent stack as main.py: storage, SessionManager, memory/skills, callbacks."""
    global session_mgr
    if session_mgr is not None:
        return
    setup_agent_logging()
    backend = get_storage_backend()
    session_mgr = SessionManager(store=backend.session_store)  # noqa: PLW0603
    set_memory_store(backend.memory_store)
    SKILLS.set_store(backend.skill_store)
    set_file_access_callback(lambda p: session_mgr.record_file_access(p))
    set_executor_approval_callback(_server_approval_callback)
    set_human_input_callback(_server_human_input_callback)
    logger.info("Agent server started; SessionManager ready.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _init_server()
    yield
    global session_mgr
    session_mgr = None


# --- Pydantic models ---


class CreateSessionResponse(BaseModel):
    session_id: str


class TurnRequest(BaseModel):
    message: str


class TurnResponse(BaseModel):
    reply: str
    pending_approvals: List[Dict[str, Any]] = []
    session_id: Optional[str] = None  # set when create_if_missing created a new session


class SessionSummary(BaseModel):
    id: str
    updated_at: float
    turns: int
    state: str


class AnswerRequest(BaseModel):
    answer: str


# --- App ---

app = FastAPI(
    title="Agent API",
    description="HTTP API for the general-purpose agent (sessions + turn). Same logic as python main.py.",
    version="1.0.0",
    lifespan=lifespan,
)

# #28: Simple in-memory rate limiter
_rate_limit_map: Dict[str, collections.deque] = {}
RATE_LIMIT_WINDOW_S = 60
RATE_LIMIT_MAX = 60


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        ip = request.client.host if request.client else "unknown"
        now = _time.time()
        dq = _rate_limit_map.setdefault(ip, collections.deque())
        # Remove old entries
        while dq and now - dq[0] > RATE_LIMIT_WINDOW_S:
            dq.popleft()
        if len(dq) >= RATE_LIMIT_MAX:
            from starlette.responses import JSONResponse
            return JSONResponse(status_code=429, content={"detail": "Too many requests"})
        dq.append(now)
        return await call_next(request)


app.add_middleware(RateLimitMiddleware)

# SSE overall timeout (5 minutes)
SSE_TIMEOUT_S = 5 * 60


@app.post("/sessions", response_model=CreateSessionResponse, status_code=201)
def create_session() -> CreateSessionResponse:
    mgr = get_session_mgr()
    session = mgr.create_session(context={"started": True})
    return CreateSessionResponse(session_id=session.id)


@app.get("/sessions", response_model=List[SessionSummary])
def list_sessions(limit: int = Query(20, ge=1, le=100)) -> List[SessionSummary]:
    mgr = get_session_mgr()
    summaries = mgr.list_sessions_summary(limit=limit)
    return [SessionSummary(**s) for s in summaries]


@app.get("/sessions/{session_id}", response_model=SessionSummary)
def get_session(session_id: str) -> SessionSummary:
    mgr = get_session_mgr()
    session = mgr.restore_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    turns = len([m for m in session.history if m.get("role") == "user"])
    return SessionSummary(
        id=session.id,
        updated_at=session.updated_at,
        turns=turns,
        state=session.state,
    )


@app.post("/sessions/{session_id}/turn", response_model=TurnResponse)
def turn(
    session_id: str,
    body: TurnRequest,
    create_if_missing: bool = Query(False, description="Create session if not found"),
) -> TurnResponse:
    """Synchronous turn. ask_user is NOT supported (no way to deliver question mid-request)."""
    mgr = get_session_mgr()
    session = mgr.restore_session(session_id)
    created = False
    if session is None:
        if create_if_missing:
            session = mgr.create_session(context={"started": True})
            created = True
        else:
            raise HTTPException(status_code=404, detail="Session not found")

    if not body.message or not body.message.strip():
        raise HTTPException(status_code=400, detail="message must be non-empty")

    token = pending_approvals_var.set([])
    # Disable human input for sync turns (can't interact mid-request)
    sid_token = _current_session_id_var.set("")

    try:
        from cli.main import run_turn

        lifecycle = LifecycleManager()
        saved_summary = session.context.get("conversation_summary")
        if saved_summary:
            lifecycle.set_conversation_summary(saved_summary)
        budget = get_budget(model=MODEL)
        history = list(session.history)

        history, last_assistant_text = run_turn(
            body.message.strip(),
            history,
            mgr,
            lifecycle,
            budget,
        )
        pending = list(pending_approvals_var.get())
        return TurnResponse(
            reply=last_assistant_text or "",
            pending_approvals=pending,
            session_id=session.id if created else None,
        )
    except Exception as e:
        logger.exception("turn failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)[:500])
    finally:
        pending_approvals_var.reset(token)
        _current_session_id_var.reset(sid_token)


# --- SSE streaming ---

def _sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _stream_turn_events(
    q: queue.Queue,
) -> AsyncGenerator[str, None]:
    """Consume queue from worker thread and yield SSE event strings."""
    loop = asyncio.get_event_loop()
    while True:
        try:
            item = await loop.run_in_executor(None, q.get)
        except Exception:
            break
        if item is None:
            break
        kind = item[0]
        if kind == "delta":
            yield _sse_event({"type": "delta", "delta": item[1]})
        elif kind == "ask_user":
            yield _sse_event({"type": "ask_user", "question": item[1]})
        elif kind == "done":
            yield _sse_event({
                "type": "done",
                "reply": item[1] or "",
                "pending_approvals": item[2],
            })
            break
        elif kind == "error":
            yield _sse_event({"type": "error", "detail": item[1]})
            break


@app.post("/sessions/{session_id}/turn/stream")
def turn_stream(
    session_id: str,
    body: TurnRequest,
    create_if_missing: bool = Query(False, description="Create session if not found"),
) -> StreamingResponse:
    """
    Same as POST /sessions/{session_id}/turn but streams assistant reply via SSE.

    Events:
      {"type":"delta","delta":"chunk"}          - text token
      {"type":"ask_user","question":"..."}      - agent needs human input
      {"type":"done","reply":"...","pending_approvals":[...]}
      {"type":"error","detail":"..."}

    When the client receives "ask_user", it should POST /sessions/{id}/answer
    with {"answer":"..."} to unblock the agent loop and continue streaming.
    """
    mgr = get_session_mgr()
    session = mgr.restore_session(session_id)
    created = False
    if session is None:
        if create_if_missing:
            session = mgr.create_session(context={"started": True})
            created = True
        else:
            raise HTTPException(status_code=404, detail="Session not found")

    if not body.message or not body.message.strip():
        raise HTTPException(status_code=400, detail="message must be non-empty")

    message = body.message.strip()
    q: queue.Queue = queue.Queue()

    def stream_callback(chunk: str) -> None:
        q.put(("delta", chunk))

    def worker() -> None:
        # Set up context vars for this thread
        _current_session_id_var.set(session.id)
        _sse_queue_var.set(q)
        pending_approvals_var.set([])
        try:
            from cli.main import run_turn

            lifecycle = LifecycleManager()
            saved_summary = session.context.get("conversation_summary")
            if saved_summary:
                lifecycle.set_conversation_summary(saved_summary)
            budget = get_budget(model=MODEL)
            history = list(session.history)

            history, last_assistant_text = run_turn(
                message,
                history,
                mgr,
                lifecycle,
                budget,
                stream_callback=stream_callback,
            )
            pending = list(pending_approvals_var.get())
            q.put(("done", last_assistant_text or "", pending))
        except Exception as e:
            logger.exception("turn_stream failed: %s", e)
            q.put(("error", str(e)[:500]))
        finally:
            # #11: attempt to save session even on interruption
            try:
                mgr.save_session(session)
            except Exception as e:
                logger.error("Failed to save session on stream end: %s", e)
            q.put(None)

    threading.Thread(target=worker, daemon=True).start()

    # #9: SSE generator with overall timeout
    async def _timed_stream():
        deadline = _time.time() + SSE_TIMEOUT_S
        async for event in _stream_turn_events(q):
            yield event
            if _time.time() > deadline:
                yield _sse_event({"type": "error", "detail": "SSE timeout — request took too long"})
                human_loop_manager.cancel(session.id)
                break

    return StreamingResponse(
        _timed_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# POST /sessions/:id/answer — submit answer for human-in-the-loop
@app.post("/sessions/{session_id}/answer")
def submit_answer(session_id: str, body: AnswerRequest) -> dict:
    """Submit the user's answer to a pending ask_user question.

    Call this when the SSE stream sends a {"type":"ask_user","question":"..."} event.
    The agent loop will resume with the provided answer.
    """
    if not body.answer or not body.answer.strip():
        raise HTTPException(status_code=400, detail="answer must be non-empty")

    success = human_loop_manager.answer(session_id, body.answer.strip())
    if not success:
        raise HTTPException(status_code=404, detail="No pending question for this session")

    return {"status": "ok"}
