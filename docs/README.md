# Architecture Documentation Index

**Project:** borderless_agent  
**Date:** 2026-04-12

---

## Core Architecture Documents

### [ARCHITECTURE_IMPROVEMENT_PLAN.md](./ARCHITECTURE_IMPROVEMENT_PLAN.md)
**Start here.** Executive summary of all improvements, gap analysis vs claude-code-rev-main, and prioritized recommendations.

**Key sections:**
- Current architecture overview
- Gap analysis
- Agent loop enhancements
- Context management improvements
- Skills management
- RAG/Memory enhancements
- Observability & tracing
- Error taxonomy
- Implementation priority matrix

### [AGENT_LOOP_AND_HARNESS.md](./AGENT_LOOP_AND_HARNESS.md)
**The comprehensive design document.** Detailed specifications for:
- Enhanced agent loop flow
- Tool executor with parallel execution
- Context management (budget, sources, RAG)
- Skills system (registry, lifecycle, triggers)
- RAG/Memory with vector embeddings
- Observability & tracing (telemetry, logging, metrics)

### [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md)
**Execution plan.** Phased implementation with:
- 7 phases from Foundation → Multi-Agent
- Per-phase deliverables and checklists
- Testing strategy
- Risk mitigation
- Success metrics

---

## Existing Documentation

### Original Docs
- [IMPROVEMENT_SUGGESTIONS.md](./IMPROVEMENT_SUGGESTIONS.md) - Prioritized improvement list (reference)
- [PROGRESSIVE_DISCLOSURE.md](./PROGRESSIVE_DISCLOSURE.md) - UI/UX patterns
- [UNIVERSAL_AGENT_REFACTORING.md](./UNIVERSAL_AGENT_REFACTORING.md) - Refactoring notes
- [CONTEXT_MANAGEMENT.md](./CONTEXT_MANAGEMENT.md) - Context system details
- [MEMORY_PRD.md](./MEMORY_PRD.md) - Memory system PRD

### Deprecated
- `AGENT_LOOP_DESIGN.md` - Superseded by `AGENT_LOOP_AND_HARNESS.md`
- `HARNESS_DESIGN.md` - Superseded by `AGENT_LOOP_AND_HARNESS.md`

---

## Document Relationships

```
ARCHITECTURE_IMPROVEMENT_PLAN.md
    │
    ├──► Executive Summary
    ├──► Gap Analysis
    ├──► Recommendations (loop, context, skills, RAG, observability)
    │
    ▼
AGENT_LOOP_AND_HARNESS.md
    │
    ├──► Agent Loop Flow
    ├──► ToolExecutor
    ├──► Context (BudgetManager, SourceRegistry)
    ├──► Skills (Registry, Lifecycle, Triggers)
    ├──► RAG/Memory (Hybrid Retrieval)
    └──► Observability (Telemetry, Logging, Metrics)
    │
    ▼
IMPLEMENTATION_ROADMAP.md
    │
    ├──► Phase 0: Foundation (Errors, Retry)
    ├──► Phase 1: Reliability (Timeouts, Parallel Exec)
    ├──► Phase 2: Skills Management
    ├──► Phase 3: RAG/Memory Enhancement
    ├──► Phase 4: Observability
    ├──► Phase 5: Context Management
    └──► Phase 6: Multi-Agent
```

---

## Quick Reference

### Priority Order for Implementation
1. **Phase 0**: Errors + Retry (Foundation)
2. **Phase 1**: Timeouts + Parallel Exec (Reliability)
3. **Phase 2**: Skills Management
4. **Phase 3**: RAG with Vector Embeddings
5. **Phase 4**: Observability & Tracing
6. **Phase 5**: Context Management
7. **Phase 6**: Multi-Agent

### Key Files to Create/Modify

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `src/errors.ts`, `src/retry.ts` | - |
| 1 | - | `src/types.ts`, `src/agentInstance.ts` |
| 2 | `src/skillRegistry.ts`, `src/skillLifecycle.ts` | `src/types.ts`, `src/agentBuilder.ts` |
| 3 | `src/providers/embeddings.ts` | `src/memoryCore.ts` |
| 4 | `src/telemetry.ts`, `src/logging.ts`, `src/metrics.ts` | All core files |
| 5 | `src/sourceRegistry.ts`, `src/contextBuilder.ts` | `src/contextCore.ts` |
| 6 | `src/orchestrator.ts` | - |

### Features by Category

**Agent Loop:**
- Parallel tool execution
- Per-tool timeouts with AbortController
- Streaming with tool status

**Context Management:**
- BudgetManager for token allocation
- SourceRegistry for priority-based assembly
- Conversation summarization

**Skills System:**
- SkillRegistry with categories/tags
- SkillLifecycleManager with load/unload
- Trigger-based auto-loading
- Dependency resolution

**RAG/Memory:**
- Vector embeddings (OpenAI, Ollama)
- Hybrid retrieval scoring
- Cosine similarity

**Observability:**
- OpenTelemetry spans
- Structured JSON logging
- Metrics collection
- GenAI semantic conventions

**Safety:**
- Typed errors
- Retry with circuit breaker
- Guardrails middleware
