# Agentic System

General-purpose agent with skills, long-term memory, and context management. It supports an interactive CLI and an HTTP API, and uses the OpenAI API (see [config.py](config.py)).

## Prerequisites

- **Python 3.10+** (the codebase uses modern type hints and syntax)

## Installation

1. Clone the repository and change into its directory:

   ```bash
   cd agentic_system
   ```

2. Create and activate a virtual environment:

   ```bash
   python -m venv .venv
   # Linux/macOS:
   . .venv/bin/activate
   # Windows:
   # .venv\Scripts\activate
   ```

3. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

   This installs `python-dotenv`, `openai`, `fastapi`, and `uvicorn` (see [requirements.txt](requirements.txt)).

## Configuration

1. Copy the example env file to `.env`:

   ```bash
   cp .env.example .env
   ```

2. **Required:** Set your OpenAI API key in `.env`:

   ```bash
   OPENAI_API_KEY=sk-your-key-here
   ```

3. **Optional:** Override defaults as needed. Common options:
   - `MODEL_ID` — model to use (default: `gpt-4o`)
   - `OPENAI_BASE_URL` — alternative API base URL
   - See [.env.example](.env.example) for the full list (memory, storage, context, logging, streaming, etc.).

## Running the project

### CLI (interactive REPL)

From the project root:

```bash
python main.py
```

or:

```bash
python -m cli
```

Entry points: [main.py](main.py), [cli/__main__.py](cli/__main__.py). Core logic: [cli/main.py](cli/main.py).

### HTTP server

From the project root:

```bash
python -m server
```

The server listens on `http://0.0.0.0:8000` (see [server/__main__.py](server/__main__.py)).

For development with auto-reload:

```bash
uvicorn server.app:app --reload
```

### API (when the server is running)

- **POST /sessions** — Create a new session. Returns `session_id`.
- **GET /sessions** — List sessions (optional query: `limit`, default 20).
- **GET /sessions/{session_id}** — Get a session summary.
- **POST /sessions/{session_id}/turn** — Send a message. Body: `{"message": "..."}`. Optional query: `create_if_missing=true` to create the session if it does not exist.

Defined in [server/app.py](server/app.py).

## Storage

By default the agent uses **file-based storage**:
- Sessions: `data/sessions/`
- Memory: `data/memory/`
- Skills: `skills/` (each skill is a folder with a `SKILL.md` file)

For **cloud (S3-compatible)** storage, set `AGENT_STORAGE_BACKEND=cloud` and configure the bucket and credentials as described in [.env.example](.env.example).

## Project structure

| Path | Description |
|------|--------------|
| `main.py` | CLI launcher |
| `config.py` | Shared config (OpenAI client, model, paths) |
| `cli/` | CLI REPL and turn logic |
| `server/` | FastAPI app and HTTP endpoints |
| `storage/` | Storage abstraction (file and cloud backends) |
| `skills/` | Skill definitions (SKILL.md per skill) |
| `data/` | Default file storage (sessions, memory) |
| Core modules | `session_core`, `memory_core`, `context_core`, `loop_core`, `tools_core`, `skills_core`, `agents_core` |

## Tests

From the project root:

```bash
pytest
```

or:

```bash
pytest tests/
```

Tests live in [tests/](tests/) (e.g. [tests/test_server.py](tests/test_server.py), [tests/test_integration.py](tests/test_integration.py)).
