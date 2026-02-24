"""Server API tests (TestClient + mocked OpenAI)."""

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
os.environ.setdefault("OPENAI_API_KEY", "sk-test")

from fastapi.testclient import TestClient


def _make_mock_response(text: str = "Server reply"):
    msg = SimpleNamespace(content=text, tool_calls=None, role="assistant")
    choice = SimpleNamespace(message=msg, finish_reason="stop")
    usage = SimpleNamespace(
        input_tokens=10,
        output_tokens=5,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    return SimpleNamespace(choices=[choice], usage=usage)


def test_create_session():
    from server.app import app
    client = TestClient(app)
    r = client.post("/sessions")
    assert r.status_code == 201
    data = r.json()
    assert "session_id" in data
    assert len(data["session_id"]) > 0


def test_list_sessions():
    from server.app import app
    client = TestClient(app)
    r = client.get("/sessions")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_get_session_404():
    from server.app import app
    client = TestClient(app)
    r = client.get("/sessions/nonexistent-id-12345")
    assert r.status_code == 404


def test_turn_404():
    from server.app import app
    client = TestClient(app)
    r = client.post("/sessions/nonexistent-id-12345/turn", json={"message": "hi"})
    assert r.status_code == 404


def test_turn_create_if_missing():
    from server.app import app
    client = TestClient(app)
    r = client.post(
        "/sessions/nonexistent-id-12345/turn",
        json={"message": "hello"},
        params={"create_if_missing": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert "reply" in body
    assert "session_id" in body
    assert body["session_id"]  # new session id returned


def test_turn_full_flow():
    from unittest.mock import patch
    from server.app import app
    client = TestClient(app)
    r = client.post("/sessions")
    assert r.status_code == 201
    sid = r.json()["session_id"]
    mock_resp = _make_mock_response("Mocked assistant reply.")
    with patch("loop_core.client") as mock_client:
        mock_client.chat.completions.create.return_value = mock_resp
        r2 = client.post(f"/sessions/{sid}/turn", json={"message": "hi"})
    assert r2.status_code == 200
    body = r2.json()
    assert body["reply"] == "Mocked assistant reply."
    assert body["pending_approvals"] == []
