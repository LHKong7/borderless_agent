# Implementation Roadmap

**Project:** borderless_agent  
**Parent:** ARCHITECTURE_IMPROVEMENT_PLAN.md  
**Date:** 2026-04-12

---

## 1. Overview

This roadmap details the phased implementation of architecture improvements for the agent loop and harness system. Each phase builds on the previous, ensuring a stable foundation before adding complex features.

---

## 2. Phase Summary

| Phase | Focus | Duration | Priority |
|-------|-------|----------|----------|
| 0 | Foundation (Errors, Retry) | 1 week | Critical |
| 1 | Reliability (Timeouts, Parallel Exec) | 1-2 weeks | Critical |
| 2 | Skills Management | 1-2 weeks | High |
| 3 | RAG/Memory Enhancement | 2-3 weeks | High |
| 4 | Observability & Tracing | 1-2 weeks | High |
| 5 | Context Management | 1-2 weeks | Medium |
| 6 | Multi-Agent | 2-3 weeks | Medium |

---

## 3. Phase 0: Foundation

**Goal:** Set up error handling and retry infrastructure

### 3.1 Error Taxonomy

**File:** `src/errors.ts`

```typescript
export class AgentError extends Error {
  constructor(message: string, public code: string, public recoverable: boolean = true) {
    super(message);
    this.name = 'AgentError';
  }
}

export class RateLimitError extends AgentError {
  constructor(public retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`, 'RATE_LIMIT', true);
  }
}

export class ToolTimeoutError extends AgentError {
  constructor(public toolName: string, public timeoutMs: number) {
    super(`Tool ${toolName} timed out after ${timeoutMs}ms`, 'TOOL_TIMEOUT', true);
  }
}

export class ToolExecutionError extends AgentError {
  constructor(toolName: string, public cause: Error) {
    super(`Tool ${toolName} failed: ${cause.message}`, 'TOOL_EXECUTION', true);
  }
}

export class ContextOverflowError extends AgentError {
  constructor(public tokenCount: number, public budget: number) {
    super(`Context overflow: ${tokenCount} > ${budget}`, 'CONTEXT_OVERFLOW', false);
  }
}

export class AuthenticationError extends AgentError {
  constructor(provider: string) {
    super(`Auth failed for ${provider}`, 'AUTH', false);
  }
}

export class SkillNotFoundError extends AgentError {
  constructor(skillName: string) {
    super(`Skill not found: ${skillName}`, 'SKILL_NOT_FOUND', false);
  }
}

export class SkillLoadError extends AgentError {
  constructor(skillName: string, reason: string) {
    super(`Failed to load ${skillName}: ${reason}`, 'SKILL_LOAD_FAILED', true);
  }
}
```

**Deliverables:**
- [ ] All error types defined in `src/errors.ts`
- [ ] Error codes documented
- [ ] Unit tests for error classification

### 3.2 Retry Strategy

**File:** `src/retry.ts`

```typescript
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

class RetryStrategy {
  private failures = new Map<string, number>();
  private circuitOpen = new Set<string>();
  
  async execute<T>(
    operation: () => Promise<T>,
    errorType: string,
    config: RetryConfig
  ): Promise<T>;
  
  isCircuitOpen(errorType: string): boolean;
  resetCircuit(errorType: string): void;
}
```

**Deliverables:**
- [ ] RetryStrategy class
- [ ] Circuit breaker
- [ ] Exponential backoff
- [ ] Unit tests

---

## 4. Phase 1: Reliability

**Goal:** Make the agent robust against failures with timeouts and parallel execution

### 4.1 Tool Timeout System

**Files:** `src/types.ts`, `src/agentInstance.ts`

**Changes:**
1. Add `timeout?: number` to `ToolDefinition`
2. Add `ExecutionContext` with `AbortSignal`
3. Wrap all tool executions with timeout

**Deliverables:**
- [ ] Tool timeout field in type definition
- [ ] ExecutionContext with AbortSignal
- [ ] Timeout wrapping in tool execution
- [ ] Test with slow tool

### 4.2 Parallel Tool Execution

**Files:** `src/agentInstance.ts`

**Changes:**
1. Categorize tools into parallel/serialized groups
2. Execute parallel tools with `Promise.allSettled`
3. Keep serialized tools in order

**Deliverables:**
- [ ] Tool categorization logic
- [ ] Parallel execution implementation
- [ ] Approval serialization
- [ ] Performance test

### 4.3 Enhanced LLM Retry

**Files:** `src/llmProtocol.ts`

**Changes:**
1. Integrate RetryStrategy into LLM calls
2. Classify retryable errors (429, 500, 502, 503)
3. Circuit breaker per provider

**Deliverables:**
- [ ] RetryStrategy integration
- [ ] Error classification
- [ ] Circuit breaker per provider
- [ ] Test with mocked rate limits

---

## 5. Phase 2: Skills Management

**Goal:** Implement a comprehensive skill system with lifecycle management

### 5.1 Skill Registry

**Files:** `src/skillRegistry.ts` (new)

```typescript
export class SkillRegistry {
  private _skills: Map<string, SkillDefinition> = new Map();
  private _byCategory: Map<string, Set<string>> = new Map();
  private _byTag: Map<string, Set<string>> = new Map();
  
