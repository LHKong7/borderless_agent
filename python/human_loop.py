"""
human_loop.py — Human-in-the-loop manager for server mode.

When the agent calls ``ask_user`` during a streaming turn, the tool blocks
on a ``threading.Event``. The pending question is published via SSE to the
client. The client submits their answer to ``POST /sessions/{id}/answer``,
which signals the event and unblocks the agent loop.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

DEFAULT_TIMEOUT_SECS = 5 * 60  # 5 minutes


@dataclass
class PendingQuestion:
    session_id: str
    question: str
    answer: Optional[str] = None
    event: threading.Event = field(default_factory=threading.Event)
    created_at: float = field(default_factory=time.time)


class HumanLoopManager:
    """Thread-safe manager for pending human-input questions."""

    def __init__(self) -> None:
        self._pending: Dict[str, PendingQuestion] = {}
        self._lock = threading.Lock()

    def ask(
        self,
        session_id: str,
        question: str,
        timeout: float = DEFAULT_TIMEOUT_SECS,
    ) -> str:
        """Block until the client answers or timeout.

        Called from within the agent loop (tool execution) in a worker thread.
        """
        # Cancel any existing pending question for this session
        self.cancel(session_id)

        pq = PendingQuestion(session_id=session_id, question=question)
        with self._lock:
            self._pending[session_id] = pq

        # Block until answer arrives or timeout
        answered = pq.event.wait(timeout=timeout)

        with self._lock:
            self._pending.pop(session_id, None)

        if not answered:
            return (
                "[Timeout] User did not respond within the time limit. "
                "Proceed with your best judgment."
            )
        return pq.answer or "(User provided no response)"

    def answer(self, session_id: str, answer: str) -> bool:
        """Submit the user's answer. Called from the /answer endpoint.

        Returns True if a pending question was found and answered.
        """
        with self._lock:
            pq = self._pending.get(session_id)
        if pq is None:
            return False
        pq.answer = answer or "(User provided no response)"
        pq.event.set()
        return True

    def get_pending(self, session_id: str) -> Optional[PendingQuestion]:
        """Get the current pending question for a session (if any)."""
        with self._lock:
            return self._pending.get(session_id)

    def cancel(self, session_id: str) -> None:
        """Cancel a pending question (e.g. on client disconnect)."""
        with self._lock:
            pq = self._pending.pop(session_id, None)
        if pq is not None:
            pq.answer = (
                "[Cancelled] Human input request was cancelled. "
                "Proceed with your best judgment."
            )
            pq.event.set()


# Singleton instance used by the server.
human_loop_manager = HumanLoopManager()
