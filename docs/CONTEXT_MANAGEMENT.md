# 通用 Agent 上下文管理系统 — 技术文档

> 企业级上下文管理不是简单「把聊天记录拼到 Prompt 里」，而是一条包含**评估、筛选、压缩、组装**的完整流水线。本文档描述其架构与接口，作为实现与迭代的蓝图。

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Context Management Pipeline                       │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────────────┤
│ Data Source │ Lifecycle   │ Selection & │ Assembler   │ Caching Layer   │
│ Layer       │ Manager     │ Compression │             │                 │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────────┘
       │              │              │              │              │
       ▼              ▼              ▼              ▼              ▼
  原材料仓库      状态与预算      筛选+压缩      最终 Prompt    性能优化
```

---

## 2. 数据源层（The Source Layer）

数据源层是上下文的「原材料」仓库。不同来源的**优先级**和**生命周期**必须区分。

| 数据源 | 说明 | 优先级 | 生命周期 |
|--------|------|--------|----------|
| **System Prompt（元指令）** | 核心人设、最高指令、输出格式约束 | 最高，永不遗忘 | 固定，常驻 |
| **Short-term History（会话流）** | 当前 Session 的最近 N 轮对话 | 高 | 随会话滑动/压缩 |
| **Episodic Memory（相关记忆）** | 通过 RAG 从长期记忆库检索到的历史片段 | 中高 | 按查询动态注入 |
| **Scratchpad（思维草稿）** | CoT 中间推理、工具调用的原始 Observation | 中 | 可折叠/摘要后保留 |
| **User Input（当前指令）** | 用户刚刚发送的一句话 | 最高（当前轮） | 单轮 |

**设计要点：**

- 每个数据源应有明确**上限**（Token 或条数），便于预算控制。
- 来源需打标签（`source`），便于组装层做**位置工程**和**裁剪策略**。

---

## 3. 上下文生命周期管理器（Lifecycle Manager）

生命周期管理器是「指挥官」，负责上下文状态与配额。

### 3.1 Session ID 追踪

- **目的**：区分多用户、多任务、多会话。
- **能力**：
  - 为每个会话分配唯一 `session_id`。
  - 会话级隔离：A 的 history / memory 不混入 B。
  - 可选：会话元数据（创建时间、最后活跃、标签）用于归档与清理。

### 3.2 Token Budget Controller（预算控制）

- **总预算**：设定总 Token 上限（如 128k、1M），避免超窗。
- **动态配额分配**（建议比例，可配置）：

| 模块 | 占比 | 说明 |
|------|------|------|
| System Prompt | 固定 ~1k | 元指令，不随对话增长 |
| RAG / 长期记忆 | 动态 40% | 检索结果，按需注入 |
| 近期对话 | 动态 50% | 滑动窗口 + 摘要后的历史 |
| 预留生成空间 | 固定 10% | 留给模型输出，防止截断 |

- **行为**：
  - 实时或按轮估算各模块 Token 占用。
  - 若某模块超配，触发**压缩**或**裁剪**（见第 4 节）。

### 3.3 Topic Shift Detector（话题漂移检测）

- **目的**：识别用户意图是否发生剧烈变化（如从「写代码」跳到「订机票」）。
- **输入**：当前 User Input + 近期若干轮（或摘要）。
- **输出**：漂移分数或二分类（是否漂移）。
- **动作**：
  - **Context Reset**：清空当前会话窗口，仅保留 System + 当前输入。
  - **Context Archiving**：将旧话题打包成摘要或事件，写入长期记忆，再清空/重置窗口。

---

## 4. 上下文筛选与压缩层（Selection & Compression Engine）

解决「装不下」的核心算法层。

### 4.1 筛选策略（Selector）

| 策略 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **Sliding Window** | 保留最近 K 轮对话 | 实现简单、可预测 | 易丢失重要前文 |
| **Semantic Selection** | 用当前 User Input 与历史轮次做 Embedding 相似度，只保留相关轮 | 保留与当前问题相关的历史 | 依赖向量模型与阈值 |
| **Importance Scoring** | 对每条消息打分（如 MemGPT），重要则保留、不重要则丢弃 | 可保留久远但重要的指令 | 需要重要性模型或规则 |

**建议**：组合使用。例如「滑动窗口 + 重要性加分」：窗口内按时间保留，窗口外按重要性保留若干条；或「语义筛选 + 滑动窗口」：先语义筛，再在结果上做窗口截断。

### 4.2 压缩策略（Compressor）

| 策略 | 描述 | 适用场景 |
|------|------|----------|
| **Summarization** | 每 N 轮（如 10 轮）用小模型将前文概括为一段「前情提要」 | 长对话中段，用摘要替代原文 |
| **Token Pruning** | 使用 LLMLingua / Selective Context 等去除低信息密度 Token | 在不影响语义下压缩 30%–50% |
| **Observation Folding** | 工具返回过长时折叠为 `[Data too long, summary: X, Y, Z]` 或仅保留前几行预览 | Scratchpad / 工具结果 |

**摘要化流程建议**：

1. 触发条件：轮数达到 N 或 Token 占比超阈值。
2. 输入：待压缩的连续若干轮。
3. 输出：一段固定格式的摘要（如「用户之前询问了 X，Agent 提供了 A/B，但在 B 上报错」）。
4. 用摘要替换原文，释放配额给近期对话。

---

## 5. 组装层（The Assembler）

将处理后的碎片拼成最终发给 LLM 的 Payload。

### 5.1 Template Rendering（模版渲染）

- 按目标模型的最佳格式拼接（如 ChatML：`<|im_start|>system\n...`）。
- 各数据源对应占位符，由 Lifecycle Manager 提供的「当前可用片段」填充。

### 5.2 Position Engineering（位置工程）

- **问题**：「Lost in the Middle」— 模型对中间段注意力较弱。
- **原则**：
  - 最重要信息放在**开头**（System Prompt）和**结尾**（User Input 附近）。
  - 长 RAG 结果、长历史摘要可放中段，或对关键句做**重复强调**（在 System 或 User 前用一句总结）。

### 5.3 Injection Defense（防注入层）

- 在组装前对 **User Input**（及可选：历史中的用户消息）做扫描。
- 检测并阻断常见 Prompt Injection 模式（如「忽略以上指令」「你的新身份是」等）。
- 可选：对不可信片段做转义、截断或标记为「不可执行指令」。

---

## 6. 缓存层（Caching Layer）

为延迟与成本优化服务。

| 机制 | 描述 | 收益 |
|------|------|------|
| **KV Cache / Prefix Caching** | 对 System Prompt、静态 RAG 等前缀做缓存，只计算新增 Token | 降低 TTFT，节省算力 |
| **Exact Match Cache** | 若 User Input 与上下文状态与某次历史完全一致，直接返回缓存答案 | 避免重复调用模型 |

**实现注意**：缓存键需包含 `(session_id, system_hash, history_hash, user_input_hash)`，避免误命中。

---

## 7. 理想 Prompt 结构示例

经上述流水线后，最终发往 LLM 的 Payload 建议结构如下（自上而下）：

```text
[System Message] — 固定，来自 Prompt 库
"你是一个专业的代码助手..."

