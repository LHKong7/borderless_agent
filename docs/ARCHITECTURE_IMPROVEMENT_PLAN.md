# Agent Architecture Improvement Plan

**Project:** borderless_agent  
**Based on:** claude-code-rev-main analysis  
**Date:** 2026-04-12

---

## Executive Summary

This document outlines a comprehensive architecture improvement plan for `borderless_agent`, derived from analysis of the `claude-code-rev-main` reference codebase. The plan addresses critical gaps in the agent loop, context management, memory/RAG system, skills management, tool execution, and observability.

---

## 1. Current Architecture Overview

### 1.1 Existing Core Modules

| Module | File | Responsibility |
|--------|------|----------------|
| Agent Loop | `loopCore.ts`, `agentInstance.ts` | Main turn loop, tool execution |
| Context | `contextCore.ts` | Token budgeting, history trimming, system assembly |
| Memory/RAG | `memoryCore.ts` | Episodic + semantic memory, RAG retrieval |
| Session | `sessionCore.ts` | Session lifecycle, persistence |
| Tools | `toolsCore.ts` | Tool definitions and implementations |
| Skills | `skillsCore.ts` | Skill loading and management |
| Sandbox | `sandbox.ts` | Permission system, command analysis |
| Agents | `agentsCore.ts` | Subagent type registry |
| MCP | `mcpClient.ts` | MCP server connections |
| Autonomous | `autonomousLoop.ts` | Self-evaluating task loop |

### 1.2 RAG Implementation (Current)

The codebase already has RAG implemented via `memoryCore.ts`:
- `retrieve(query, k)` - retrieves top k memories using keyword-based scoring
- Scoring: `score = α·Recency + β·Importance + γ·Relevance`
- Fallback: keyword matching when no embeddings available

### 1.3 Identified Gaps vs claude-code-rev-main

| Aspect | borderless_agent | claude-code-rev-main |
|--------|------------------|----------------------|
| Tool execution | Sequential | Parallel (when safe) |
| Observability | console.error only | OpenTelemetry + structured logs |
| Error taxonomy | Generic try/catch | Typed errors with retry strategy |
| Streaming | Basic delta chunks | Tool status + backpressure |
| Memory/RAG | Keyword-based | Vector embeddings + cosine similarity |
| Skills | Basic loading | Structured skill system with versioning |
| Conversation | No summarization | Context collapse + compact service |
| Multi-agent | Task tool only | Supervisor + Swarm patterns |
| Hooks | None | 87 specialized hooks |

---

## 2. Architecture Improvement Recommendations

### 2.1 Agent Loop Enhancements

#### 2.1.1 Parallel Tool Execution
**Priority: Critical** | **Effort: Small**

Current: Sequential execution in `agentInstance.ts`

```typescript
// CURRENT (sequential)
for (const tc of toolCalls) {
  results.push(await this._executeTool(tc.function.name, args));
}
```

Recommended: Parallel execution with approval serialization

```typescript
// RECOMMENDED
const [approvalTools, autoTools] = partition(toolCalls, tc => needsApproval(tc.name));
const autoResults = await Promise.allSettled(autoTools.map(tc => executeTool(tc)));
for (const tc of approvalTools) {
  if (await requestApproval(tc)) results.push(await executeTool(tc));
}
```

#### 2.1.2 Tool Timeout with AbortController
**Priority: Critical** | **Effort: Small**

Add per-tool timeout to prevent hung agents:

```typescript
interface ToolDefinition {
  timeout?: number;  // ms, default 30s
  execute: (args: Record<string, any>, ctx?: ExecutionContext) => Promise<string>;
}

interface ExecutionContext {
  signal: AbortSignal;
  sandbox: Sandbox;
}
```

#### 2.1.3 Enhanced Streaming
**Priority: High** | **Effort: Medium**

```typescript
interface StreamChunk {
  delta?: string;
  toolStatus?: {
    name: string;
    state: 'queued' | 'executing' | 'complete' | 'error';
    output?: string;
  };
  reply?: string;
  done: boolean;
}
```

---

### 2.2 Harness: Context Management

#### 2.2.1 Token Budget System
**Priority: High**

```typescript
interface TokenBudget {
  total: number;
  system: number;        // Reserved for system
  rag: number;           // Reserved for RAG/memories
  history: number;       // Reserved for conversation
  output_reserve: number;
}

class BudgetManager {
  compute(model?: string): TokenBudget;
  allocate(source: 'system' | 'rag' | 'history', tokens: number): boolean;
}
```

#### 2.2.2 Source Registry
**Priority: High**

```typescript
interface ContextSource {
  name: string;
  content: string;
  priority: number;      // 0.0 - 1.0
  category: 'system' | 'rag' | 'summary' | 'preferences';
  ttl?: number;
}

class SourceRegistry {
  register(source: ContextSource): void;
  assemble(budget: TokenBudget): ChatMessage[];
}
```

