# agentic-system

Portable agentic AI framework for TypeScript — build agents with **custom tools**, **skills**, **system prompts**, and **persistent sessions**.

## Quick Start

```bash
npm install agentic-system
```

```typescript
import { AgentBuilder } from 'agentic-system';

const agent = new AgentBuilder()
  .setLLM({ apiKey: process.env.OPENAI_API_KEY! })
  .setSystemPrompt('You are a helpful coding assistant.')
  .addTool({
    name: 'search_docs',
    description: 'Search documentation',
    parameters: { query: { type: 'string' } },
    required: ['query'],
    execute: async (args) => {
      // Your custom logic here
      return `Results for: ${args.query}`;
    },
  })
  .build();

// Simple chat
const result = await agent.chat('Explain TypeScript generics');
console.log(result.reply);

// Streaming
for await (const chunk of agent.stream('Write a haiku')) {
  if (chunk.delta) process.stdout.write(chunk.delta);
}
```

## Features

| Feature | Description |
|---------|-------------|
| **Custom Tools** | Define tools with `.addTool()` — the agent calls them automatically |
| **Custom Skills** | Inject domain knowledge via `.addSkill()` |
| **System Prompt** | Full control over agent personality and behavior |
| **Sessions** | `agent.createSession()` for persistent conversation history |
| **Streaming** | Token-by-token streaming via `agent.stream()` |
| **Memory** | Long-term memory with `.enableMemory()` |
| **Built-in Tools** | Bash, file read/write/edit, grep (opt-in via `includeBuiltinTools`) |
| **Approval Flow** | Require user approval for dangerous tools |

## Sessions

```typescript
// Create a persistent session
const session = agent.createSession();
await session.chat('My name is Alice');
const r = await session.chat('What is my name?');
console.log(r.reply); // "Alice"
await session.save();

// Restore later
const restored = agent.restoreSession(session.id);
```

## Custom Skills

```typescript
const agent = new AgentBuilder()
  .setLLM({ apiKey: '...' })
  .addSkill({
    name: 'python-expert',
    description: 'Expert Python knowledge',
    body: '# Python Best Practices\n- Use type hints\n- Prefer pathlib over os.path...',
  })
  .build();
```

## Approval Callback

```typescript
const agent = new AgentBuilder()
  .setLLM({ apiKey: '...' })
  .setApprovalCallback(async (toolName, args) => {
    console.log(`Tool: ${toolName}, Args: ${JSON.stringify(args)}`);
    // Return true to approve, false to deny
    return true;
  })
  .build();
```

## Next.js Integration

```typescript
// app/api/chat/route.ts
import { AgentBuilder } from 'agentic-system';

const agent = new AgentBuilder()
  .setLLM({ apiKey: process.env.OPENAI_API_KEY! })
  .setSystemPrompt('You are a helpful assistant.')
  .setIncludeBuiltinTools(false) // server-safe: no bash/fs
  .addTool({ /* your API tools */ })
  .build();

export async function POST(req: Request) {
  const { message, sessionId } = await req.json();
  const session = agent.restoreSession(sessionId) ?? agent.createSession();
  const result = await session.chat(message);
  return Response.json({ reply: result.reply, sessionId: session.id });
}
```

## API Reference

### `AgentBuilder`

| Method | Description |
|--------|-------------|
| `.setLLM({ apiKey, model?, baseUrl?, timeout? })` | Configure OpenAI-compatible LLM |
| `.setLLMProvider(provider)` | Use a custom `LLMProvider` instance |
| `.setSystemPrompt(prompt)` | Set the base system prompt |
| `.addTool(tool)` | Add a custom tool |
| `.addSkill(skill)` | Add a custom skill |
| `.setStorage({ backend, dir? })` | Configure persistence (`'file'` or `'cloud'`) |
| `.enableMemory()` | Enable long-term memory |
| `.enableStreaming()` | Enable streaming by default |
| `.setApprovalCallback(fn)` | Set approval handler for dangerous tools |
| `.build()` | Build and return an `AgentInstance` |

### `AgentInstance`

| Method | Description |
|--------|-------------|
| `.chat(message, history?)` | Send a message, get `ChatResult` |
| `.stream(message, history?)` | Stream a message, yields `StreamChunk` |
| `.createSession()` | Create a new persistent session |
| `.restoreSession(id)` | Restore session by ID |
| `.listSessions()` | List saved session IDs |

### `AgentSession`

| Method | Description |
|--------|-------------|
| `.chat(message)` | Chat within this session |
| `.stream(message)` | Stream within this session |
| `.getHistory()` | Get conversation history |
| `.save()` | Persist session to storage |

## License

MIT
