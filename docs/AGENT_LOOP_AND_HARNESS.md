# Agent Loop and Harness Design

**Project:** borderless_agent  
**Parent:** ARCHITECTURE_IMPROVEMENT_PLAN.md  
**Date:** 2026-04-12

---

## 1. Overview

The "harness" is the infrastructure surrounding the agent loop that manages:
- **Context**: Token budgets, history, system prompts, RAG
- **Memory/RAG**: Short-term, long-term, episodic, semantic with vector retrieval
- **Skills**: Dynamic skill loading, lifecycle management, triggers
- **Tools**: Registration, execution, permissions, timeouts
- **Observability**: Tracing, logging, metrics

---

## 2. Agent Loop Architecture

### 2.1 Enhanced Turn Flow

```
User Input
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ GuardrailMiddleware                                    │
│   - Input validation                                   │
│   - PII redaction                                     │
│   - Injection detection                               │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Telemetry: span=agent.turn                             │
│   - traceId, spanId injection                         │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ ContextBuilder                                         │
│   - RAG retrieval (memory.retrieve)                   │
│   - Source registry assembly                          │
│   - Budget-aware history selection                     │
│   - Conversation summary (if needed)                  │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ SkillMatcher                                          │
│   - Trigger-based skill detection                     │
│   - Context-similarity scoring                        │
│   - Auto-load recommendations                        │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ LLM.chat() [Streaming]                                │
│   Telemetry: span=llm.chat                            │
└─────────────────────────────────────────────────────────┘
    │
    ├─► No tool calls → Output guardrails → Return
    │
    ▼ (has tool calls)
┌─────────────────────────────────────────────────────────┐
│ ToolExecutor                     Telemetry: span=tools │
│   - Categorize: parallel vs serialized                 │
│   - Execute parallel tools with Promise.allSettled    │
│   - Serialize approval-required tools                 │
│   - Timeout management per tool                       │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ ObservationProcessor                                   │
│   - foldObservation()                                 │
│   - PII sanitization                                  │
│   - Truncation                                        │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Memory Consolidation                                   │
│   Telemetry: span=memory.consolidate                  │
│   - writeEvent()                                      │
│   - recordPattern()                                   │
│   - Extract insights                                  │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Check: more rounds?                                    │
│   - Budget remaining                                  │
│   - Max rounds limit                                  │
│   - Convergence detection                             │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 ToolExecutor

```typescript
// src/toolExecutor.ts (new)

