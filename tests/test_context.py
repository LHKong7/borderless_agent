"""Unit tests for context_core: select_history, assemble_system, compute_usage_stats."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from context_core import (
    select_history,
    assemble_system,
    compute_usage_stats,
    estimate_tokens,
)


# ---------- select_history ----------

def test_select_history_empty():
    assert select_history([], "hello", max_tokens=10000) == []


def test_select_history_within_budget():
    hist = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    result = select_history(hist, "next", max_tokens=100000, max_turns=30)
    assert len(result) == 2
    assert result[0]["content"] == "hi"


def test_select_history_trims_over_budget():
    hist = [{"role": "user", "content": "a" * 3000} for _ in range(50)]
    result = select_history(hist, "q", max_tokens=5000, max_turns=30)
    assert len(result) < 50
    assert len(result) >= 2


def test_select_history_max_turns():
    hist = [{"role": "user", "content": "x"} for _ in range(100)]
    result = select_history(hist, "q", max_tokens=999999, max_turns=5)
    assert len(result) <= 10  # 5 turns * 2


# ---------- assemble_system ----------

def test_assemble_no_rag():
    out = assemble_system("You are a helper.")
    assert "You are a helper." in out


def test_assemble_with_rag():
    out = assemble_system("Base.", rag_lines=["fact1", "fact2"])
    assert "fact1" in out
    assert "fact2" in out
    assert "Relevant past context" in out


def test_assemble_rag_budget_trim():
    long_rag = ["x" * 100000]
    out = assemble_system("Base.", rag_lines=long_rag, budget_rag=100)
    assert len(out) < 100000 + 500


def test_assemble_with_summary():
    out = assemble_system("Base.", conversation_summary="summary here")
    assert "summary here" in out
    assert "Conversation summary" in out


# ---------- compute_usage_stats ----------

def test_compute_usage_stats_empty():
    assert compute_usage_stats(None, 200000) == {"used": None, "remaining": None}


def test_compute_usage_stats_zero_max():
    assert compute_usage_stats({"input_tokens": 100}, 0) == {"used": None, "remaining": None}


def test_compute_usage_stats_normal():
    usage = {
        "input_tokens": 50000,
        "cache_creation_input_tokens": 10000,
        "cache_read_input_tokens": 5000,
    }
    result = compute_usage_stats(usage, 200000)
    assert result["used"] == 32  # round((65000/200000)*100) = 32 (banker's rounding)
    assert result["remaining"] == 68


def test_compute_usage_stats_clamped():
    usage = {"input_tokens": 300000}
    result = compute_usage_stats(usage, 200000)
    assert result["used"] == 100
    assert result["remaining"] == 0
