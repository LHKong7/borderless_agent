# 通用 Agent 记忆系统 PRD（初版）

> 目标：为当前 Agent 框架设计一个可扩展的通用记忆系统，为后续工程实现提供统一蓝图。

---

## 1. 记忆的宏观架构（Cognitive Architecture）

受人类认知科学启发，将 Agent 记忆划分为三层：

### 1.1 感官记忆（Sensory Memory）——“缓冲区”

- **定义**：对原始输入（文本、图像、音频、系统日志）的瞬时缓冲。
- **作用**：过滤噪音，只保留对后续推理有价值的特征。
  - 不需要记住每一帧画面或每一个标点，而是提取特征（Feature Extraction）传递给短期记忆。

> 实现提示：在当前代码中可以对应为对原始对话 / 日志的预处理层，暂不做持久化。

### 1.2 短期记忆（Short-term / Working Memory）——“上下文窗口”

- **定义**：当前正在进行的任务上下文，通常直接对应 LLM 的 Context Window。
- **内容**：
  - 当前对话历史
  - 正在执行的思维链（Chain of Thought）
  - 临时变量 / 中间结论
- **痛点**：上下文窗口有限（即使是 128k / 1M 也是有限的）。
- **解法**：
  - **滑动窗口（Sliding Window）**：保留最近 N 轮对话，丢弃远古记录。
  - **摘要（Summarization）**：将较旧的信息压缩为摘要，并写入长期记忆。

> 实现提示：与当前 `history` / `messages` 结构直接相关，可在 Agent Loop 中增加“窗口裁剪 +摘要写入长期记忆”的逻辑。

### 1.3 长期记忆（Long-term Memory）——“外挂硬盘”

长期记忆是通用 Agent 的核心，通常细分为两类：

- **情景记忆（Episodic Memory）**
  - 对过去具体事件的记录：
    - 例：`用户上周二叫我帮他订过那家意大利餐厅`
- **语义记忆（Semantic Memory）**
  - 对世界/用户的抽象知识与偏好：
    - 例：`用户不喜欢吃辣`，`Python 是一种编程语言`

> 实现提示：需要独立的存储层（向量库 / 数据库），并通过检索接口与 Agent Loop 解耦。

---

## 2. 记忆的运作机制（Mechanism）

仅有存储空间不够，关键在于“如何读写”，包含四个动态过程：

### 2.1 记忆写入（Encoding & Consolidation）

Agent 不应只“原样存日志”，而要具备**反思（Reflection）**能力。

- **直接存储**：保存原始交互日志（Raw Data）
- **提炼存储**：
  - 在任务结束或若干步后，Agent 自我提问：
    - “这段经历学到了什么？”
  - 将“我刚才运行报错了”转化为“工具 X 需要参数 Y”的经验规则，写入长期记忆。

> 实现提示：可以在 `agent_loop` 结束时触发一个“反思工具 / 子 Agent”，生成结构化经验写入 Memory Store。

### 2.2 记忆检索（Retrieval）

当 Agent 面临新任务时，需要从海量记忆中高效捞出相关信息。

参考斯坦福 Generative Agents 中的检索三要素：

- **相关性（Relevance）**：当前任务与记忆向量的余弦相似度（Vector Similarity）
- **新近性（Recency）**：越近期的记忆权重越高（可用指数衰减）
- **重要性（Importance）**：区分琐事与大事

检索打分可建模为：

\[
\text{Retrieval Score} = \alpha \cdot \text{Recency} + \beta \cdot \text{Importance} + \gamma \cdot \text{Relevance}
\]

> 实现提示：Memory Store 的检索接口需要返回 `(记忆内容, recency, importance, similarity)` 等字段，由上层打分/排序。

### 2.3 记忆遗忘（Forgetting）

通用 Agent 不能只进不出，否则噪音累积、检索变慢。

- **TTL（Time To Live）**：对低价值记忆设置过期时间，定期清理。
- **FIFO / LRU**：借鉴缓存策略，优先淘汰最旧或最少使用的记忆。

> 实现提示：定期后台 Job / 维护任务，对 Memory Store 做清理。