import { AgentError, ToolTimeoutError, ToolExecutionError } from './errors';

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface ToolResult {
  id: string;
  output: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface ExecutionPlan {
  parallel: ToolCall[];
  serialized: ToolCall[];
}

class ToolExecutor {
  private toolMap: Map<string, ToolDefinition>;
  private sandbox: Sandbox;
  private telemetry?: Telemetry;
  
  async executeAll(
    toolCalls: ToolCall[],
    context: ExecutionContext
  ): Promise<ToolResult[]> {
    const plan = this.planExecution(toolCalls);
    const results: ToolResult[] = [];
    
    // Execute parallel group concurrently
    if (plan.parallel.length > 0) {
      const parallelResults = await Promise.allSettled(
        plan.parallel.map(tc => this.executeWithTimeout(tc, context))
      );
      results.push(...this.mapSettledResults(parallelResults, plan.parallel));
    }
    
    // Execute serialized group (approval required)
    for (const tc of plan.serialized) {
      const approved = await this.requestApproval(tc, context);
      if (approved) {
        const result = await this.executeWithTimeout(tc, context);
        results.push(result);
      } else {
        results.push({
          id: tc.id,
          output: 'Action not approved by user.',
          success: false,
          durationMs: 0,
          error: 'USER_DENIED'
        });
      }
    }
    
    return results;
  }
  
  private async executeWithTimeout(
    toolCall: ToolCall,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const tool = this.toolMap.get(toolCall.name);
    const span = this.telemetry?.startSpan(`tool.${toolCall.name}`);
    
    try {
      const timeout = tool?.timeout ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      
      try {
        const execContext: ExecutionContext = {
          ...context,
          signal: controller.signal
        };
        
        const output = await tool!.execute(toolCall.arguments, execContext);
        
        this.telemetry?.recordToolCall(span!, toolCall.name, Date.now() - span!.startTime, true);
        
        return {
          id: toolCall.id,
          output,
          success: true,
          durationMs: Date.now() - (span?.startTime ?? Date.now())
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      const duration = Date.now() - (span?.startTime ?? Date.now());
      
      if (e instanceof ToolTimeoutError) {
        this.telemetry?.recordToolCall(span!, toolCall.name, duration, false, 'TIMEOUT');
        return {
          id: toolCall.id,
          output: `[Timeout] Tool ${toolCall.name} timed out after ${timeout}ms`,
          success: false,
          durationMs: duration,
          error: 'TIMEOUT'
        };
      }
      
      this.telemetry?.recordToolCall(span!, toolCall.name, duration, false, e.message);
      return {
        id: toolCall.id,
        output: `[Error] ${e.message}`,
        success: false,
        durationMs: duration,
        error: e.code ?? 'UNKNOWN'
      };
    } finally {
      span?.end();
    }
  }
  
  private planExecution(toolCalls: ToolCall[]): ExecutionPlan {
    const parallel: ToolCall[] = [];
    const serialized: ToolCall[] = [];
    
    for (const tc of toolCalls) {
      const tool = this.toolMap.get(tc.name);
      if (tool?.requiresApproval) {
        serialized.push(tc);
      } else {
        parallel.push(tc);
      }
    }
    
    return { parallel, serialized };
  }
}
```

---

## 4. Harness: Context Management

### 4.1 Token Budget System

```typescript
// src/contextCore.ts (enhanced)

export interface TokenBudget {
  total: number;
  system: number;
  rag: number;
  history: number;
  output_reserve: number;
  inputBudget: number;
}

export const SYSTEM_RESERVE_TOKENS = 1000;
export const RAG_RATIO = 0.40;
export const HISTORY_RATIO = 0.50;

export class BudgetManager {
  private _model?: string;
  private _features: string[];
  
  constructor(model?: string, features?: string[]) {
    this._model = model;
    this._features = features ?? [];
  }
  
  compute(): TokenBudget {
    const total = getContextWindowSize(this._model, this._features);
    const outputReserve = getMaxOutputTokens(this._model);
    const inputBudget = Math.max(0, total - outputReserve);
    
    return {
      total,
      system: SYSTEM_RESERVE_TOKENS,
      rag: Math.floor(inputBudget * RAG_RATIO),
      history: Math.floor(inputBudget * HISTORY_RATIO),
      output_reserve: outputReserve,
      inputBudget
    };
  }
  
  get remainingForHistory(): number {
    const budget = this.compute();
    return Math.max(0, budget.inputBudget - budget.system - budget.rag);
  }
}
```

### 4.2 Source Registry

```typescript
// src/sourceRegistry.ts (new)

export interface ContextSource {
  name: string;
  content: string;
  priority: number;
  category: 'system' | 'rag' | 'summary' | 'preferences' | 'skill';
  maxTokens?: number;
  ttl?: number;
  tags?: string[];
  createdAt: number;
}

export class SourceRegistry {
  private _sources: Map<string, ContextSource> = new Map();
  
  register(source: Omit<ContextSource, 'createdAt'>): void {
    this._sources.set(source.name, {
      ...source,
      maxTokens: source.maxTokens ?? estimateTokens(source.content),
      createdAt: Date.now()
    });
  }
  
  get(name: string): ContextSource | undefined {
    return this._sources.get(name);
  }
  
  remove(name: string): void {
    this._sources.delete(name);
  }
  
  assemble(budget: TokenBudget): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let usedTokens = 0;
    
    const sorted = Array.from(this._sources.values())
      .sort((a, b) => b.priority - a.priority);
    
    for (const source of sorted) {
      if (usedTokens + source.maxTokens! > budget.history) {
        if (source.priority >= 0.6) {
          const truncated = this.truncate(source, budget.history - usedTokens);
          if (truncated) messages.push({ role: 'system', content: truncated });
        }
        break;
      }
      
      messages.push({ role: 'system', content: source.content });
      usedTokens += source.maxTokens!;
    }
    
    return messages;
  }
  
  private truncate(source: ContextSource, maxTokens: number): string | null {
    const chars = maxTokens * 3;
    if (source.content.length <= chars) return source.content;
    return source.content.slice(0, chars) + '\n...[truncated]';
  }
}
```

### 4.3 Context Assembly

```typescript
// src/contextBuilder.ts (new)

export interface ContextBuildOptions {
  includeMemory: boolean;
  includeSkills: boolean;
  includePatterns: boolean;
  includePreferences: boolean;
  maxMemoryItems?: number;
}

export class ContextBuilder {
  private _registry: SourceRegistry;
  private _memory: MemorySystem;
  private _skillManager: SkillLifecycleManager;
  
  async build(
    userInput: string,
    session: AgentSession,
    options: ContextBuildOptions
  ): Promise<ChatMessage[]> {
    // 1. System prompt (highest priority)
    this.addSystemPrompt();
    
    // 2. Project knowledge
    if (options.includePreferences) {
      this.addProjectKnowledge();
    }
    
    // 3. User preferences
    this.addUserPreferences();
    
    // 4. RAG retrieval
    if (options.includeMemory) {
      await this.addMemoryRetrieval(userInput, options.maxMemoryItems ?? 5);
    }
    
    // 5. Active skills
    if (options.includeSkills) {
      this.addActiveSkills();
    }
    
    // 6. Conversation patterns
    if (options.includePatterns) {
      this.addRelevantPatterns(userInput);
    }
    
    return this._registry.assemble(this._budget);
  }
  
  private async addMemoryRetrieval(query: string, k: number): Promise<void> {
    const span = this.telemetry?.startSpan('memory.retrieve');
    
    try {
      const memories = await this._memory.retrieve(query, k);
      const content = memories
        .map((m, i) => `[Memory ${i + 1}] ${m.content}`)
        .join('\n\n');
      
      this._registry.register({
        name: 'memory',
        content,
        priority: 0.6,
        category: 'rag'
      });
      
      this.telemetry?.recordMemoryRetrieval(span!, memories.length, memories.map(m => m.score));
    } finally {
      span?.end();
    }
  }
}
```

---

## 5. Harness: RAG/Memory System

### 5.1 RAG Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     RAG System                                   │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │  Episodic    │    │   Semantic   │    │   Vector     │     │
│  │   Memory     │    │   Memory     │    │   Index      │     │
│  │              │    │              │    │              │     │
│  │ - Turn logs  │    │ - Insights   │    │ - Embeddings │     │
│  │ - Events     │    │ - Facts      │    │ - Cosine sim │     │
│  └──────────────┘    └──────────────┘    └──────────────┘     │
│           │                  │                   │              │
│           ▼                  ▼                   ▼              │
│  ┌────────────────────────────────────────────────────────┐     │
│  │              Hybrid Retrieval Engine                    │     │
│  │                                                          │     │
│  │  score = α·Recency + β·Importance + γ·Relevance        │     │
│  │                        + δ·EmbeddingSimilarity           │     │
│  │                                                          │     │
│  │  Fallback: keyword-only if no embeddings                 │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                    │
│                            ▼                                    │
│                   ┌──────────────┐                             │
│                   │  RAG Output  │                             │
│                   │  (top-k)     │                             │
│                   └──────────────┘                             │
└────────────────────────────────────────────────────────────────┘
```

### 5.2 Memory Interfaces (Enhanced)

```typescript
// src/memoryCore.ts (enhanced)

export interface MemoryEntry {
  id: string;
  type: 'episodic' | 'semantic';
  content: string;
  
  // Scoring
  importance: number;
  created_at: number;
  last_accessed: number;
  
  // Vector (optional)
  embedding?: number[];
  embeddingModel?: string;
  
  // Metadata
  tags?: string[];
  source?: 'user' | 'agent' | 'tool' | 'system';
  success?: boolean;
  
  // Patterns
  patternType?: 'tool_use' | 'turn' | 'error' | 'topic_shift';
  frequency?: number;
}

export interface MemoryRetrievalResult {
  content: string;
  score: number;
  entry: MemoryEntry;
  matchReason: 'recency' | 'importance' | 'keyword' | 'embedding';
}

export interface RetrievalConfig {
  alpha?: number;  // Recency (default: 0.25)
  beta?: number;   // Importance (default: 0.35)
  gamma?: number;  // Relevance keyword (default: 0.40)
  delta?: number;  // Embedding similarity (default: 0.0)
  maxAgeDays?: number;
  minImportance?: number;
}
```

### 5.3 Hybrid Retrieval Implementation

```typescript
// src/memoryCore.ts (enhanced retrieval)

export async function retrieve(
  query: string,
  k: number = 5,
  config: RetrievalConfig = {}
): Promise<MemoryRetrievalResult[]> {
  const {
    alpha = 0.25,
    beta = 0.35,
    gamma = 0.40,
    delta = 0.0,
    maxAgeDays = 90,
    minImportance = 0.0
  } = config;
  
  const entries = await loadMemories();
  if (!entries.length) return [];
  
  const now = Date.now() / 1000;
  
  // Get query embedding if delta > 0 and provider available
  let queryEmbedding: number[] | null = null;
  if (delta > 0 && embeddingProvider) {
    const embeddings = await embeddingProvider.embed([query]);
    queryEmbedding = embeddings[0];
  }
  
  const scored: { entry: MemoryEntry; score: number; reason: string }[] = [];
  
  for (const entry of entries) {
    // Age filter
    const age = (now - entry.created_at) / 86400;
    if (age > maxAgeDays && entry.importance < 0.7) continue;
    if (entry.importance < minImportance) continue;
    
    // Component scores
    const recencyScore = Math.pow(0.99, age);
    const importanceScore = entry.importance;
    const relevanceScore = keywordRelevance(query, entry.content);
    
    let embeddingScore = 0;
    let matchReason = 'keyword';
    
    if (queryEmbedding && entry.embedding && delta > 0) {
      embeddingScore = cosineSimilarity(queryEmbedding, entry.embedding);
      if (embeddingScore > relevanceScore) {
        matchReason = 'embedding';
      }
    }
    
    const totalScore = 
      alpha * recencyScore +
      beta * importanceScore +
      gamma * relevanceScore +
      delta * embeddingScore;
    
    scored.push({ entry, score: totalScore, reason: matchReason });
  }
  
  scored.sort((a, b) => b.score - a.score);
  
  return scored.slice(0, k).map(s => ({
    content: s.entry.content,
    score: s.score,
    entry: s.entry,
    matchReason: s.reason as MemoryRetrievalResult['matchReason']
  }));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## 6. Harness: Skills Management

### 6.1 Skill Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Skills System                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │ SkillStore  │    │   Skill     │    │   Skill     │        │
│  │  (File/     │◄──►│  Registry   │◄──►│  Loader     │        │
│  │   Remote)   │    │             │    │             │        │
│  └─────────────┘    └─────────────┘    └─────────────┘        │
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────┐      │
│  │              SkillLifecycleManager                    │      │
│  │                                                      │      │
│  │  - loadSkill(name)                                   │      │
│  │  - unloadSkill(name)                                 │      │
│  │  - autoTrigger(input) → Skill[]                      │      │
│  │  - resolveDependencies(name) → Skill[]                │      │
│  └─────────────────────────────────────────────────────┘      │
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────┐      │
│  │              Active Skill Context                    │      │
│  │                                                      │      │
│  │  - skill.body injected into system                   │      │
│  │  - skill.onLoad() hooks                             │      │
│  │  - skill resources (scripts, refs, assets)           │      │
│  └─────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Skill Definition (Enhanced)

```typescript
// src/types.ts (enhanced)

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  
  // Metadata
  version?: string;
  author?: string;
  tags?: string[];
  categories?: string[];
  
  // Examples for Few-shot
  examples?: SkillExample[];
  
  // Auto-trigger
  trigger?: string | RegExp;
  
  // Dependencies
  dependencies?: string[];
  provides?: string[];  // Capabilities this skill adds
  
  // Lifecycle hooks
  onLoad?: (ctx: SkillContext) => Promise<void>;
  onUnload?: (ctx: SkillContext) => void;
  
  // Resource paths
  path?: string;
  dir?: string;
}

export interface SkillExample {
  description: string;
  input: string;
  output: string;
}

export interface SkillContext {
  sessionId: string;
  history: ChatMessage[];
  sandbox: Sandbox;
}
```

### 6.3 Skill Registry

```typescript
// src/skillRegistry.ts (new)

import { SkillDefinition, SkillContext } from './types';

export class SkillRegistry {
  private _skills: Map<string, SkillDefinition> = new Map();
  private _byCategory: Map<string, Set<string>> = new Map();
  private _byTag: Map<string, Set<string>> = new Map();
  
  register(skill: SkillDefinition): void {
    if (this._skills.has(skill.name)) {
      throw new Error(`Skill ${skill.name} already registered`);
    }
    
    this._skills.set(skill.name, skill);
    
    // Index by category
    if (skill.categories) {
      for (const cat of skill.categories) {
        if (!this._byCategory.has(cat)) {
          this._byCategory.set(cat, new Set());
        }
        this._byCategory.get(cat)!.add(skill.name);
      }
    }
    
    // Index by tag
    if (skill.tags) {
      for (const tag of skill.tags) {
        if (!this._byTag.has(tag)) {
          this._byTag.set(tag, new Set());
        }
        this._byTag.get(tag)!.add(skill.name);
      }
    }
  }
  
  get(name: string): SkillDefinition | undefined {
    return this._skills.get(name);
  }
  
  list(): SkillDefinition[] {
    return Array.from(this._skills.values());
  }
  
  listByCategory(category: string): SkillDefinition[] {
    const names = this._byCategory.get(category);
    if (!names) return [];
    return names.map(n => this._skills.get(n)!).filter(Boolean);
  }
  
  listByTag(tag: string): SkillDefinition[] {
    const names = this._byTag.get(tag);
    if (!names) return [];
    return names.map(n => this._skills.get(n)!).filter(Boolean);
  }
  
  listCategories(): string[] {
    return Array.from(this._byCategory.keys());
  }
  
  // Resolve skill with dependency graph
  resolve(name: string, visited: Set<string> = new Set()): SkillDefinition[] {
    const skill = this._skills.get(name);
    if (!skill) return [];
    if (visited.has(name)) return [skill]; // Cycle detection
    
    visited.add(name);
    const result: SkillDefinition[] = [skill];
    
    if (skill.dependencies) {
      for (const dep of skill.dependencies) {
        result.push(...this.resolve(dep, visited));
      }
    }
    
    return result;
  }
  
  // Search skills
  search(query: string, limit: number = 10): SkillDefinition[] {
    const q = query.toLowerCase();
    const scored: [number, SkillDefinition][] = [];
    
    for (const skill of this._skills.values()) {
      let score = 0;
      
      if (skill.name.toLowerCase().includes(q)) score += 0.5;
      if (skill.description.toLowerCase().includes(q)) score += 0.3;
      if (skill.tags?.some(t => t.toLowerCase().includes(q))) score += 0.2;
      
      if (score > 0) scored.push([score, skill]);
    }
    
    return scored
      .sort((a, b) => b[0] - a[0])
      .slice(0, limit)
      .map(([, s]) => s);
  }
}
```

### 6.4 Skill Lifecycle Manager

```typescript
// src/skillLifecycle.ts (new)

export class SkillLifecycleManager {
  private _activeSkills: Set<string> = new Set();
  private _skillContexts: Map<string, SkillContext> = new Map();
  private _loadedContent: Map<string, string> = new Map();
  private _registry: SkillRegistry;
  private _telemetry?: Telemetry;
  
  constructor(registry: SkillRegistry, telemetry?: Telemetry) {
    this._registry = registry;
    this._telemetry = telemetry;
  }
  
  async loadSkill(name: string): Promise<SkillLoadResult> {
    const span = this._telemetry?.startSpan('skill.load');
    span?.setAttribute('skill.name', name);
    
    try {
      const skill = this._registry.get(name);
      if (!skill) {
        return { success: false, error: 'SKILL_NOT_FOUND', skillName: name };
      }
      
      // Resolve dependencies first
      const deps = this._registry.resolve(name);
      for (const dep of deps) {
        if (!this._activeSkills.has(dep.name) && dep.name !== name) {
          const depResult = await this.loadSkill(dep.name);
          if (!depResult.success) {
            return depResult;
          }
        }
      }
      
      // Execute onLoad hooks
      if (skill.onLoad) {
        const ctx = this.createContext(skill);
        try {
          await skill.onLoad(ctx);
          this._skillContexts.set(name, ctx);
        } catch (e: any) {
          return { 
            success: false, 
            error: 'SKILL_LOAD_FAILED', 
            skillName: name,
            reason: e.message 
          };
        }
      }
      
      this._activeSkills.add(name);
      this._loadedContent.set(name, skill.body);
      
      this._telemetry?.recordSkillLoad(name, true);
      
      return {
        success: true,
        skillName: name,
        content: skill.body,
        dependencies: deps.map(d => d.name)
      };
      
    } catch (e: any) {
      this._telemetry?.recordSkillLoad(name, false, e.message);
      return { success: false, error: 'SKILL_LOAD_FAILED', skillName: name, reason: e.message };
    } finally {
      span?.end();
    }
  }
  
  async unloadSkill(name: string): Promise<void> {
    const skill = this._registry.get(name);
    if (!skill) return;
    
    // Execute onUnload if present
    if (skill.onUnload) {
      const ctx = this._skillContexts.get(name);
      if (ctx) {
        try {
          skill.onUnload(ctx);
        } catch (e) {
          console.error(`skill.onUnload error for ${name}:`, e);
        }
      }
    }
    
    this._activeSkills.delete(name);
    this._skillContexts.delete(name);
    this._loadedContent.delete(name);
  }
  
  getLoadedContent(name: string): string | undefined {
    return this._loadedContent.get(name);
  }
  
  isLoaded(name: string): boolean {
    return this._activeSkills.has(name);
  }
  
  getActiveSkills(): string[] {
    return Array.from(this._activeSkills);
  }
  
  // Match triggers against input
  matchTriggers(input: string): SkillDefinition[] {
    const matched: SkillDefinition[] = [];
    
    for (const skill of this._registry.list()) {
      if (!skill.trigger) continue;
      
      if (typeof skill.trigger === 'string') {
        if (input.includes(skill.trigger)) matched.push(skill);
      } else if (skill.trigger instanceof RegExp) {
        if (skill.trigger.test(input)) matched.push(skill);
      }
    }
    
    return matched;
  }
  
  private createContext(skill: SkillDefinition): SkillContext {
    return {
      sessionId: '',  // Set by caller
      history: [],
      sandbox: new Sandbox()
    };
  }
}

export interface SkillLoadResult {
  success: boolean;
  skillName: string;
  content?: string;
  dependencies?: string[];
  error?: string;
  reason?: string;
}
```

### 6.5 Enhanced Skill Tool

```typescript
// Built-in skill tool (enhanced)

const SKILL_TOOL = {
  name: 'Skill',
  description: `Load a skill to gain specialized knowledge for a task.

Available skills:
${getSkillDescriptions()}

Categories: ${skillRegistry.listCategories().join(', ')}

Actions:
- load <name>: Load a skill into context
- unload <name>: Unload a skill from context
- list: List all available skills
- search <query>: Search skills by name/description
- info <name>: Show skill details`,
  
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['load', 'unload', 'list', 'search', 'info'],
        default: 'load'
      },
      skill: {
        type: 'string',
        description: 'Skill name or search query'
      }
    },
    required: ['skill']
  }
};