#### 2.2.3 RAG Enhancement (Vector Embeddings)
**Priority: High** | **Effort: Large**

Current: Keyword-based retrieval

```typescript
// CURRENT scoring in memoryCore.ts
score = alpha * recency + beta * importance + gamma * relevance;

// RECOMMENDED: Hybrid with embeddings
score = alpha * recency + beta * importance + gamma * relevance + delta * embeddingSimilarity;
```

Add embedding provider interface:

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
  model: string;
}
```

---

### 2.3 Harness: Skills Management

#### 2.3.1 Current State
**File:** `skillsCore.ts`

Current implementation:
- Loads skills from `SKILL.md` files in `skills/` directory
- `SkillLoader` class with file-based loading
- Frontmatter parsing (name, description, body)
- Resource scanning (scripts/, references/, assets/)

#### 2.3.2 Skill Definition Enhancement
**Priority: High**

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  
  // NEW fields
  version?: string;
  author?: string;
  tags?: string[];
  categories?: string[];
  examples?: SkillExample[];
  trigger?: string | RegExp;  // Auto-load trigger conditions
  
  // Dependencies
  dependencies?: string[];     // Other skills required
  provides?: string[];        // Capabilities this skill adds
  
  // Lifecycle
  onLoad?: (ctx: SkillContext) => Promise<void>;
  onUnload?: (ctx: SkillContext) => void;
}

interface SkillExample {
  description: string;
  input: string;
  output: string;
}

interface SkillContext {
  session: AgentSession;
  memory: MemorySystem;
  sandbox: Sandbox;
}
```

#### 2.3.3 Skill Registry
**Priority: High**

```typescript
class SkillRegistry {
  private _skills: Map<string, SkillDefinition> = new Map();
  private _byCategory: Map<string, Set<string>> = new Map();
  private _byTag: Map<string, Set<string>> = new Map();
  
  register(skill: SkillDefinition): void;
  get(name: string): SkillDefinition | undefined;
  list(): SkillDefinition[];
  listByCategory(category: string): SkillDefinition[];
  listByTag(tag: string): SkillDefinition[];
  
  // Skill resolution with dependency graph
  resolve(name: string, loaded: Set<string>): SkillDefinition[];
}
```

#### 2.3.4 Skill Lifecycle Manager
**Priority: High**

```typescript
class SkillLifecycleManager {
  private _activeSkills: Set<string> = new Set();
  private _skillContexts: Map<string, SkillContext> = new Map();
  
  async loadSkill(name: string): Promise<SkillContext>;
  async unloadSkill(name: string): Promise<void>;
  async reloadSkill(name: string): Promise<SkillContext>;
  
  // Auto-trigger based on patterns
  matchTrigger(input: string): SkillDefinition | null;
}
```

#### 2.3.5 Skill Loading Pipeline
**Priority: High**

```typescript
async function loadSkill(
  skillName: string,
  context: TurnContext
): Promise<SkillLoadResult> {
  const skill = skillRegistry.get(skillName);
  if (!skill) return { success: false, error: 'NOT_FOUND' };
  
  // Check dependencies
  const deps = skillRegistry.resolve(skillName, loadedSkills);
  for (const dep of deps) {
    if (!_activeSkills.has(dep.name)) {
      await loadSkill(dep.name, context);
    }
  }
  
  // Execute onLoad if present
  if (skill.onLoad) {
    const skillCtx = createSkillContext(skill, context);
    await skill.onLoad(skillCtx);
    _skillContexts.set(skillName, skillCtx);
  }
  
  _activeSkills.add(skillName);
  return { 
    success: true, 
    content: skill.body,
    dependencies: deps.map(d => d.name)
  };
}
```

#### 2.3.6 Skill Discovery & Recommendations
**Priority: Medium**

```typescript
interface SkillRecommendation {
  skill: SkillDefinition;
  score: number;
  reason: 'trigger_match' | 'context_similarity' | 'history_pattern';
}

// Recommend skills based on context
function recommendSkills(
  input: string,
  context: TurnContext,
  limit: number = 3
): SkillRecommendation[] {
  const scores: SkillRecommendation[] = [];
  
  for (const skill of skillRegistry.list()) {
    let score = 0;
    let reason: SkillRecommendation['reason'] = 'context_similarity';
    
    // Trigger match
    if (skill.trigger) {
      if (typeof skill.trigger === 'string' && input.includes(skill.trigger)) {
        score += 0.8;
        reason = 'trigger_match';
      } else if (skill.trigger instanceof RegExp && skill.trigger.test(input)) {
        score += 0.8;
        reason = 'trigger_match';
      }
    }
    
    // Category matching
    if (matchesContextCategory(skill, context)) score += 0.2;
    
    // History patterns
    if (matchesHistoryPattern(skill, context)) score += 0.3;
    
    if (score > 0) {
      scores.push({ skill, score, reason });
    }
  }
  
  return scores.sort((a, b) => b.score - a.score).slice(0, limit);
}
```

