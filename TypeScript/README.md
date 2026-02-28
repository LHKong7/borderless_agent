# borderless-agent

[![npm version](https://img.shields.io/npm/v/borderless-agent.svg)](https://www.npmjs.com/package/borderless-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A portable, framework-agnostic **agentic AI toolkit** for TypeScript/Node.js. Build production-ready AI agents with custom tools, skills, system prompts, and persistent sessions — in just a few lines of code.

```
npm install borderless-agent
```

## ✨ Highlights

- 🔧 **Custom Tools** — Give your agent any capability with typed tool definitions
- 🧠 **Skills** — Hot-load domain knowledge on demand
- 💬 **Sessions** — Persistent, resumable conversation history
- 🌊 **Streaming** — Token-by-token SSE-compatible streaming
- 🧩 **Framework-agnostic** — Works with Express, Next.js, Hono, standalone scripts
- 🔒 **Approval Flow** — Gate dangerous tool calls behind user confirmation
- 📦 **Zero config** — Works out of the box with OpenAI-compatible APIs

---

## Quick Start

```typescript
import { AgentBuilder } from 'borderless-agent';

const agent = new AgentBuilder()
  .setLLM({ apiKey: process.env.OPENAI_API_KEY! })
  .setSystemPrompt('You are a concise, helpful assistant.')
  .addTool({
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
    execute: async (args) => {
      // Your logic here
      return JSON.stringify({ city: args.city, temp: '22°C', sky: 'sunny' });
    },
  })
  .build();

const result = await agent.chat('What is the weather in Tokyo?');
console.log(result.reply);
// → "The weather in Tokyo is 22°C and sunny."
```

---

## Core Concepts

### Tools

Tools let your agent take actions. Define a name, description, parameters, and an `execute` function — the agent decides when to call them.

```typescript
agent.addTool({
  name: 'search_docs',
  description: 'Search internal documentation',
  parameters: {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'integer', description: 'Max results' },
  },
  required: ['query'],
  execute: async (args) => {
    const results = await mySearchEngine.search(args.query, args.limit ?? 5);
    return JSON.stringify(results);
  },
});
```

### Skills

Skills inject specialized knowledge into the agent's context when loaded via the `Skill` tool. Use them for domain-specific instructions, API docs, or workflow guides.

```typescript
builder.addSkill({
  name: 'sql-expert',
  description: 'Expert knowledge for writing SQL queries',
  body: `
    ## SQL Best Practices
    - Always use parameterized queries
    - Prefer JOINs over subqueries for readability
    - Add indexes on frequently filtered columns
    ...
  `,
});
```

### Sessions

Sessions maintain conversation history across multiple turns and persist to disk (or cloud storage).

```typescript
// Create a new session
const session = agent.createSession();
await session.chat('My name is Alice and I work on Project X.');
const r = await session.chat('What project do I work on?');
console.log(r.reply); // → "You work on Project X."

// Persist
await session.save();

// Restore later (even after restart)
const restored = agent.restoreSession(session.id);
```

### Streaming

Stream responses token-by-token — perfect for chat UIs and SSE endpoints.

```typescript
for await (const chunk of agent.stream('Explain quantum computing')) {
  if (chunk.delta) process.stdout.write(chunk.delta);
  if (chunk.done) console.log('\n[done]');
}
```

---

## Builder API

| Method | Description |
|--------|-------------|
| `.setLLM({ apiKey, model?, baseUrl?, timeout? })` | Configure OpenAI-compatible LLM |
| `.setLLMProvider(provider)` | Supply a custom `LLMProvider` implementation |
| `.setSystemPrompt(prompt)` | Set the base system prompt |
| `.addTool(tool)` / `.addTools(tools)` | Register custom tools |
| `.addSkill(skill)` / `.addSkills(skills)` | Register skills |
| `.setIncludeBuiltinTools(bool)` | Include bash, file read/write/edit, grep (`true` by default) |
| `.setStorage({ backend, dir? })` | Configure persistence (`'file'` or `'cloud'`) |
| `.enableMemory()` | Enable long-term episodic + semantic memory |
| `.enableStreaming()` | Enable streaming by default |
| `.enableContext()` | Enable token budgeting & history trimming |
| `.setMaxToolRounds(n)` | Safety limit for tool-use loops (default: 20) |
| `.setApprovalCallback(fn)` | Gate mutating tool calls behind user approval |
| `.build()` | → `AgentInstance` |

## Agent API

| Method | Returns | Description |
|--------|---------|-------------|
| `agent.chat(message, history?)` | `Promise<ChatResult>` | Single stateless turn |
| `agent.stream(message, history?)` | `AsyncGenerator<StreamChunk>` | Streaming turn |
| `agent.createSession()` | `AgentSession` | New persistent session |
| `agent.restoreSession(id)` | `AgentSession \| null` | Restore by ID |
| `agent.listSessions()` | `string[]` | All saved session IDs |
| `agent.listSessionSummaries(limit?)` | `object[]` | Session metadata |

---

## Integration Examples

### Next.js (App Router)

```typescript
// app/api/chat/route.ts
import { AgentBuilder } from 'borderless-agent';

const agent = new AgentBuilder()
  .setLLM({ apiKey: process.env.OPENAI_API_KEY! })
  .setSystemPrompt('You are a helpful assistant.')
  .setIncludeBuiltinTools(false) // no bash/fs in serverless
  .addTool({ name: 'lookup', description: '...', execute: async (args) => '...' })
  .build();

export async function POST(req: Request) {
  const { message, sessionId } = await req.json();
  const session = agent.restoreSession(sessionId) ?? agent.createSession();
  const result = await session.chat(message);
  return Response.json({ reply: result.reply, sessionId: session.id });
}
```

### Next.js (Streaming SSE)

```typescript
export async function POST(req: Request) {
  const { message } = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const chunk of agent.stream(message)) {
        if (chunk.delta) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`));
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}
```

### Express

```typescript
import express from 'express';
import { AgentBuilder } from 'borderless-agent';

const app = express();
app.use(express.json());

const agent = new AgentBuilder()
  .setLLM({ apiKey: process.env.OPENAI_API_KEY! })
  .build();

app.post('/chat', async (req, res) => {
  const result = await agent.chat(req.body.message);
  res.json({ reply: result.reply });
});

app.listen(3000);
```

---

## Approval Callback

Gate dangerous tool calls behind user confirmation:

```typescript
const agent = new AgentBuilder()
  .setLLM({ apiKey: '...' })
  .setApprovalCallback(async (toolName, args) => {
    console.log(`🔐 Tool "${toolName}" wants to run with:`, args);
    // Return true to approve, false to deny
    return toolName !== 'bash'; // e.g., allow everything except bash
  })
  .build();
```

---

## Types

All types are fully exported for TypeScript consumers:

```typescript
import type {
  ToolDefinition,
  SkillDefinition,
  AgentConfig,
  ChatResult,
  StreamChunk,
  AgentSession,
  LLMConfig,
  LLMProvider,
} from 'borderless-agent';
```

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key |
| `MODEL_ID` | `gpt-4o` | Model identifier |
| `AGENT_STREAM` | `0` | Enable streaming (`1` to enable) |
| `AGENT_MEMORY` | `0` | Enable long-term memory |
| `AGENT_CONTEXT` | `1` | Enable context management |
| `AGENT_STORAGE_BACKEND` | `file` | `file` or `cloud` |

---

## License

[MIT](./LICENSE)