// Tool implementation
async function executeSkillTool(args: Record<string, any>): Promise<string> {
  const { action = 'load', skill } = args;
  const manager = getSkillLifecycleManager();
  
  switch (action) {
    case 'load': {
      if (manager.isLoaded(skill)) {
        return `Skill '${skill}' already loaded.`;
      }
      const result = await manager.loadSkill(skill);
      if (!result.success) {
        return `Failed to load '${skill}': ${result.error}`;
      }
      return `Loaded skill '${skill}'. ${result.content?.slice(0, 100)}...`;
    }
    
    case 'unload': {
      await manager.unloadSkill(skill);
      return `Unloaded skill '${skill}'.`;
    }
    
    case 'list': {
      const skills = skillRegistry.list();
      return skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
    }
    
    case 'search': {
      const results = skillRegistry.search(skill);
      if (!results.length) return `No skills found matching '${skill}'.`;
      return results.map(s => `- ${s.name}: ${s.description}`).join('\n');
    }
    
    case 'info': {
      const s = skillRegistry.get(skill);
      if (!s) return `Skill '${skill}' not found.`;
      return [
        `## ${s.name}`,
        s.description,
        `Version: ${s.version ?? '1.0.0'}`,
        `Tags: ${s.tags?.join(', ') ?? 'none'}`,
        `Categories: ${s.categories?.join(', ') ?? 'none'}`,
        s.dependencies?.length ? `Dependencies: ${s.dependencies.join(', ')}` : ''
      ].filter(Boolean).join('\n');
    }
  }
}
```

---

## 7. Harness: Observability & Tracing

### 7.1 Telemetry Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Telemetry System                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Spans      │    │   Logs       │    │   Metrics    │      │
│  │              │    │              │    │              │      │
│  │ - agent.turn │    │ - debug      │    │ - turn_count │      │
│  │ - llm.chat   │    │ - info       │    │ - token_use  │      │
│  │ - tools      │    │ - warn       │    │ - latency    │      │
│  │ - memory     │    │ - error      │    │ - errors     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│          │                  │                   │               │
│          ▼                  ▼                   ▼               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Exporters                             │    │
│  │                                                          │    │
│  │  ConsoleExporter  →  Development (human-readable)        │    │
│  │  OTLPSpanExporter →  Production (OpenTelemetry)         │    │
│  │  LangfuseExporter →  Evaluation (structured)             │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Telemetry Implementation

```typescript
// src/telemetry.ts (new)