#### 2.3.7 Skill Tool Enhancement
**Priority: High**

The `Skill` tool should be enhanced to support:

```typescript
const SKILL_TOOL = {
  name: 'Skill',
  description: `Load a skill to gain specialized knowledge for a task.

Available skills:
${skillRegistry.list().map(s => `- ${s.name}: ${s.description}`).join('\n')}

Categories: ${skillCategories().join(', ')}

Use /skill list to see all available skills.
Use /skill search <query> to find relevant skills.`,
  
  input_schema: {
    type: 'object',
    properties: {
      skill: { 
        type: 'string', 
        description: 'Skill name to load' 
      },
      action: {
        type: 'string',
        enum: ['load', 'unload', 'list', 'search', 'info'],
        description: 'Action to perform',
        default: 'load'
      },
      query: {
        type: 'string',
        description: 'Search query for /skill search action'
      }
    },
    required: ['skill']
  }
};
```

#### 2.3.8 Skill Versioning & Compatibility
**Priority: Medium**

```typescript
interface SkillVersion {
  version: string;
  agentVersion?: string;    // Compatible agent version
  breakingChanges?: string;
  migrationGuide?: string;
}

class SkillVersionManager {
  checkCompatibility(skill: SkillDefinition): boolean;
  getMigrationPath(from: string, to: string): string[];
}
```

---

### 2.4 Harness: Observability & Tracing

#### 2.4.1 Telemetry System (NEW)
**Priority: High**

Currently: No tracing exists

```typescript
// src/telemetry.ts (new)

import { trace, Span, SpanStatusCode, Tracer, Context } from '@opentelemetry/api';

interface TelemetryConfig {
  serviceName: string;
  exporter?: SpanExporter;
  samplingRatio?: number;
}

interface SpanAttributes {
  'gen_ai.system'?: string;
  'gen_ai.request.model'?: string;
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'agent.tool.name'?: string;
  'agent.tool.duration_ms'?: number;
  'agent.tool.success'?: boolean;
  'agent.session.id'?: string;
  'agent.turn.number'?: number;
}

class Telemetry {
  private tracer: Tracer;
  private spans: Map<string, Span> = new Map();
  
  startSpan(name: string, parent?: Span): Span {
    return this.tracer.startSpan(name, { parent });
  }
  
  // GenAI semantic conventions
  recordChatCall(
    span: Span,
    model: string,
    usage: Record<string, number>,
    duration: number
  ): void {
    span.setAttributes({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': model,
      'gen_ai.usage.input_tokens': usage.input_tokens,
      'gen_ai.usage.output_tokens': usage.output_tokens,
      'gen_ai.usage.total_tokens': usage.total_tokens,
      'llm.duration_ms': duration
    });
    span.setStatus({ code: SpanStatusCode.OK });
  }
  
  recordToolCall(
    span: Span,
    tool: string,
    duration: number,
    success: boolean,
    error?: string
  ): void {
    span.setAttributes({
      'agent.tool.name': tool,
      'agent.tool.duration_ms': duration,
      'agent.tool.success': success
    });
    if (error) {
      span.setAttribute('agent.tool.error', error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
  }
  
  recordMemoryRetrieval(
    span: Span,
    count: number,
    scores: number[]
  ): void {
    span.setAttributes({
      'agent.memory.retrieved_count': count,
      'agent.memory.avg_score': scores.reduce((a,b) => a+b, 0) / scores.length
    });
  }
}
```

#### 2.4.2 Span Hierarchy
**Priority: High**

```
agent.turn (root span)
├── agent.context_build
│   ├── memory.retrieve
│   ├── source.register
│   └── context.assemble
├── llm.chat
│   ├── llm.token_count
│   └── llm.call
├── agent.tools
│   ├── tool.execute (read_file)
│   ├── tool.execute (grep)
│   └── tool.execute (bash)
│       └── sandbox.check
├── memory.consolidate
│   ├── memory.write_event
│   └── memory.record_pattern
├── skill.load
│   └── skill.parse
└── guardrails.check
```

#### 2.4.3 Structured Logging
**Priority: High**

```typescript
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
  context?: Record<string, any>;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
}

class Logger {
  constructor(module: string, private telemetry: Telemetry);
  
  debug(msg: string, ctx?: Record<string, any>): void;
  info(msg: string, ctx?: Record<string, any>): void;
  warn(msg: string, ctx?: Record<string, any>): void;
  error(msg: string, err?: Error, ctx?: Record<string, any>): void;
  
  // Child logger with additional context
  child(ctx: Record<string, any>): Logger;
}
```

