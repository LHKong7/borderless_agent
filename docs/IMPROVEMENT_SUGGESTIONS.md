# Borderless-Agent: Improvement Suggestions

A prioritized list of concrete improvements based on a deep audit of the current codebase and comparison with the 2025-2026 agent framework landscape.

---

## 1. Native Multi-Provider LLM Support

**Priority: Critical** | **Effort: Medium** | **Files: `src/llmProtocol.ts`, `src/agentBuilder.ts`**

**Current state:** Only `OpenAIProvider` exists. Anthropic and Google work through OpenAI-compatible proxy endpoints, which loses provider-specific features (native tool_use blocks, prompt caching, extended thinking).

**Suggestion:**
- Define an abstract `LLMProvider` interface (already exists) and implement `AnthropicProvider` using `@anthropic-ai/sdk` with native tool use, and `GoogleProvider` using `@google/generative-ai`.
- Add a `setProvider('anthropic' | 'openai' | 'google' | 'ollama')` shorthand to `AgentBuilder` that auto-selects the right provider class.
- Support Anthropic prompt caching headers (`cache_control: { type: "ephemeral" }`) for system prompt and tool definitions — this alone can cut costs 90% on repeated calls.
- Context window detection is hardcoded to 128k (`llmProtocol.ts:153-155`). Should detect from model string + provider type using a lookup table.

**Impact:** Unlocks native features per provider, reduces cost, improves quality.

---

## 2. Parallel Tool Execution

**Priority: High** | **Effort: Small** | **Files: `src/agentInstance.ts`**

**Current state:** Tools are executed sequentially in a for-loop (`agentInstance.ts:671-694`). Modern LLMs emit multiple tool calls in a single response expecting parallel execution.

**Suggestion:**
```typescript
// Before (sequential)
for (const tc of toolCalls) {
  const result = await this._executeTool(tc.function.name, args);
  observations.push(result);
}

// After (parallel)
const results = await Promise.allSettled(
  toolCalls.map(tc => this._executeTool(tc.function.name, parseArgs(tc)))
);
```

- Add a `parallelToolExecution: boolean` config option (default: `true`).
- For tools marked `requiresApproval`, serialize those (await approval before running) but parallelize the rest.

**Impact:** 2-5x speedup on multi-tool turns.

---

## 3. Per-Tool Timeout with AbortController

**Priority: High** | **Effort: Small** | **Files: `src/types.ts`, `src/agentInstance.ts`, `src/sandbox.ts`**

**Current state:** No timeout mechanism. Bash commands or external API calls can hang indefinitely, blocking the entire agent loop.

**Suggestion:**
- Add `timeout?: number` (ms) to `ToolDefinition`.
- Wrap `execute()` with `AbortController` + `setTimeout`:
```typescript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), tool.timeout ?? 30_000);
try {
  const result = await tool.execute(args, { signal: controller.signal });
  return result;
} finally {
  clearTimeout(timer);
}
```
- Default timeout of 30s for user tools, 60s for built-in bash, configurable globally via `AgentBuilder.setDefaultToolTimeout(ms)`.

**Impact:** Prevents hung agents, improves reliability.

---

## 4. Structured Output with Schema Validation

**Priority: High** | **Effort: Medium** | **Files: `src/llmProtocol.ts`, `src/types.ts`, `src/autonomousLoop.ts`**

**Current state:** The autonomous loop (`autonomousLoop.ts:98-100`) parses evaluation JSON with bare `JSON.parse()` — no validation, crashes on malformed output. No structured output support anywhere.

**Suggestion:**
- Add optional `outputSchema` to `ChatResult` and `AgentBuilder`:
```typescript
builder.setOutputSchema(z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  sources: z.array(z.string()),
}));
```
- Use OpenAI's `response_format: { type: "json_schema", json_schema: ... }` when available.
- For providers without native structured output, wrap with retry + validation loop.
- Validate autonomous loop evaluation output with Zod instead of bare `JSON.parse()`.

**Impact:** Type-safe agent outputs, fewer runtime crashes, better autonomous loop reliability.

---

## 5. Observability and Tracing

**Priority: High** | **Effort: Medium** | **New files: `src/telemetry.ts`**

**Current state:** No tracing, logging is ad-hoc `console.error`. No way to debug multi-turn agent behavior in production.

**Suggestion:**
- Implement OpenTelemetry semantic conventions for GenAI:
  - Span per `chat()` / `stream()` call
  - Child spans for each tool execution, LLM call, memory retrieval
  - Attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- Provide a `setTracer(tracer: Tracer)` on `AgentBuilder` for opt-in.
- Add Langfuse-compatible event hooks for evaluation/scoring.
- Emit structured logs instead of `console.error`.

**Impact:** Enterprise-readiness, production debugging, cost tracking.

---

## 6. Token and Cost Tracking