---

## 3. 数据结构与技术实现（Technical Stack）

在工程层面，推荐采用**混合数据库**架构：

| 记忆类型       | 技术实现                              | 存储内容示例                      |
|----------------|---------------------------------------|-----------------------------------|
| 非结构化记忆   | Vector DB (Pinecone, Milvus, Chroma) | 文本 Embeddings，对话记录、文档片段、经验 |
| 结构化记忆     | SQL / NoSQL (Postgres, MongoDB)      | 用户画像、配置表、偏好           |
| 关联记忆       | 图数据库 (Neo4j, NebulaGraph)        | 实体关系图谱 (User)-(LIKES)->(Coffee) |

### 3.1 非结构化记忆（向量库）

- 存：对话片段、技能使用结果、错误与修复的摘要。
- 查：通过向量相似度 + 重要性，检索最相关的若干条经验。

### 3.2 结构化记忆（用户画像 / 配置）

- 例：`User_ID: 101, Preference: Dark_Mode, Role: Admin`
- 用于：
  - 提供上下文个性化（偏好、身份）
  - 提醒 Agent 遵守用户的长期设定（如“默认用中文回答”）。

### 3.3 关联记忆（知识图谱）

- 用途：
  - 建模人物 / 物品 /事件之间的关系
  - 可以表达逻辑关系：
    - `(A)-[IS_FATHER_OF]->(B)` 和 `(B)-[IS_FATHER_OF]->(C)` 推出 `(A)-[IS_GRANDFATHER_OF]->(C)`

> 特别说明：知识图谱能弥补纯向量检索无法处理的符号逻辑推理，是高级记忆系统的关键组件之一。

---

## 4. 高级形态：程序性记忆（Procedural Memory）

程序性记忆是区分“初级 Agent”和“高级 Agent”的关键。

- **定义**：关于“如何做某事”的记忆。
- **表现**：
  - Agent 在多次失败/成功后，沉淀出“正确的调用模版”或“可靠的操作流程”：
    - 如：调用某 Python 工具的标准代码片段
    - 某类问题的标准解题步骤
- **进化路径**：
  - 第一次：试错 + 反思 → 成功方案写入程序性记忆
  - 下次同类任务：直接调用“肌肉记忆”（Plan / Snippet），而非从零推理

> 实现提示：可以将程序性记忆单独抽象为 “Playbook / Recipe Store”，并在规划阶段优先检索。

---

## 5. 总结：理想 Agent Memory 的画像

一个理想的 Agent 记忆系统，应当像一个**具有自我整理能力的图书管理员**，具备：

- **持久性（Persistent）**：记忆可跨重启持久保存。
- **动态性（Dynamic）**：能根据新信息不断修正旧认知（Update），而不是只 Append。
- **分层性（Hierarchical）**：既能回放原始细节（Raw），也有多层级摘要（Summary）。
- **无限性（Infinite Context）**：
  - 通过 RAG（检索增强生成）+ 摘要 + 程序性记忆，让 Agent 在“有限上下文”的约束下，表现得像拥有“无限记忆”。

---

## 6. 后续工程任务（待实现）

1. ~~设计 Memory Store 接口（抽象层）~~ → 已实现 `memoryCore.ts`：
   - `write_event(...)` / `write_insight(...)`（情景 / 语义）
   - `retrieve(query, k)`（α·Recency + β·Importance + γ·Relevance，本地 JSON + 关键词相关性）
   - `garbage_collect(max_items, max_age_days)`
2. ~~在 Agent Loop 中接入写入与检索钩子~~ → 已接入：
   - 每次新用户输入前：`retrieve(user_input, k=5)` 注入系统提示
   - 每轮结束后：`consolidate_turn(user_msg, assistant_summary)` 写入情景记忆
3. 短期记忆：已实现滑动窗口（`MAX_HISTORY_TURNS`，保留最近 N 轮对话）。
4. 待做：向量检索（可插拔 Embedding + 向量库）、反思子 Agent 生成语义记忆、程序性记忆（Playbook）、单元测试。