#### 2.4.4 Metrics Collection
**Priority: Medium**

```typescript
interface AgentMetrics {
  turnCount: number;
  toolCallsPerTurn: number[];
  tokensPerTurn: { input: number; output: number }[];
  durationPerTurn: number[];
  totalToolCalls: number;
  totalTokens: number;
  totalCost: number;
  memoryItemCount: number;
  cacheHitRate: number;
  errorCount: number;
  errorTypes: Record<string, number>;
}

class MetricsCollector {
  recordTurn(turn: TurnResult): void;
  recordToolCall(tool: string, duration: number, success: boolean): void;
  recordLLMCall(model: string, usage: TokenUsage, duration: number): void;
  
  getMetrics(): AgentMetrics;
  reset(): void;
}
```

#### 2.4.5 Exporters
**Priority: Medium**

```typescript
interface SpanExporter {
  export(spans: Span[]): Promise<void>;
}

// Console exporter (development)
class ConsoleSpanExporter implements SpanExporter { ... }

// OTLP exporter (production)
class OTLPSpanExporter implements SpanExporter { ... }

// Langfuse exporter (for evaluation)
class LangfuseExporter implements SpanExporter { ... }
```

---

### 2.5 Error Taxonomy

#### 2.5.1 Typed Errors
**Priority: High**

```typescript
// src/errors.ts (new)

export class AgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public recoverable: boolean = true
  ) { super(message); }
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
    super(`Failed to load skill ${skillName}: ${reason}`, 'SKILL_LOAD_FAILED', true);
  }
}
```

#### 2.5.2 Retry Strategy
**Priority: High**

```typescript
class RetryStrategy {
  private failures = new Map<string, number>();
  private circuitOpen = new Set<string>();
  
  async execute<T>(
    operation: () => Promise<T>,
    errorType: string,
    config: RetryConfig
  ): Promise<T> {
    if (this.circuitOpen.has(errorType)) {
      throw new AgentError('Circuit breaker open', 'CIRCUIT_OPEN', false);
    }
    
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (e: any) {
        if (!this.isRetryable(e, config.retryableErrors)) throw e;
        if (attempt < config.maxAttempts) {
          await sleep(this.backoff(attempt, config));
        }
      }
    }
    throw new Error('Retry exhausted');
  }
  
  private isRetryable(error: Error, retryable: string[]): boolean;
  private backoff(attempt: number, config: RetryConfig): number;
}
```

---

## 3. Implementation Priority Matrix

| # | Component | Priority | Effort | Category |
|---|----------|----------|--------|----------|
| 1 | Parallel tool execution | Critical | Small | Agent Loop |
| 2 | Tool timeout/AbortController | Critical | Small | Agent Loop |
| 3 | Typed errors + retry | High | Small | Reliability |
| 4 | OpenTelemetry tracing | High | Medium | Observability |
| 5 | Structured logging | High | Medium | Observability |
| 6 | Skills registry + lifecycle | High | Medium | Skills |
| 7 | Vector embeddings for RAG | High | Large | RAG/Memory |
| 8 | Skill trigger system | Medium | Medium | Skills |
| 9 | Conversation summarization | Medium | Medium | Context |
| 10 | Guardrails | Medium | Medium | Safety |
| 11 | Multi-agent patterns | Medium | Large | Architecture |
| 12 | Plugin architecture | Low | Large | Extensibility |

---

## 4. Files to Create/Modify

### New Files
```
src/
  ├── errors.ts              # Typed error definitions
  ├── telemetry.ts           # OpenTelemetry + structured logging
  ├── skillRegistry.ts       # Skill registry and lifecycle
  ├── metrics.ts            # Metrics collection
  ├── retry.ts              # Retry strategy with circuit breaker
  ├── providers/
  │   └── embeddings.ts     # Embedding provider interface
```

### Modified Files
```
src/
  ├── types.ts              # Add timeout, ExecutionContext, Skill enhancements
  ├── agentInstance.ts      # Parallel execution, timeouts, streaming
  ├── skillsCore.ts         # SkillRegistry integration
  ├── memoryCore.ts         # Vector embedding support
  ├── contextCore.ts        # SourceRegistry, BudgetManager
  ├── llmProtocol.ts        # Error taxonomy integration
  ├── agentBuilder.ts       # New config options
```

---

## 5. Backward Compatibility

All improvements maintain backward compatibility:
- New fields in interfaces are optional
- Existing APIs unchanged
- Feature flags for opt-in enhancements
- Environment variables for global defaults