**Priority: High** | **Effort: Small** | **Files: `src/llmProtocol.ts`, `src/types.ts`**

**Current state:** Token usage from LLM responses is ignored. No cost tracking.

**Suggestion:**
- Extract `usage` from LLM responses (all providers return this):
```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
```
- Accumulate per-turn and per-session usage in `ChatResult`:
```typescript
interface ChatResult {
  reply: string;
  usage: TokenUsage;
  estimatedCost: number; // USD based on model pricing table
  // ...existing fields
}
```
- Add model pricing lookup table (maintainable JSON file).
- Expose `agent.getSessionCost(sessionId)` for running totals.

**Impact:** Cost visibility, budget enforcement, optimization insights.

---

## 7. Vector Embeddings for Memory Retrieval

**Priority: High** | **Effort: Large** | **Files: `src/memoryCore.ts`**

**Current state:** Memory retrieval is keyword-based only (`memoryCore.ts`). The MEMORY_PRD.md acknowledges this gap. Cannot distinguish semantically similar but lexically different queries.

**Suggestion:**
- Add an `EmbeddingProvider` interface:
```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```
- Implement for OpenAI (`text-embedding-3-small`), Anthropic Voyager, and local (Ollama).
- Store embeddings alongside memory entries. Use cosine similarity for retrieval scoring.
- For small-scale (< 10k entries), in-memory cosine search is sufficient. For larger scale, integrate with a vector store (Chroma, pgvector).
- Update the retrieval formula: `score = alpha * recency + beta * importance + gamma * cosineSimilarity`.

**Impact:** Dramatically better memory recall, core to agent learning.

---

## 8. Multi-Agent Orchestration

**Priority: Medium** | **Effort: Large** | **New files: `src/orchestrator.ts`, `src/patterns/`**

**Current state:** Single-agent execution only. `agentsCore.ts` exists but is minimal.

**Suggestion:**
- **Supervisor pattern:** A coordinator agent that delegates sub-tasks to specialist agents and synthesizes results:
```typescript
const supervisor = new AgentBuilder()
  .addAgent('researcher', researchAgent)
  .addAgent('writer', writerAgent)
  .setRoutingStrategy('supervisor') // supervisor decides who to call
  .build();
```
- **Swarm pattern:** Agents hand off to each other based on context (inspired by OpenAI Swarm):
```typescript
const triage = new AgentBuilder()
  .addHandoff('billing', billingAgent, 'When user asks about billing')
  .addHandoff('technical', techAgent, 'When user has technical issues')
  .build();
```
- **Pipeline pattern:** Sequential agent chain where output feeds into the next agent.
- Each sub-agent runs in its own session with isolated context.

**Impact:** Enables complex workflows, competitive table-stakes for 2026.

---

## 9. Guardrails and Safety Middleware

**Priority: Medium** | **Effort: Medium** | **New files: `src/guardrails.ts`**

**Current state:** Sandbox provides tool-level permission gating. No input/output content filtering.

**Suggestion:**
- Stackable middleware architecture:
```typescript
builder
  .addGuardrail(piiRedaction())       // Redact SSN, credit cards, emails
  .addGuardrail(promptInjection())    // Detect injection attempts
  .addGuardrail(topicFilter(['violence', 'illegal']))
  .addGuardrail(outputValidator(schema))
```
- Each guardrail implements `(input: string) => { pass: boolean; filtered: string; reason?: string }`.
- Run input guardrails before LLM call, output guardrails after.
- Log guardrail triggers for audit.

**Impact:** Enterprise safety requirements, compliance.

---

## 10. Concurrency Safety for Deferred Init

**Priority: Medium** | **Effort: Small** | **Files: `src/agentInstance.ts`**

**Current state:** `initStorage()` and `initMCP()` use promise-based dedup but have a subtle race: if two `chat()` calls arrive simultaneously, both check `_storageInitialized === false`, both enter the init block. The promise dedup (`_storageInitPromise`) mitigates double-execution, but the pattern is fragile.

**Suggestion:**
- Use a proper once-lock pattern:
```typescript
private _initOnce = new OnceBarrier(async () => {
  await this._initStorage();
  await this._initMCP();
});

async chat(message: string) {
  await this._initOnce.wait();
  // ...
}
```
- `OnceBarrier` is a simple class: first caller runs the init, all others await the same promise.

**Impact:** Eliminates race conditions in concurrent usage.

---

## 11. Error Taxonomy and Retry Strategy

**Priority: Medium** | **Effort: Small** | **Files: `src/errors.ts` (new), `src/llmProtocol.ts`, `src/agentInstance.ts`**

**Current state:** Errors are caught as generic `e` and converted to strings. Retry logic is duplicated between `llmProtocol.ts:212-237` and `agentInstance.ts:868-891`. No circuit breaker.