import { 
  trace, 
  Span, 
  SpanStatusCode, 
  Tracer,
  context,
  propagation 
} from '@opentelemetry/api';

export interface TelemetryConfig {
  serviceName: string;
  exporter?: SpanExporter;
  samplingRatio?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class Telemetry {
  private tracer: Tracer;
  private spans: Map<string, Span> = new Map();
  private config: TelemetryConfig;
  
  constructor(config: TelemetryConfig) {
    this.config = config;
    
    // Initialize tracer
    this.tracer = trace.getTracer(config.serviceName, '1.0.0');
  }
  
  startSpan(name: string, parent?: Span): Span {
    const span = this.tracer.startSpan(name, {
      parent: parent,
      attributes: {
        'service.name': this.config.serviceName,
        'timestamp': Date.now()
      }
    });
    
    this.spans.set(span.id, span);
    return span;
  }
  
  endSpan(span: Span): void {
    span.end();
    this.spans.delete(span.id);
  }
  
  // GenAI Semantic Conventions
  recordChatCall(
    span: Span,
    model: string,
    usage: Record<string, number>,
    durationMs: number
  ): void {
    span.setAttributes({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': model,
      'gen_ai.usage.input_tokens': usage.input_tokens ?? 0,
      'gen_ai.usage.output_tokens': usage.output_tokens ?? 0,
      'gen_ai.usage.total_tokens': usage.total_tokens ?? 0,
      'llm.duration_ms': durationMs
    });
    span.setStatus({ code: SpanStatusCode.OK });
  }
  
  recordToolCall(
    span: Span,
    toolName: string,
    durationMs: number,
    success: boolean,
    error?: string
  ): void {
    span.setAttributes({
      'agent.tool.name': toolName,
      'agent.tool.duration_ms': durationMs,
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
    const avgScore = scores.length > 0 
      ? scores.reduce((a, b) => a + b, 0) / scores.length 
      : 0;
    
    span.setAttributes({
      'agent.memory.retrieved_count': count,
      'agent.memory.avg_score': avgScore,
      'agent.memory.max_score': scores.length > 0 ? Math.max(...scores) : 0
    });
  }
  
  recordSkillLoad(name: string, success: boolean, error?: string): void {
    const span = this.startSpan('skill.load');
    span.setAttribute('skill.name', name);
    span.setAttribute('skill.load_success', success);
    if (error) span.setAttribute('skill.load_error', error);
    span.setStatus({ code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
  }
}
```

### 7.3 Structured Logging

```typescript
// src/logging.ts (new)

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
  context?: Record<string, any>;
  traceId?: string;
  spanId?: string;
}

export class Logger {
  constructor(
    private module: string,
    private telemetry: Telemetry
  ) {}
  
  private log(level: LogEntry['level'], message: string, ctx?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      context: ctx,
      traceId: getCurrentTraceId(),
      spanId: getCurrentSpanId()
    };
    
    // Console output
    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
    
    // Export if configured
    this.telemetry.exportLog?.(entry);
  }
  
  debug(msg: string, ctx?: Record<string, any>): void { this.log('debug', msg, ctx); }
  info(msg: string, ctx?: Record<string, any>): void { this.log('info', msg, ctx); }
  warn(msg: string, ctx?: Record<string, any>): void { this.log('warn', msg, ctx); }
  error(msg: string, err?: Error, ctx?: Record<string, any>): void {
    this.log('error', msg, { ...ctx, error: err?.message, stack: err?.stack });
  }
  
  child(ctx: Record<string, any>): Logger {
    return new ChildLogger(this, ctx);
  }
}
```

### 7.4 Metrics Collection

```typescript
// src/metrics.ts (new)

export interface TurnMetrics {
  turnNumber: number;
  hadToolCalls: boolean;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  timestamp: number;
}

export interface ToolMetrics {
  name: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

export interface AgentMetrics {
  turnCount: number;
  turns: TurnMetrics[];
  toolMetrics: Map<string, ToolMetrics>;
  totalTokens: number;
  totalCost: number;
  errorCount: number;
  errorsByType: Record<string, number>;
}

export class MetricsCollector {
  private _turns: TurnMetrics[] = [];
  private _toolMetrics: Map<string, ToolMetrics> = new Map();
  private _errorCount = 0;
  private _errorsByType: Record<string, number> = {};
  
  recordTurn(turn: TurnMetrics): void {
    this._turns.push(turn);
  }
  
  recordToolCall(
    name: string,
    durationMs: number,
    success: boolean
  ): void {
    const existing = this._toolMetrics.get(name) ?? {
      name,
      callCount: 0,
      successCount: 0,
      failureCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0
    };
    
    existing.callCount++;
    existing.totalDurationMs += durationMs;
    existing.avgDurationMs = existing.totalDurationMs / existing.callCount;
    
    if (success) {
      existing.successCount++;
    } else {
      existing.failureCount++;
    }
    
    this._toolMetrics.set(name, existing);
  }
  
  recordError(type: string): void {
    this._errorCount++;
    this._errorsByType[type] = (this._errorsByType[type] ?? 0) + 1;
  }
  
  getMetrics(): AgentMetrics {
    return {
      turnCount: this._turns.length,
      turns: this._turns,
      toolMetrics: this._toolMetrics,
      totalTokens: this._turns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0),
      totalCost: 0,  // Computed from pricing
      errorCount: this._errorCount,
      errorsByType: this._errorsByType
    };
  }
  
  reset(): void {
    this._turns = [];
    this._toolMetrics.clear();
    this._errorCount = 0;
    this._errorsByType = {};
  }
}
```

---

## 8. Integration Architecture

### 8.1 Harness Composition

```typescript
// src/harness.ts (new)

export interface HarnessConfig {
  llm: LLMProvider;
  tools: ToolDefinition[];
  skills?: SkillDefinition[];
  memory?: MemoryConfig;
  sandbox?: SandboxConfig;
  telemetry?: TelemetryConfig;
  embeddingProvider?: EmbeddingProvider;
}

export class AgentHarness {
  readonly llm: LLMProvider;
  readonly toolRegistry: ToolRegistry;
  readonly toolExecutor: ToolExecutor;
  readonly skillRegistry: SkillRegistry;
  readonly skillManager: SkillLifecycleManager;
  readonly memorySystem: MemorySystem;
  readonly contextBuilder: ContextBuilder;
  readonly telemetry: Telemetry;
  readonly metrics: MetricsCollector;
  readonly sandbox: Sandbox;
  
  constructor(config: HarnessConfig) {
    // Core
    this.llm = config.llm;
    this.sandbox = new Sandbox(config.sandbox);
    
    // Observability
    this.telemetry = new Telemetry(config.telemetry ?? { serviceName: 'borderless-agent' });
    this.metrics = new MetricsCollector();
    
    // Tools
    this.toolRegistry = new ToolRegistry();
    for (const tool of config.tools) {
      this.toolRegistry.register(tool);
    }
    
    this.toolExecutor = new ToolExecutor({
      toolRegistry: this.toolRegistry,
      sandbox: this.sandbox,
      telemetry: this.telemetry
    });
    
    // Skills
    this.skillRegistry = new SkillRegistry();
    if (config.skills) {
      for (const skill of config.skills) {
        this.skillRegistry.register(skill);
      }
    }
    
    this.skillManager = new SkillLifecycleManager(
      this.skillRegistry,
      this.telemetry
    );
    
    // Memory/RAG
    this.memorySystem = new MemorySystem({
      embeddingProvider: config.embeddingProvider
    });
    
    // Context
    this.contextBuilder = new ContextBuilder({
      memory: this.memorySystem,
      skillManager: this.skillManager,
      telemetry: this.telemetry
    });
  }
  
  async executeTurn(
    input: string,
    session: AgentSession
  ): Promise<TurnResult> {
    const span = this.telemetry.startSpan('agent.turn');
    
    try {
      // 1. Check for skill triggers
      const triggeredSkills = this.skillManager.matchTriggers(input);
      for (const skill of triggeredSkills) {
        if (!this.skillManager.isLoaded(skill.name)) {
          await this.skillManager.loadSkill(skill.name);
        }
      }
      
      // 2. Build context
      const messages = await this.contextBuilder.build(input, session, {
        includeMemory: true,
        includeSkills: true,
        includePatterns: true
      });
      
      // 3. Execute turn
      const result = await this.executeLoop(messages, session);
      
      // 4. Record metrics
      this.metrics.recordTurn({
        turnNumber: result.turnNumber,
        hadToolCalls: result.hadToolCalls,
        toolCallCount: result.toolResults?.length ?? 0,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        durationMs: result.totalDurationMs,
        timestamp: Date.now()
      });
      
      return result;
    } finally {
      this.telemetry.endSpan(span);
    }
  }
}
```

---

## 9. File Structure

```
src/
  ├── errors.ts              # NEW: Typed errors
  ├── telemetry.ts           # NEW: OpenTelemetry + structured logging
  ├── metrics.ts            # NEW: Metrics collection
  ├── logging.ts            # NEW: Structured logger
  ├── skillRegistry.ts      # NEW: Skill registry
  ├── skillLifecycle.ts     # NEW: Skill lifecycle manager
  ├── toolExecutor.ts       # NEW: Enhanced tool execution
  ├── contextBuilder.ts     # NEW: Context assembly
  ├── sourceRegistry.ts     # NEW: Context source management
  ├── retry.ts              # NEW: Retry strategy
  ├── providers/
  │   └── embeddings.ts     # NEW: Embedding provider interface
  ├── memoryCore.ts         # MODIFIED: Vector embedding support
  ├── contextCore.ts        # MODIFIED: BudgetManager, SourceRegistry
  ├── skillsCore.ts        # MODIFIED: SkillRegistry integration
  ├── agentInstance.ts     # MODIFIED: Parallel execution, timeouts
  ├── agentBuilder.ts       # MODIFIED: New config options
  ├── types.ts              # MODIFIED: SkillDefinition enhancements
  └── index.ts              # MODIFIED: Export new types
```
