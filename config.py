#!/usr/bin/env python3
"""
config.py - Shared configuration for the skills agent (OpenAI SDK).
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(override=True)

# Logging: AGENT_VERBOSE=1 or true => DEBUG, else INFO
_verbose = os.environ.get("AGENT_VERBOSE", "").strip().lower() in ("1", "true", "yes")
LOG_LEVEL = logging.DEBUG if _verbose else logging.INFO


def setup_agent_logging() -> None:
    """Configure agent logger. Call from main on startup."""
    log = logging.getLogger("agent")
    if not log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        log.addHandler(handler)
    log.setLevel(LOG_LEVEL)

    structured = logging.getLogger("agent.structured")
    if not structured.handlers:
        sh = logging.StreamHandler()
        sh.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", datefmt="%H:%M:%S"))
        structured.addHandler(sh)
    structured.setLevel(LOG_LEVEL)

# Workspace and skills directory
WORKDIR = Path.cwd()
SKILLS_DIR = WORKDIR / "skills"

# API timeout in seconds (per-request); override with AGENT_API_TIMEOUT env var
API_TIMEOUT: float = float(os.getenv("AGENT_API_TIMEOUT", "120"))

# Stream LLM output token-by-token (AGENT_STREAM=1); disable for non-interactive or debugging
def stream_enabled() -> bool:
    return os.environ.get("AGENT_STREAM", "").strip().lower() in ("1", "true", "yes")

# OpenAI client and default model
_client_kw: dict = {"timeout": API_TIMEOUT}
if os.getenv("OPENAI_BASE_URL"):
    _client_kw["base_url"] = os.getenv("OPENAI_BASE_URL")
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", "sk-placeholder"), **_client_kw)
MODEL = os.getenv("MODEL_ID", "gpt-4o")