  register(skill: SkillDefinition): void;
  get(name: string): SkillDefinition | undefined;
  list(): SkillDefinition[];
  listByCategory(category: string): SkillDefinition[];
  listByTag(tag: string): SkillDefinition[];
  resolve(name: string, visited?: Set<string>): SkillDefinition[];
  search(query: string, limit?: number): SkillDefinition[];
}
```

**Deliverables:**
- [ ] SkillRegistry class
- [ ] Category indexing
- [ ] Tag indexing
- [ ] Dependency resolution
- [ ] Search functionality

### 5.2 Skill Lifecycle Manager

**Files:** `src/skillLifecycle.ts` (new)

```typescript
export class SkillLifecycleManager {
  async loadSkill(name: string): Promise<SkillLoadResult>;
  async unloadSkill(name: string): Promise<void>;
  async reloadSkill(name: string): Promise<SkillLoadResult>;
  
  getLoadedContent(name: string): string | undefined;
  isLoaded(name: string): boolean;
  getActiveSkills(): string[];
  
  matchTriggers(input: string): SkillDefinition[];
}
```

**Deliverables:**
- [ ] SkillLifecycleManager class
- [ ] Load/unload/reload
- [ ] Dependency loading
- [ ] Trigger matching
- [ ] Active skill tracking

### 5.3 Enhanced Skill Tool

**Files:** `src/toolsCore.ts` or `src/skillTool.ts` (new)

**Changes:**
1. Add `action` parameter (load, unload, list, search, info)
2. Implement skill search
3. Show skill categories

**Deliverables:**
- [ ] Enhanced Skill tool
- [ ] List action
- [ ] Search action
- [ ] Info action
- [ ] Unload action

### 5.4 Skill Definition Enhancements

**Files:** `src/types.ts`

**Changes:**
```typescript
interface SkillDefinition {
  // Existing fields
  name: string;
  description: string;
  body: string;
  
  // NEW fields
  version?: string;
  tags?: string[];
  categories?: string[];
  examples?: SkillExample[];
  trigger?: string | RegExp;
  dependencies?: string[];
  provides?: string[];
  onLoad?: (ctx: SkillContext) => Promise<void>;
  onUnload?: (ctx: SkillContext) => void;
}
```

**Deliverables:**
- [ ] Enhanced SkillDefinition type
- [ ] SkillExample interface
- [ ] SkillContext interface
- [ ] Version compatibility checks

### 5.5 Integration with AgentBuilder

**Files:** `src/agentBuilder.ts`

**Changes:**
```typescript
// Add to AgentBuilder
addSkill(skill: SkillDefinition): this;
addSkills(skills: SkillDefinition[]): this;
setSkillStore(store: SkillStore): this;
```

**Deliverables:**
- [ ] addSkill/addSkills methods
- [ ] SkillStore integration
- [ ] Built-in skills registration

---

## 6. Phase 3: RAG/Memory Enhancement

**Goal:** Upgrade memory system with vector embeddings

### 6.1 Embedding Provider Interface

**Files:** `src/providers/embeddings.ts` (new)

```typescript
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
  
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIEmbeddings implements EmbeddingProvider { ... }
export class OllamaEmbeddings implements EmbeddingProvider { ... }
```

**Deliverables:**
- [ ] EmbeddingProvider interface
- [ ] OpenAIEmbeddings implementation
- [ ] OllamaEmbeddings implementation
- [ ] Integration with AgentBuilder

### 6.2 Memory Entry with Embeddings

**Files:** `src/memoryCore.ts`

**Changes:**
```typescript
interface MemoryEntry {
  id: string;
  type: 'episodic' | 'semantic';
  content: string;
  
