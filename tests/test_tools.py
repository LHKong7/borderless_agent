"""Unit tests for tools_core: run_read offset/limit and pagination."""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("OPENAI_API_KEY", "sk-test")

from tools_core import run_read, run_grep, safe_path
from config import WORKDIR


def _write_tmp(name: str, content: str) -> Path:
    """Write a temp file inside WORKDIR for testing."""
    p = WORKDIR / name
    p.write_text(content)
    return p


# ---------- run_read ----------

def test_read_basic():
    _write_tmp("_test_read.txt", "line1\nline2\nline3\n")
    out = run_read("_test_read.txt")
    assert "line1" in out
    assert "line3" in out
    (WORKDIR / "_test_read.txt").unlink(missing_ok=True)


def test_read_offset():
    _write_tmp("_test_off.txt", "\n".join(f"L{i}" for i in range(20)))
    out = run_read("_test_off.txt", offset=5, limit=3)
    assert "L5" in out
    assert "L7" in out
    assert "L4" not in out
    (WORKDIR / "_test_off.txt").unlink(missing_ok=True)


def test_read_pagination_footer():
    _write_tmp("_test_page.txt", "\n".join(f"row{i}" for i in range(100)))
    out = run_read("_test_page.txt", offset=0, limit=10)
    assert "use offset=10 for next page" in out
    (WORKDIR / "_test_page.txt").unlink(missing_ok=True)


def test_read_not_found():
    out = run_read("_no_such_file_xyz.txt")
    assert "Error" in out


# ---------- run_grep ----------

def test_grep_basic():
    _write_tmp("_test_grep.txt", "alpha\nbeta\ngamma\ndelta\n")
    out = run_grep("_test_grep.txt", "beta")
    assert "beta" in out
    assert "alpha" not in out  # no context
    (WORKDIR / "_test_grep.txt").unlink(missing_ok=True)


def test_grep_context():
    _write_tmp("_test_grep2.txt", "a\nb\nc\nd\ne\n")
    out = run_grep("_test_grep2.txt", "c", context_before=1, context_after=1)
    assert "b" in out  # before
    assert "d" in out  # after
    (WORKDIR / "_test_grep2.txt").unlink(missing_ok=True)


def test_grep_no_match():
    _write_tmp("_test_grep3.txt", "hello\nworld\n")
    out = run_grep("_test_grep3.txt", "zzz_no_match")
    assert "No matches" in out
    (WORKDIR / "_test_grep3.txt").unlink(missing_ok=True)