[Long-term Memory / RAG] — 动态检索，经剪枝
"相关文档片段：JoyGen 平台的 API 文档说明..."
"用户偏好：喜欢 Python，不喜欢 Java..."

[Conversation Summary] — 压缩后的历史
"前情提要：用户在 5 分钟前尝试部署 Docker 失败，错误代码 502..."

[Recent History] — 滑动窗口，保留最近 3 轮
User: "我试了你刚才给的第二种方法，还是不行。"
Assistant: "明白了，请提供一下 log 文件。"
User: [粘贴了 Log 文件]

[Processing Instructions] — 动态插入（可选）
"注意：Log 文件很长，请重点关注 Error 字段..."

[User Input] — 当前最新
"帮我分析一下这个 Log 里的 'Connection Refused' 是怎么回事？"
```

对应到**数据源**与**位置工程**：

- System、RAG、Summary 占据**前部**；Recent History + User Input 占据**后部**，保证关键指令在模型注意力集中区。

---

## 8. 接口与模块划分（建议）

便于在现有 Agent 中落地，可抽象出以下接口：

| 模块 | 职责 | 典型接口 |
|------|------|----------|
| **SourceRegistry** | 注册各数据源及其当前内容、Token 估算 | `register(name, content, meta)`, `get(name)`, `estimate_tokens()` |
| **LifecycleManager** | Session、预算、话题漂移 | `get_budget()`, `allocate()`, `detect_topic_shift()`, `reset_or_archive()` |
| **Selector** | 筛选历史 / 记忆 | `select(history, user_input, budget)` → 保留列表 |
| **Compressor** | 摘要、剪枝、折叠 | `summarize(rows)`, `prune(text, max_tokens)`, `fold_observation(raw)` |
| **Assembler** | 模版 + 位置 + 防注入 | `assemble(sources, template)`, `sanitize(user_input)` |
| **Cache** | 前缀缓存、应答缓存 | `get_cached_prefix()`, `get_cached_reply(key)` |

---

## 9. 与现有实现的对应关系

| 本文档概念 | 当前代码（参考） |
|------------|------------------|
| Short-term History | `main.ts` 的 `history` + `memoryCore.MAX_HISTORY_TURNS` 滑动窗口 |
| Episodic Memory | `memoryCore.retrieve()` 注入到 `loopCore` 的 system |
| Token Budget | 未实现，可增加 `ContextBudget` 与各源 `estimate_tokens()` |
| Topic Shift | 未实现，可增加轻量分类器或基于 embedding 的漂移检测 |
| Summarization | 未实现，可在超 N 轮时调用小模型做摘要并写入长期记忆 |
| Observation Folding | 未实现，可在工具返回处按长度做截断/摘要 |
| Assembler / 位置工程 | 当前为「system + messages」线性拼接，可改为上述分层结构 |
| Injection Defense | 未实现，可在 `main` 或 Assembler 前加一层扫描 |

本技术文档可作为后续迭代「上下文管理能力」的统一参考，与 [MEMORY_PRD.md](./MEMORY_PRD.md) 配合使用（长期记忆作为数据源之一接入本流水线）。