  // NEW
  embedding?: number[];
  embeddingModel?: string;
  
  importance: number;
  created_at: number;
  last_accessed: number;
}
```

**Deliverables:**
- [ ] MemoryEntry with embedding field
- [ ] Embedding storage
- [ ] Model tracking

### 6.3 Hybrid Retrieval

**Files:** `src/memoryCore.ts`

**Changes:**
```typescript
// Scoring with embeddings
score = alpha * recency + beta * importance + gamma * keywordRelevance + delta * cosineSimilarity;
```

**Deliverables:**
- [ ] Cosine similarity function
- [ ] Hybrid scoring
- [ ] Fallback to keyword-only
- [ ] Retrieval quality tests

### 6.4 Embedding Generation

**Files:** `src/memoryCore.ts`

**Changes:**
1. Generate embeddings on memory write
2. Batch embedding generation
3. Background embedding updates

**Deliverables:**
- [ ] Inline embedding generation
- [ ] Batch processing
- [ ] Background updates
- [ ] Performance tests

---

## 7. Phase 4: Observability & Tracing

**Goal:** Add comprehensive telemetry

### 7.1 Telemetry Core

**Files:** `src/telemetry.ts` (new)

```typescript
export class Telemetry {
  constructor(config: TelemetryConfig);
  
  startSpan(name: string, parent?: Span): Span;
  endSpan(span: Span): void;
  
  recordChatCall(span: Span, model: string, usage: TokenUsage, durationMs: number): void;
  recordToolCall(span: Span, tool: string, durationMs: number, success: boolean, error?: string): void;
  recordMemoryRetrieval(span: Span, count: number, scores: number[]): void;
  recordSkillLoad(name: string, success: boolean, error?: string): void;
}
```

**Deliverables:**
- [ ] Telemetry class
- [ ] Span creation/destruction
- [ ] GenAI semantic conventions
- [ ] Console exporter (default)

### 7.2 Structured Logging

**Files:** `src/logging.ts` (new)

```typescript
export class Logger {
  constructor(module: string, telemetry: Telemetry);
  
  debug(msg: string, ctx?: Record<string, any>): void;
  info(msg: string, ctx?: Record<string, any>): void;
  warn(msg: string, ctx?: Record<string, any>): void;
  error(msg: string, err?: Error, ctx?: Record<string, any>): void;
  
  child(ctx: Record<string, any>): Logger;
}
```

**Deliverables:**
- [ ] Logger class
- [ ] JSON formatting
- [ ] Module tagging
- [ ] Log level filtering

### 7.3 Metrics Collection

**Files:** `src/metrics.ts` (new)

```typescript
export class MetricsCollector {
  recordTurn(turn: TurnMetrics): void;
  recordToolCall(name: string, durationMs: number, success: boolean): void;
  recordError(type: string): void;
  
  getMetrics(): AgentMetrics;
  reset(): void;
}
```

**Deliverables:**
- [ ] MetricsCollector class
- [ ] Turn metrics
- [ ] Tool metrics
- [ ] Error tracking

### 7.4 Span Hierarchy Integration

**Files:** `src/agentInstance.ts`, `src/memoryCore.ts`, `src/skillLifecycle.ts`

**Changes:**
1. Wrap all operations with spans
2. Propagate context through async calls
3. Add traceId/spanId to logs

**Deliverables:**
- [ ] Agent turn span
- [ ] LLM call spans
- [ ] Tool execution spans
- [ ] Memory operation spans
- [ ] Skill load spans

---

## 8. Phase 5: Context Management

**Goal:** Improve context assembly and budget management

### 8.1 Budget Manager

**Files:** `src/contextCore.ts`

```typescript
export class BudgetManager {
  constructor(model?: string, features?: string[]);
  
  compute(): TokenBudget;
  get remainingForHistory(): number;
}
```

**Deliverables:**
- [ ] BudgetManager class
- [ ] Dynamic budget computation
- [ ] History budget tracking

### 8.2 Source Registry

**Files:** `src/sourceRegistry.ts` (new)

```typescript
export class SourceRegistry {
  register(source: ContextSource): void;
  get(name: string): ContextSource | undefined;
  remove(name: string): void;
  assemble(budget: TokenBudget): ChatMessage[];
}
```

**Deliverables:**
- [ ] SourceRegistry class
- [ ] Priority-based assembly
- [ ] TTL support
- [ ] Budget-aware truncation

### 8.3 Context Builder

**Files:** `src/contextBuilder.ts` (new)

**Deliverables:**
- [ ] ContextBuilder class
- [ ] Memory integration
- [ ] Skill integration
- [ ] Pattern integration

---

## 9. Phase 6: Multi-Agent

**Goal:** Enable complex multi-agent workflows

### 9.1 Supervisor Orchestrator

**Files:** `src/orchestrator.ts` (new)

```typescript
interface SubAgent {
  name: string;
  instance: AgentInstance;
  description: string;
  capabilities: string[];
}