**Suggestion:**
- Define typed errors:
```typescript
class AgentError extends Error { constructor(message: string, public code: string) { super(message); } }
class RateLimitError extends AgentError { retryAfter: number; }
class ToolTimeoutError extends AgentError { toolName: string; }
class ToolExecutionError extends AgentError { toolName: string; cause: Error; }
class ContextOverflowError extends AgentError { tokenCount: number; budget: number; }
```
- Centralize retry logic with configurable strategy (exponential backoff, max attempts, circuit breaker).
- Distinguish retryable (rate limit, timeout) from fatal (auth, validation) errors.

**Impact:** Smarter error recovery, easier debugging.

---

## 12. Test Suite

**Priority: High** | **Effort: Medium** | **New directory: `tests/`**

**Current state:** Zero test coverage.

**Suggestion:**
- Unit tests (Vitest or Jest):
  - Tool execution + sandbox permission checks
  - Memory retrieval scoring algorithm
  - Context token budgeting + history trimming
  - Session persistence (file backend round-trip)
  - Streaming chunk assembly
  - Error classification and retry
- Integration tests:
  - Full agent loop with mock LLM (record/replay)
  - MCP tool discovery and execution
  - Autonomous loop convergence
- Add CI pipeline (GitHub Actions) with test + typecheck.

**Impact:** Confidence in changes, catch regressions, contributor onboarding.

---

## 13. Prompt Caching Strategy

**Priority: Medium** | **Effort: Small** | **Files: `src/llmProtocol.ts`**

**Current state:** No caching. Every call sends the full system prompt + tool definitions.

**Suggestion:**
- **Anthropic prompt caching:** Mark system prompt and tool definitions with `cache_control: { type: "ephemeral" }`. Cached prefixes cost 90% less and have 0 latency for the cached portion. The cache has a 5-minute TTL.
- **Semantic caching:** For repeated similar queries, hash the semantic intent (embedding + threshold) and return cached responses. Integrate with Redis or in-memory LRU.
- Expose `cacheHitRate` in token usage metrics.

**Impact:** 10x cost reduction for agents with stable system prompts.

---

## 14. Streaming Improvements

**Priority: Medium** | **Effort: Medium** | **Files: `src/agentInstance.ts`, `src/llmProtocol.ts`**

**Current state:** Streaming stops during tool execution phases. Tool calls don't stream. No backpressure.

**Suggestion:**
- Yield status chunks during tool execution:
```typescript
yield { delta: undefined, toolStatus: { name: 'search_docs', state: 'executing' }, done: false };
```
- Stream partial tool call arguments as they arrive (useful for long-running tool arg generation).
- Add `StreamChunk.usage` on the final chunk for token tracking.
- Consider ReadableStream adapter for web-native consumption (SSE, fetch streaming).

**Impact:** Better real-time UX, framework feels responsive.

---

## 15. Plugin and Extension Architecture

**Priority: Low** | **Effort: Large** | **New files: `src/plugins.ts`**

**Current state:** Tools and skills are registered at build time. No runtime discovery or community ecosystem.

**Suggestion:**
- Define a `Plugin` interface:
```typescript
interface AgentPlugin {
  name: string;
  version: string;
  setup(agent: AgentBuilder): void; // register tools, skills, guardrails
}
```
- Support npm-based plugin discovery: `builder.use(require('borderless-plugin-github'))`.
- Plugin lifecycle hooks: `onBeforeChat`, `onAfterChat`, `onToolCall`, `onError`.
- Community plugin registry (npm scope `@borderless-agent/plugin-*`).

**Impact:** Ecosystem growth, community contributions, extensibility.

---

## Summary Matrix

| # | Suggestion | Priority | Effort | Category |
|---|-----------|----------|--------|----------|
| 1 | Native multi-provider LLM | Critical | M | Core |
| 2 | Parallel tool execution | High | S | Performance |
| 3 | Per-tool timeout | High | S | Reliability |
| 4 | Structured output + Zod | High | M | Developer UX |
| 5 | Observability + OpenTelemetry | High | M | Operations |
| 6 | Token and cost tracking | High | S | Operations |
| 7 | Vector embeddings for memory | High | L | Intelligence |
| 8 | Multi-agent orchestration | Medium | L | Architecture |
| 9 | Guardrails + safety middleware | Medium | M | Safety |
| 10 | Concurrency safety | Medium | S | Reliability |
| 11 | Error taxonomy + retry | Medium | S | Reliability |
| 12 | Test suite | High | M | Quality |
| 13 | Prompt caching | Medium | S | Cost |
| 14 | Streaming improvements | Medium | M | UX |
| 15 | Plugin architecture | Low | L | Ecosystem |

**Recommended execution order:** 12 (tests first for safety net) -> 1 -> 2+3 -> 6 -> 4 -> 11 -> 5 -> 10 -> 13 -> 7 -> 14 -> 9 -> 8 -> 15
