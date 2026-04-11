# 渐进式披露（Progressive Disclosure）

本文档描述本程序中与**渐进式披露**相关的设计与实现：在合适时机、按需、分阶段地向模型或用户披露信息，以控制上下文规模、降低 token 消耗并保持响应质量。

---

## 概述

渐进式披露在本程序中的体现包括：

1. **技能按需加载**：技能内容仅在模型调用 Skill 工具时注入，启动时只加载元数据。
2. **文件分页读取**：大文件通过 offset/limit 分页披露，避免一次性塞满上下文。
3. **对话历史选择**：按 token 预算与轮数滑动窗口，只保留最近/在预算内的历史。
4. **系统组装（RAG + 摘要）**：系统提示由「基础说明 + 检索记忆 + 对话摘要」组成，而非完整历史。
5. **长期记忆检索**：只注入 top-k 条相关记忆，而非全部记忆。
6. **话题切换与归档**：检测到话题切换时，将当前历史压缩为摘要写入长期记忆，再清空/重置，只披露新话题上下文。
7. **对话摘要压缩**：每 N 轮将较早历史压缩为 `conversation_summary`，后续只披露摘要 + 近期消息。
8. **工具输出折叠**：长工具输出折叠为首尾摘要，避免大块原始内容一次性披露。

下文按模块与调用链说明各部分的实现位置与行为。

---

## 1. 技能按需加载（Skill）

**位置**：`skillsCore.ts`、`toolsCore.ts`（Skill 工具与 `runSkill`）

**行为**：

- 启动时 `SkillLoader.load_skills()` 只扫描并加载技能的**元数据**（name、description 等），不加载完整 body，保持初始上下文精简。
- 模型在需要某领域知识时，通过 **Skill** 工具显式请求（例如 `Skill(skill="pregnancy_nutrition")`）。
- 此时才从磁盘读取该技能的完整内容并注入对话（`SKILLS.get_skill_content(skill_name)`），实现「按需披露」。
- 同一轮中同一技能只加载一次（`LOADED_SKILLS`），避免重复注入。

**相关代码**：

- `skillsCore.ts`：`SkillLoader.loadSkills()` 注释中的 "Only loads metadata at startup - body is loaded on-demand"。
- `toolsCore.ts`：`runSkill()` 中调用 `SKILLS.getSkillContent(skillName)` 并返回 `<skill-loaded>` 包裹的完整内容。
- `main.ts`：每轮开始时 `LOADED_SKILLS.clear()`，新一轮可重新按需加载技能。

---

## 2. 文件分页读取（read_file）

**位置**：`toolsCore.ts` 中 `read_file` 工具与 `runRead()`

**行为**：

- 支持 **offset**（0-based 起始行）和 **limit**（本页最多行数），大文件按「页」披露。
- 按行流式读取，只取 `[offset, offset+limit)` 行，不将整个文件读入内存。
- 返回内容末尾附带 `[Lines x-y; use offset=z for next page]`，引导模型在需要时用下一页的 offset 继续披露。

**相关代码**：

- `toolsCore.ts`：`runRead(path, offset=0, limit=undefined)`，`READ_DEFAULT_LIMIT`、`READ_MAX_CHARS`，以及分页 footer 的生成。

---

## 3. 对话历史选择（select_history）

**位置**：`contextCore.ts` 中 `selectHistory()`，由 `main.ts` 在每轮前调用。

**行为**：

- 在启用上下文管理（`contextEnabled()`）时，不把完整历史交给模型，而是：
  - 先按**轮数**截断：只保留最近 `maxTurns` 轮（每轮约 user+assistant，即最多 `maxTurns*2` 条消息）。
  - 再按 **maxTokens**（来自 `getBudget(model=MODEL)["history"]`）从前面裁剪，直到估计 token 数不超过预算。
- 从而只向模型**披露**「最近且 within 预算」的那一段历史，更早的要么被丢弃，要么通过下面的「对话摘要」间接披露。

**相关代码**：

- `main.ts`：`history = selectHistory(history, userInput, { maxTokens: budget.history, maxTurns: MAX_HISTORY_TURNS })`。
- `contextCore.ts`：`selectHistory(history, userInput, maxTokens, maxTurns)` 的滑动窗口与按 token 从前往后 trim 的逻辑。

---

## 4. 系统组装（RAG + 对话摘要）

**位置**：`contextCore.ts` 中 `assembleSystem()`，`main.ts` 在每轮构造 `systemOverride` 时调用。

**行为**：

- 系统提示由多段**分层披露**组成：
  - **Base**：通用说明、技能列表、子代理列表等（`getBaseSystem()`）。
  - **RAG**：`retrieve(userInput, k=5)` 得到的 top-k 条长期记忆，以「Relevant past context」形式注入，且受 `budgetRag` 截断。
  - **Conversation summary**：较早轮次的压缩摘要（`lifecycle.getConversationSummary()`），而不是完整历史正文。
  - 可选的 **Processing note**。
- 模型看到的「过去」= 检索到的相关记忆 + 对话摘要 + 经 `select_history` 筛选的近期消息，形成渐进式披露。

**相关代码**：

- `main.ts`：`systemOverride = assembleSystem(getBaseSystem(), { ragLines: ..., conversationSummary: lifecycle.getConversationSummary(), budgetRag: budget.rag })`。
- `contextCore.ts`：`assembleSystem(baseSystem, ragLines, conversationSummary, processingInstruction, budgetRag)` 的拼接与 RAG/summary 长度限制。

---

## 5. 长期记忆检索（retrieve）

**位置**：`memoryCore.ts` 中 `retrieve()`，由 `main.ts` 在每轮调用。

**行为**：