class SupervisorOrchestrator {
  register(agent: SubAgent): void;
  async route(task: string): Promise<string>;
  async execute(task: string): Promise<string>;
}
```

**Deliverables:**
- [ ] SubAgent interface
- [ ] SupervisorOrchestrator
- [ ] LLM-based routing
- [ ] Result synthesis

### 9.2 Handoff Router

**Files:** `src/orchestrator.ts`

```typescript
interface HandoffRule {
  condition: (task: string) => Promise<boolean>;
  toAgent: string;
  description: string;
}

class HandoffRouter {
  addRule(pattern: RegExp, toAgent: string): void;
  addRule(condition: (task: string) => Promise<boolean>, toAgent: string): void;
  async route(task: string): Promise<string | null>;
}
```

**Deliverables:**
- [ ] HandoffRule interface
- [ ] HandoffRouter
- [ ] Pattern-based routing
- [ ] Condition-based routing

---

## 10. Implementation Checklist

### Phase 0: Foundation
- [ ] `src/errors.ts` - All error types
- [ ] `src/retry.ts` - RetryStrategy with circuit breaker
- [ ] Unit tests

### Phase 1: Reliability
- [ ] Tool timeout in types and execution
- [ ] Parallel tool execution
- [ ] LLM retry with circuit breaker

### Phase 2: Skills Management
- [ ] `src/skillRegistry.ts` - SkillRegistry
- [ ] `src/skillLifecycle.ts` - SkillLifecycleManager
- [ ] Enhanced Skill tool
- [ ] SkillDefinition enhancements

### Phase 3: RAG/Memory
- [ ] `src/providers/embeddings.ts` - EmbeddingProvider
- [ ] Memory with vector support
- [ ] Hybrid retrieval
- [ ] Embedding generation

### Phase 4: Observability
- [ ] `src/telemetry.ts` - Telemetry with spans
- [ ] `src/logging.ts` - Structured logging
- [ ] `src/metrics.ts` - MetricsCollector
- [ ] Span integration throughout

### Phase 5: Context Management
- [ ] BudgetManager
- [ ] SourceRegistry
- [ ] ContextBuilder

### Phase 6: Multi-Agent
- [ ] SupervisorOrchestrator
- [ ] HandoffRouter

---

## 11. Testing Strategy

### 11.1 Unit Tests (per phase)

```
tests/
  unit/
    errors.test.ts
    retry.test.ts
    skillRegistry.test.ts
    skillLifecycle.test.ts
    memoryCore.test.ts
    telemetry.test.ts
    contextBuilder.test.ts
    toolExecutor.test.ts
```

### 11.2 Integration Tests

```
tests/
  integration/
    agentLoop.test.ts
    skillsWorkflow.test.ts
    memoryRetrieval.test.ts
    streaming.test.ts
```

### 11.3 Test Infrastructure

```bash
npm run test          # All tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests
npm run test:coverage # Coverage report
```

---

## 12. Risk Mitigation

| Risk | Mitigation | Fallback |
|------|------------|----------|
| Embedding provider unavailable | Fallback to keyword search | Disable memory RAG |
| Parallel execution breaks tools | Sequential by default | Config flag to disable |
| Telemetry slows agent | Async, non-blocking | Disable with env var |
| Skills create cycles | Cycle detection in resolve | Limit dependency depth |
| Multi-agent routing fails | Default to main agent | Fallback agent |

---

## 13. Success Metrics

| Phase | Metric | Target |
|-------|--------|--------|
| 0 | Error type test coverage | 100% |
| 1 | Tool timeout works | <1s on stuck tool |
| 1 | Parallel execution speedup | 2-5x on multi-tool |
| 2 | Skill load time | <100ms |
| 2 | Skill trigger accuracy | >90% |
| 3 | Memory retrieval relevance | >80% |
| 4 | Trace completeness | All ops traced |
| 5 | Context assembly time | <50ms |
| 6 | Routing accuracy | >90% correct agent |
