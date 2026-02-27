# agentic-system (Python)

Portable agentic AI framework for Python — build agents with **custom tools**, **skills**, **system prompts**, and **persistent sessions**.

## Quick Start

```bash
pip install -e .
```

```python
from agent_builder import AgentBuilder

agent = (
    AgentBuilder()
    .set_llm(api_key="sk-...")
    .set_system_prompt("You are a helpful coding assistant.")
    .add_tool(
        name="search_docs",
        description="Search documentation",
        parameters={"query": {"type": "string"}},
        required=["query"],
        execute=lambda args: f"Results for: {args['query']}",
    )
    .build()
)

result = agent.chat("Explain Python decorators")
print(result.reply)
```

## Features

| Feature | Description |
|---------|-------------|
| **Custom Tools** | Define tools with `.add_tool()` — the agent calls them automatically |
| **Custom Skills** | Inject domain knowledge via `.add_skill()` |
| **System Prompt** | Full control over agent personality and behavior |
| **Sessions** | `agent.create_session()` for persistent conversation history |
| **Streaming** | Token-by-token streaming via `agent.stream()` |
| **Memory** | Long-term memory with `.enable_memory()` |
| **Built-in Tools** | Bash, file read/write/edit, grep (opt-in via `include_builtin_tools`) |
| **Approval Flow** | Require user approval for dangerous tools |

## Sessions

```python
session = agent.create_session()
session.chat("My name is Alice")
r = session.chat("What is my name?")
print(r.reply)  # "Alice"
session.save()

# Restore later
restored = agent.restore_session(session.id)
```

## Skills

```python
agent = (
    AgentBuilder()
    .set_llm(api_key="sk-...")
    .add_skill(name="python-expert", description="Python expert", body="...")
    .build()
)
```

## Streaming

```python
for chunk in agent.stream("Write a haiku"):
    if chunk.delta:
        print(chunk.delta, end="")
```

## API Reference

### `AgentBuilder`

| Method | Description |
|--------|-------------|
| `.set_llm(api_key, model, ...)` | Configure OpenAI-compatible LLM |
| `.set_llm_provider(provider)` | Use a custom `LLMProvider` instance |
| `.set_system_prompt(prompt)` | Set the base system prompt |
| `.add_tool(name, description, execute, ...)` | Add a custom tool |
| `.add_skill(name, description, body)` | Add a custom skill |
| `.set_storage(backend, dir)` | Configure persistence |
| `.enable_memory()` | Enable long-term memory |
| `.enable_streaming()` | Enable streaming by default |
| `.set_approval_callback(fn)` | Set approval handler for dangerous tools |
| `.build()` | Build and return an `AgentInstance` |

### `AgentInstance`

| Method | Description |
|--------|-------------|
| `.chat(message, history?)` | Send a message, get `ChatResult` |
| `.stream(message, history?)` | Stream a message, yields `StreamChunk` |
| `.create_session()` | Create a new persistent session |
| `.restore_session(id)` | Restore session by ID |
| `.list_sessions()` | List saved session IDs |

## License

MIT