- 只取与当前用户输入最相关的 **top-k**（默认 k=5）条记忆，按 score = α·Recency + β·Importance + γ·Relevance 排序后截断。
- 向模型披露的是「少量相关记忆」，而非全部记忆库，属于典型的按相关性渐进披露。

**相关代码**：

- `main.ts`：`memoryTuples = retrieve(userInput, k=5)`，`ragLines = memoryTuples.filter(m => m[0]).map(m => m[0])`。
- `memoryCore.ts`：`retrieve(query, k=5, ...)` 的打分、排序与 `scored.slice(0, k)`。

---

## 6. 话题切换与归档

**位置**：`main.ts` 中与 `LifecycleManager.detectTopicShift()` 配合的逻辑，`contextCore.ts` 中 `LifecycleManager`、`summarizeRounds()`。

**行为**：

- 当检测到用户意图明显变化（与最近若干条用户消息的关键词重叠很低）时：
  - 对当前历史调用 `summarizeRounds(history)` 得到摘要；
  - 将摘要写入长期记忆（`writeInsight(summary)`）；
  - 清空当前对话历史并 `lifecycle.resetSession()`。
- 之后模型只看到「新话题」下的新消息与新的 RAG 结果；旧话题的细节不再逐条披露，仅通过摘要进入长期记忆供日后检索。

**相关代码**：

- `main.ts`：`if (contextEnabled() && lifecycle.detectTopicShift(userInput, history.slice(-6)))` 分支内的 `summarizeRounds`、`writeInsight`、`history.length = 0`、`lifecycle.resetSession()`。
- `contextCore.ts`：`LifecycleManager.detectTopicShift()`、`resetSession()`，以及 `summarizeRounds()`。

---

## 7. 对话摘要压缩（conversation_summary）

**位置**：`contextCore.ts` 中 `summarizeRounds()`、`LifecycleManager.setConversationSummary/getConversationSummary`，`main.ts` 中每 10 轮更新摘要的逻辑。

**行为**：

- 当 `history.length >= 20`（约 10 轮）时，对「除最近 2 条外的历史」调用 `summarizeRounds(history.slice(0, -2))` 得到一段短文摘要；
- 将结果写入 `lifecycle.setConversationSummary(summary)`；
- 在后续轮次中，`assembleSystem(..., { conversationSummary: lifecycle.getConversationSummary(), ... })` 只向模型披露这段摘要（以及经 `selectHistory` 保留的近期消息），实现「旧对话压缩披露」。

**相关代码**：

- `main.ts`：`if (contextEnabled() && history.length >= 20)` 内 `summary = summarizeRounds(history.slice(0, -2))`、`lifecycle.setConversationSummary(summary)`。
- `contextCore.ts`：`summarizeRounds(rounds)`（当前为基于前若干条消息的占位实现），以及 `assembleSystem` 中的 `conversationSummary` 段（如 `summary.slice(0, 1500)`）。

---

## 8. 工具输出折叠（fold_observation）

**位置**：`contextCore.ts` 中 `foldObservation()`，`loopCore.ts` 在每轮工具返回后对输出做折叠。

**行为**：

- 当某次工具调用的返回内容长度超过 `OBSERVATION_MAX_CHARS`（默认 3500）时，不把完整内容交给下一轮模型；
- 改为生成一段摘要：总长度说明 + 前一段片段 + 后一段片段（`[Data too long (...) First part: ... Last part: ...]`），并截断到 `max_chars`；
- 模型先看到「摘要级」披露，若需细节可再通过分页读文件、grep 等工具继续索取。

**相关代码**：

- `loopCore.ts`：在 `executeTool` 得到 `output` 后，若 `contextEnabled()` 则 `output = foldObservation(output)`，再 append 到 messages。
- `contextCore.ts`：`foldObservation(raw, maxChars=OBSERVATION_MAX_CHARS)` 的实现与 `OBSERVATION_MAX_CHARS`。

---

## 9. 子任务通过 Task 披露结果

**位置**：`toolsCore.ts` 中 Task 工具与 `runTask()`。

**行为**：

- 主模型通过 **Task** 工具将子任务（description、prompt、agent_type）交给子代理执行；
- 主对话中**只披露**：子任务描述 + 子代理返回的**最终文本**（以及可选的部分进度打印）；
- 子代理内部的多轮工具调用与长中间输出不会全部塞进主对话，从而在主会话层面实现「只披露子任务结果」的渐进式披露。

**相关代码**：

- `toolsCore.ts`：`runTask(description, prompt, agentType)` 的循环与最终结果提取，主会话只收到这一段结果字符串。

---

## 小结

| 机制             | 模块/入口                     | 披露策略简述                           |
|------------------|------------------------------|----------------------------------------|
| 技能按需加载     | skillsCore, toolsCore Skill   | 仅在被请求时注入该技能完整内容         |
| 文件分页         | toolsCore read_file           | offset/limit 分页，按页披露             |
| 历史选择         | contextCore selectHistory     | 滑动窗口 + token 预算，只保留近期      |
| 系统组装         | contextCore assembleSystem    | Base + RAG(top-k) + 对话摘要           |
| 长期记忆         | memoryCore retrieve           | 只注入 top-k 条相关记忆                 |
| 话题切换归档     | main + LifecycleManager       | 旧话题压缩为摘要入记忆，清空历史       |
| 对话摘要压缩     | summarizeRounds + lifecycle   | 旧轮次→摘要，只披露摘要+近期           |
| 工具输出折叠     | contextCore foldObservation   | 超长输出→首尾摘要                      |
| 子任务结果       | toolsCore runTask             | 主对话只披露子任务描述与最终结果       |

以上各部分共同构成程序中的**渐进式披露**设计：在保证任务可完成的前提下，按需、分层、分阶段地向模型披露信息，以控制上下文大小与 token 使用。
