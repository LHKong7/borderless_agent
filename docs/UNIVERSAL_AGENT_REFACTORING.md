# 通用 Agent 改造建议书

> 基于当前代码库的深度分析,提出将现有专用Agent框架改造为通用Agent平台的具体建议与实施路线图。

---

## 执行摘要

当前代码库已经实现了一个**功能完整的Agent框架**,具备多Agent类型、工具系统、技能管理、长期记忆和上下文管理等核心能力。但作为**通用Agent平台**,仍存在以下改进空间:

### 核心优势
- ✅ 清晰的模块化架构(核心层、存储层、接口层分离)
- ✅ 完善的上下文管理和记忆系统
- ✅ 灵活的技能(Skill)加载机制
- ✅ 支持多种Agent类型(Explorer/Executor/Code/Plan)
- ✅ 渐进式披露设计,有效控制Token消耗

### 改进机会
- 🔧 **硬编码依赖过多** - OpenAI SDK、文件系统、特定工具耦合严重
- 🔧 **扩展性受限** - 新增工具/技能/Agent类型需要修改核心代码
- 🔧 **模型绑定单一** - 仅支持OpenAI,缺乏多模型适配能力
- 🔧 **配置管理静态** - 运行时动态调整能力不足
- 🔧 **缺乏插件生态** - 第三方扩展接入困难

---

## 一、架构层面的通用化改造

### 1.1 引入抽象层,解耦核心依赖

**问题**: 当前代码直接依赖OpenAI SDK和具体实现,导致切换模型或添加新能力困难。

**建议**: 采用**依赖注入 + 协议抽象**模式。

```
┌─────────────────────────────────────────────┐
│          Agent Application Layer            │
│  (skills, tasks, todos, domain logic)       │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│         Core Abstraction Layer              │
│  - LLMProvider Protocol                      │
│  - ToolRegistry Protocol                    │
│  - StorageBackend Protocol                  │
│  - MemoryStore Protocol                     │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│       Implementation Adapters               │
│  - OpenAI / Anthropic / Local LLM           │
│  - File / Cloud / Database Storage          │
│  - Vector / Graph Memory Stores             │
└─────────────────────────────────────────────┘
```

**具体实施**:

#### A. LLM Provider 抽象

```python
# llm_protocol.py
from typing import List, Dict, Any, Optional, Iterator
from dataclasses import dataclass

@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str | List[Dict[str, Any]]

@dataclass
class ToolCall:
    id: str
    name: str
    arguments: Dict[str, Any]

@dataclass
class LLMResponse:
    content: str | None
    tool_calls: List[ToolCall]
    usage: Dict[str, int]  # {prompt_tokens, completion_tokens}
    model: str

class LLMProvider(Protocol):
    """通用大模型提供者接口"""

    @property
    def context_window_size(self) -> int: ...

    @property
    def supports_streaming(self) -> bool: ...

    def chat(
        self,
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        stream: bool = False,
    ) -> LLMResponse | Iterator[LLMResponse]: ...

    def count_tokens(self, messages: List[Message]) -> int: ...

# 实现示例
class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "gpt-4"):
        self.client = OpenAI(api_key=api_key)
        self.model = model

    @property
    def context_window_size(self) -> int:
        return 128000  # 根据model动态返回

    def chat(self, messages, tools=None, **kwargs):
        # OpenAI具体实现
        ...

# 其他实现
class AnthropicProvider(LLMProvider): ...
class LocalLLMProvider(LLMProvider): ...  # vLLM/Ollama
```

**收益**:
- ✅ 无缝切换模型提供商
- ✅ 统一接口简化测试
- ✅ 支持本地/私有部署模型

#### B. Tool Registry 抽象

```python
# tool_protocol.py
from typing import Callable, Any, Dict, List

@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema
    handler: Callable
    permission_level: str = "normal"  # "safe" | "normal" | "dangerous"
    is_mutating: bool = False

class ToolRegistry(Protocol):
    """工具注册表接口"""

    def register(self, tool: ToolDefinition) -> None: ...

    def unregister(self, name: str) -> None: ...

    def get(self, name: str) -> Optional[ToolDefinition]: ...

    def list_tools(self, agent_type: str) -> List[ToolDefinition]: ...

    def execute(
        self,
        name: str,
        arguments: Dict[str, Any],
        context: Dict[str, Any]
    ) -> Any: ...

class DynamicToolRegistry(ToolRegistry):
    """支持运行时动态注册的工具注册表"""

    def __init__(self):
        self._tools: Dict[str, ToolDefinition] = {}
        self._agent_permissions: Dict[str, List[str]] = {}

    def register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool

    def configure_agent_permissions(
        self,
        agent_type: str,
        allowed_tools: List[str]
    ) -> None:
        """配置特定Agent类型可用的工具"""
        self._agent_permissions[agent_type] = allowed_tools
```

**收益**:
- ✅ 第三方可通过API注册自定义工具
- ✅ 细粒度权限控制
- ✅ 工具可独立版本管理和更新

---

### 1.2 配置系统动态化

**问题**: 当前配置主要依赖环境变量和硬编码,运行时调整困难。

**建议**: 实现分层配置系统,支持运行时热更新。

```python
# config_manager.py
from typing import Any, Dict, Optional
import yaml
import threading

class ConfigManager:
    """分层配置管理器: 默认 < 文件 < 环境 < 运行时"""

    def __init__(self):
        self._configs: Dict[str, Any] = {}
        self._lock = threading.RLock()
        self._watchers: List[Callable] = []

    def load_from_file(self, path: str) -> None:
        """从YAML/JSON文件加载配置"""
        with open(path) as f:
            self._configs.update(yaml.safe_load(f))
        self._notify_watchers()

    def load_from_dict(self, config: Dict[str, Any]) -> None:
        """运行时动态更新配置"""
        with self._lock:
            self._configs = {**self._configs, **config}
        self._notify_watchers()

    def get(self, key: str, default: Any = None) -> Any:
        """支持点分隔路径: llm.temperature"""
        keys = key.split(".")
        value = self._configs
        for k in keys:
            if isinstance(value, dict):
                value = value.get(k)
            else:
                return default
        return value if value is not None else default

    def watch(self, callback: Callable[[str, Any, Any], None]) -> None:
        """监听配置变更"""
        self._watchers.append(callback)

    def _notify_watchers(self) -> None:
        for watcher in self._watchers:
            watcher(self._configs)

# 使用示例
config = ConfigManager()
config.load_from_file("config.yaml")

# 运行时动态调整
config.load_from_dict({
    "llm": {"temperature": 0.5},
    "context": {"max_history_turns": 20}
})

# 监听变更
def on_config_change(new_config):
    logger.info(f"Config updated: {new_config}")

config.watch(on_config_change)
```

**配置文件示例** (`config.yaml`):

```yaml
# LLM配置
llm:
  provider: "openai"  # openai | anthropic | local
  model: "gpt-4"
  temperature: 0.7
  max_tokens: 4096
  fallback_models: ["gpt-3.5-turbo"]

# Agent配置
agents:
  default_type: "code"
  custom_types:
    data_analyst:
      tools: ["read_file", "bash", "plot_data", "run_sql"]
      prompt: "You are a data analyst..."
    security_reviewer:
      tools: ["read_file", "grep", "scan_vulnerabilities"]
      prompt: "You are a security expert..."

# 工具配置
tools:
  bash:
    enabled: true
    timeout: 30
    allowed_commands: ["git", "ls", "cat"]
  write_file:
    enabled: true
    require_approval: true
    backup_dir: ".backup"

# 存储配置
storage:
  backend: "file"  # file | s3 | database
  session_dir: "./data/sessions"
  memory_dir: "./data/memories"
```

---

### 1.3 插件系统设计

**问题**: 当前新增技能/工具需要修改核心代码,缺乏扩展性。

**建议**: 实现**插件系统**,支持第三方扩展。

```python
# plugin_manager.py
from typing import Dict, List, Type
import importlib
import inspect
from pathlib import Path

class Plugin:
    """插件基类"""

    @property
    def name(self) -> str:
        raise NotImplementedError

    @property
    def version(self) -> str:
        return "1.0.0"

    def initialize(self, context: Dict[str, Any]) -> None:
        """插件初始化钩子"""
        pass

    def register_tools(self, registry: ToolRegistry) -> None:
        """注册工具"""
        pass

    def register_agents(self, registry: AgentRegistry) -> None:
        """注册Agent类型"""
        pass

    def register_skills(self, loader: SkillLoader) -> None:
        """注册技能"""
        pass

    def shutdown(self) -> None:
        """清理资源"""
        pass


class PluginManager:
    """插件管理器"""

    def __init__(self, registry: ToolRegistry):
        self._registry = registry
        self._plugins: Dict[str, Plugin] = {}
        self._hooks: Dict[str, List[Callable]] = {
            "on_tool_execute": [],
            "on_agent_start": [],
            "on_memory_write": [],
        }

    def load_plugin(self, plugin_path: str) -> None:
        """从Python模块加载插件"""
        module = importlib.import_module(plugin_path)

        # 查找Plugin子类
        for name, obj in inspect.getmembers(module, inspect.isclass):
            if issubclass(obj, Plugin) and obj != Plugin:
                plugin = obj()
                plugin.initialize({"registry": self._registry})
                plugin.register_tools(self._registry)
                self._plugins[plugin.name] = plugin
                logger.info(f"Loaded plugin: {plugin.name} v{plugin.version}")

    def load_plugins_from_dir(self, dir_path: str) -> None:
        """扫描目录加载所有插件"""
        for path in Path(dir_path).glob("*.py"):
            self.load_plugin(f"plugins.{path.stem}")

    def register_hook(self, event: str, callback: Callable) -> None:
        """注册事件钩子"""
        if event in self._hooks:
            self._hooks[event].append(callback)

    def trigger_hook(self, event: str, **kwargs) -> None:
        """触发事件钩子"""
        for callback in self._hooks.get(event, []):
            callback(**kwargs)

# 插件示例
class DatabasePlugin(Plugin):
    """数据库操作插件"""

    @property
    def name(self) -> str:
        return "database"

    def register_tools(self, registry: ToolRegistry) -> None:
        registry.register(ToolDefinition(
            name="run_sql",
            description="Execute SQL queries on configured databases",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "database": {"type": "string"},
                },
                "required": ["query"],
            },
            handler=self._execute_sql,
            permission_level="normal",
        ))

    def _execute_sql(self, query: str, database: str = "default"):
        # 实际SQL执行逻辑
        return f"Executed: {query}"
```

**插件目录结构**:

```
plugins/
├── __init__.py
├── database_plugin.py
├── web_scraper_plugin.py
├── api_tools_plugin.py
└── README.md
```

---

## 二、核心能力增强

### 2.1 多模态能力扩展

**问题**: 当前主要处理文本,缺乏对图像、音频等其他模态的原生支持。

**建议**: 扩展工具和消息格式支持多模态。

```python
# multimodal.py
from typing import List, Union
from dataclasses import dataclass
from enum import Enum

class MediaType(Enum):
    TEXT = "text"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    FILE = "file"

@dataclass
class MediaContent:
    type: MediaType
    data: Union[str, bytes]
    metadata: Dict[str, Any] = None

class MultimodalMessage(Message):
    """支持多模态的消息"""

    def __init__(
        self,
        role: str,
        content: Union[str, List[MediaContent]],
    ):
        if isinstance(content, str):
            content = [MediaContent(type=MediaType.TEXT, data=content)]
        super().__init__(role=role, content=content)

# 新增多模态工具
MULTIMODAL_TOOLS = [
    ToolDefinition(
        name="analyze_image",
        description="Analyze image content using vision model",
        handler=analyze_image_with_vision,
    ),
    ToolDefinition(
        name="transcribe_audio",
        description="Transcribe audio to text",
        handler=transcribe_audio,
    ),
    ToolDefinition(
        name="generate_image",
        description="Generate image from text description",
        handler=generate_image_with_dalle,
    ),
]
```

---

### 2.2 工作流引擎

**问题**: 当前只能通过Tool Call线性执行,缺乏复杂工作流支持。

**建议**: 实现工作流编排引擎。

```python
# workflow_engine.py
from typing import Dict, Any, List
from dataclasses import dataclass
from enum import Enum

class StepStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"

@dataclass
class WorkflowStep:
    id: str
    name: str
    tool_name: str
    parameters: Dict[str, Any]
    dependencies: List[str] = None  # 依赖的step ID
    condition: str = None  # 条件表达式

@dataclass
class Workflow:
    id: str
    name: str
    description: str
    steps: List[WorkflowStep]
    inputs: Dict[str, Any] = None

class WorkflowEngine:
    """工作流执行引擎"""

    def __init__(self, tool_registry: ToolRegistry):
        self._registry = tool_registry
        self._contexts: Dict[str, Dict[str, Any]] = {}

    def execute(self, workflow: Workflow) -> Dict[str, Any]:
        """执行工作流"""
        results = {}
        context = {**(workflow.inputs or {})}

        # 拓扑排序确定执行顺序
        sorted_steps = self._topological_sort(workflow.steps)

        for step in sorted_steps:
            # 检查条件
            if step.condition and not self._evaluate_condition(step.condition, context):
                results[step.id] = {"status": StepStatus.SKIPPED}
                continue

            # 检查依赖
            if not self._check_dependencies(step, results):
                results[step.id] = {"status": StepStatus.FAILED, "error": "Dependencies failed"}
                continue

            # 执行步骤
            try:
                result = self._execute_step(step, context)
                results[step.id] = {
                    "status": StepStatus.COMPLETED,
                    "result": result
                }
                context[step.id] = result
            except Exception as e:
                results[step.id] = {
                    "status": StepStatus.FAILED,
                    "error": str(e)
                }

        return results

    def _execute_step(self, step: WorkflowStep, context: Dict[str, Any]) -> Any:
        """执行单个步骤"""
        tool = self._registry.get(step.tool_name)
        if not tool:
            raise ValueError(f"Tool not found: {step.tool_name}")

        # 解析参数(支持引用前面的步骤结果)
        params = self._resolve_parameters(step.parameters, context)
        return tool.handler(**params)

    def _topological_sort(self, steps: List[WorkflowStep]) -> List[WorkflowStep]:
        """拓扑排序"""
        # 实现Kahn算法
        ...

# 工作流示例
code_review_workflow = Workflow(
    id="code_review",
    name="Code Review Workflow",
    description="Automated code review pipeline",
    steps=[
        WorkflowStep(
            id="scan_security",
            name="Security Scan",
            tool_name="scan_vulnerabilities",
            parameters={"path": "${repo_path}"}
        ),
        WorkflowStep(
            id="check_style",
            name="Style Check",
            tool_name="run_linter",
            parameters={"path": "${repo_path}"},
            dependencies=["scan_security"]
        ),
        WorkflowStep(
            id="run_tests",
            name="Run Tests",
            tool_name="bash",
            parameters={"command": "pytest tests/"},
            dependencies=["check_style"]
        ),
    ]
)
```

---

### 2.3 反思与学习机制

**问题**: 当前Agent缺乏从经验中学习的能力。

**建议**: 实现**反思循环**,自动提炼和沉淀知识。

```python
# reflection_core.py
from typing import List, Dict, Any

class ReflectionEngine:
    """反思引擎 - 从经验中学习"""

    def __init__(self, memory_store, llm_provider):
        self.memory = memory_store
        self.llm = llm_provider

    async def reflect_on_episode(
        self,
        task: str,
        actions: List[Dict[str, Any]],
        outcomes: List[Dict[str, Any]],
        final_result: Any
    ) -> None:
        """对一个完整任务进行反思"""

        # 1. 生成反思prompt
        reflection_prompt = self._build_reflection_prompt(
            task, actions, outcomes, final_result
        )

        # 2. 调用LLM进行反思
        response = await self.llm.chat([
            Message(role="system", content=self._get_reflection_system_prompt()),
            Message(role="user", content=reflection_prompt)
        ])

        # 3. 解析反思结果
        insights = self._parse_reflections(response.content)

        # 4. 写入长期记忆
        for insight in insights:
            await self.memory.write_insight(
                content=insight["lesson"],
                importance=insight["importance"],
                tags=insight["tags"],
                source="reflection"
            )

    def _build_reflection_prompt(self, task, actions, outcomes, result) -> str:
        return f"""Analyze this completed task and extract learnings:

Task: {task}

Actions Taken:
{self._format_actions(actions)}

Outcomes:
{self._format_outcomes(outcomes)}

Final Result:
{result}

Please extract:
1. What worked well (successful patterns)
2. What didn't work (failures and their causes)
3. Generalizable lessons (rules of thumb)
4. New knowledge gained

Output as JSON with keys: successes, failures, lessons, knowledge."""

    async def reflect_on_error(
        self,
        task: str,
        error: Exception,
        context: Dict[str, Any]
    ) -> str:
        """对错误进行反思,生成修复建议"""

        prompt = f"""Analyze this error and suggest fixes:

Task: {task}
Error: {error}
Context: {context}

What went wrong and how should it be fixed?"""

        response = await self.llm.chat([
            Message(role="system", content="You are an expert debugger."),
            Message(role="user", content=prompt)
        ])

        # 将修复建议写入记忆
        fix_suggestion = response.content
        await self.memory.write_insight(
            content=f"Fix for '{task}': {fix_suggestion}",
            importance="high",
            tags=["error_fix", task],
            source="error_reflection"
        )

        return fix_suggestion
```

---

## 三、可观测性增强

### 3.1 结构化日志与指标

**问题**: 当前日志主要为文本格式,难以分析和监控。

**建议**: 实现结构化日志和指标采集。

```python
# observability.py
from typing import Dict, Any
import time
import json
from dataclasses import dataclass, asdict

@dataclass
class TraceEvent:
    timestamp: float
    event_type: str  # "tool_call" | "agent_start" | "memory_write"
    session_id: str
    data: Dict[str, Any]

class ObservabilityManager:
    """可观测性管理器"""

    def __init__(self):
        self._events: List[TraceEvent] = []
        self._metrics: Dict[str, Any] = {}
        self._hooks: Dict[str, List[Callable]] = {}

    def log_event(self, event_type: str, session_id: str, data: Dict[str, Any]) -> None:
        """记录事件"""
        event = TraceEvent(
            timestamp=time.time(),
            event_type=event_type,
            session_id=session_id,
            data=data
        )
        self._events.append(event)

        # 触发钩子
        for hook in self._hooks.get(event_type, []):
            hook(event)

    def log_metric(self, name: str, value: float, tags: Dict[str, str] = None) -> None:
        """记录指标"""
        if name not in self._metrics:
            self._metrics[name] = []
        self._metrics[name].append({
            "value": value,
            "timestamp": time.time(),
            "tags": tags or {}
        })

    def register_hook(self, event_type: str, callback: Callable) -> None:
        """注册事件监听器"""
        if event_type not in self._hooks:
            self._hooks[event_type] = []
        self._hooks[event_type].append(callback)

    def export_traces(self) -> List[Dict[str, Any]]:
        """导出追踪数据"""
        return [asdict(e) for e in self._events]

    def export_metrics(self) -> Dict[str, Any]:
        """导出指标数据"""
        return self._metrics

# 使用示例
obs = ObservabilityManager()

# 监控工具调用
obs.register_hook("tool_call", lambda event: {
    print(f"Tool {event.data['tool']} took {event.data['duration']}s")
})

# 监控Token使用
obs.register_hook("llm_call", lambda event: {
    obs.log_metric("llm.tokens.prompt", event.data["prompt_tokens"])
    obs.log_metric("llm.tokens.completion", event.data["completion_tokens"])
})
```

---

### 3.2 调试与可视化界面

**问题**: 缺乏可视化的调试工具,难以理解Agent行为。

**建议**: 构建Web UI或CLI调试器。

```python
# debugger.py
from typing import Dict, Any, List

class AgentDebugger:
    """Agent调试器"""

    def __init__(self, observability: ObservabilityManager):
        self.obs = observability
        self.breakpoints: Dict[str, Any] = {}

    def set_breakpoint(
        self,
        condition: str,  # "tool_name == 'write_file'"
        action: str = "pause"  # "pause" | "inspect" | "log"
    ) -> None:
        """设置断点"""
        self.breakpoints[condition] = action

    def inspect_state(self, session_id: str) -> Dict[str, Any]:
        """检查会话状态"""
        events = [e for e in self.obs.export_traces() if e.session_id == session_id]
        return {
            "events": events,
            "tools_called": self._analyze_tool_usage(events),
            "token_usage": self._calculate_token_usage(events),
            "timeline": self._build_timeline(events),
        }

    def visualize_execution(self, session_id: str) -> str:
        """可视化执行流程(Mermaid图表)"""
        events = [e for e in self.obs.export_traces() if e.session_id == session_id]

        mermaid = ["graph TD"]
        for i, event in enumerate(events):
            node_id = f"n{i}"
            label = f"{event.event_type}\\n{event.data.get('tool', '')}"
            mermaid.append(f"{node_id}[{label}]")

            if i > 0:
                mermaid.append(f"n{i-1} --> {node_id}")

        return "\\n".join(mermaid)
```

---

## 四、性能与可扩展性

### 4.1 异步执行优化

**问题**: 当前为同步模型,并发性能有限。

**建议**: 全面改为异步架构。

```python
# async_execution.py
import asyncio
from typing import List, Dict, Any, Optional

class AsyncToolExecutor:
    """异步工具执行器"""

    def __init__(self, max_concurrent: int = 10):
        self.semaphore = asyncio.Semaphore(max_concurrent)

    async def execute_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        timeout: float = 30.0
    ) -> Any:
        """异步执行工具"""
        async with self.semaphore:
            tool = self._registry.get(tool_name)

            # 在线程池中执行同步工具
            loop = asyncio.get_event_loop()
            return await asyncio.wait_for(
                loop.run_in_executor(None, tool.handler, **arguments),
                timeout=timeout
            )

    async def execute_tools_parallel(
        self,
        tools: List[Dict[str, Any]]
    ) -> List[Any]:
        """并行执行多个工具"""
        tasks = [
            self.execute_tool(t["name"], t["args"])
            for t in tools
        ]
        return await asyncio.gather(*tasks, return_exceptions=True)

class AsyncLLMProvider(LLMProvider):
    """异步LLM提供者"""

    async def chat_async(
        self,
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """异步聊天"""
        # 使用OpenAI异步客户端
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.api_key)

        response = await client.chat.completions.create(
            model=self.model,
            messages=self._convert_messages(messages),
            tools=tools,
            **kwargs
        )

        return self._parse_response(response)
```

---

### 4.2 缓存策略优化

**问题**: 缺乏语义缓存,重复查询浪费Token。

**建议**: 实现多级缓存系统。

```python
# cache_manager.py
from typing import List, Dict, Any, Optional
import hashlib
import json

class CacheKey:
    """缓存键生成器"""

    @staticmethod
    def for_llm_call(
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.7
    ) -> str:
        """为LLM调用生成缓存键"""
        payload = {
            "messages": [(m.role, str(m.content)) for m in messages],
            "tools": tools,
            "temperature": temperature
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    @staticmethod
    def for_tool_call(tool_name: str, arguments: Dict[str, Any]) -> str:
        """为工具调用生成缓存键"""
        payload = {"tool": tool_name, "args": arguments}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

class SemanticCache:
    """语义缓存 - 基于向量相似度"""

    def __init__(self, embedding_model, similarity_threshold: float = 0.95):
        self.model = embedding_model
        self.threshold = similarity_threshold
        self._cache: Dict[str, Any] = {}

    async def get(
        self,
        query: str,
        messages: List[Message]
    ) -> Optional[str]:
        """查找语义相似的缓存"""
        query_embedding = await self.model.embed(query)

        for key, value in self._cache.items():
            similarity = self._cosine_similarity(query_embedding, value["embedding"])
            if similarity >= self.threshold:
                return value["response"]

        return None

    async def set(self, query: str, response: str) -> None:
        """存储缓存"""
        embedding = await self.model.embed(query)
        cache_key = CacheKey.for_llm_call([Message(role="user", content=query)])

        self._cache[cache_key] = {
            "response": response,
            "embedding": embedding
        }

class MultiLevelCache:
    """多级缓存: L1(内存) -> L2(Redis) -> L3(语义)"""

    def __init__(self):
        self.l1 = {}  # 内存缓存
        self.l2 = None  # Redis客户端(可选)
        self.l3 = SemanticCache(embedding_model)

    async def get(self, key: str) -> Optional[Any]:
        """L1 -> L2 -> L3查找"""
        # L1
        if key in self.l1:
            return self.l1[key]

        # L2
        if self.l2:
            value = await self.l2.get(key)
            if value:
                self.l1[key] = value
                return value

        return None

    async def set(self, key: str, value: Any, ttl: int = 3600) -> None:
        """写入所有级别"""
        self.l1[key] = value

        if self.l2:
            await self.l2.set(key, value, ex=ttl)
```

---

## 五、实施路线图

### Phase 1: 基础抽象 (2-3周)
**目标**: 解耦核心依赖,建立抽象层

- [ ] 实现`LLMProvider`协议及OpenAI/Anthropic适配器
- [ ] 实现`ToolRegistry`协议,重构现有工具注册
- [ ] 实现`StorageBackend`协议统一存储接口
- [ ] 编写单元测试确保抽象层正确性

**交付物**:
- `llm_protocol.py`, `tool_protocol.py`, `storage_protocol.py`
- OpenAI/Anthropic双适配器实现
- 完整的单元测试套件

---

### Phase 2: 配置与插件 (2-3周)
**目标**: 实现动态配置和插件系统

- [ ] 实现`ConfigManager`支持YAML配置和热更新
- [ ] 实现`PluginManager`和插件加载机制
- [ ] 重构现有技能系统为插件
- [ ] 编写插件开发文档

**交付物**:
- `config_manager.py`, `plugin_manager.py`
- 3个示例插件(Database, WebScraper, API)
- `plugins/README.md`开发指南

---

### Phase 3: 能力增强 (3-4周)
**目标**: 多模态、工作流、反思机制

- [ ] 扩展消息格式支持多模态内容
- [ ] 实现`WorkflowEngine`支持复杂任务编排
- [ ] 实现`ReflectionEngine`自动学习机制
- [ ] 集成到主循环

**交付物**:
- `multimodal.py`, `workflow_engine.py`, `reflection_core.py`
- 多模态工具示例(图像分析、音频转写)
- 工作流示例(代码审查流程)

---

### Phase 4: 可观测性 (2周)
**目标**: 完善监控、调试、可视化

- [ ] 实现`ObservabilityManager`结构化日志
- [ ] 实现`AgentDebugger`调试工具
- [ ] 构建Web UI展示执行流程和指标
- [ ] 集成Prometheus/Grafana指标导出

**交付物**:
- `observability.py`, `debugger.py`
- Web Dashboard (`web_ui/`)
- 监控指标定义文档

---

### Phase 5: 性能优化 (2-3周)
**目标**: 异步化、缓存、并发优化

- [ ] 全面改为异步架构(`async`/`await`)
- [ ] 实现多级缓存系统(精确+语义)
- [ ] 实现并行工具执行
- [ ] 性能基准测试和优化

**交付物**:
- `async_execution.py`, `cache_manager.py`
- 性能测试报告
- 优化前后对比数据

---

### Phase 6: 生态建设 (持续)
**目标**: 文档、示例、社区

- [ ] 编写完整的API文档
- [ ] 创建示例项目库
- [ ] 开发CLI工具快速初始化项目
- [ ] 建立贡献指南和Issue模板

**交付物**:
- `docs/`完整文档
- `examples/`示例集合
- `agent-cli`命令行工具

---

## 六、兼容性保证

为确保平滑迁移,建议采用**渐进式重构**策略:

### 双轨运行期
- 保留旧API,标记为`@deprecated`
- 新旧实现并行运行,交叉验证结果
- 提供迁移工具和指南

### API兼容层
```python
# compatibility.py
class LegacyAPI:
    """兼容旧版本的API包装器"""

    def __init__(self, new_system):
        self._new = new_system

    def old_method(self, *args, **kwargs):
        # 转换为新API调用
        return self._new.new_equivalent(*args, **kwargs)

# 使用示例
legacy = LegacyAPI(new_system)
# 旧代码无需修改
legacy.old_method()
```

---

## 七、关键指标

改造成功的关键衡量指标:

| 指标 | 当前 | 目标 |
|------|------|------|
| **切换LLM提供商** | 需修改核心代码 | 配置文件修改即可 |
| **新增工具** | 修改`tools_core.py` | 独立插件,零侵入 |
| **新增Agent类型** | 修改`agents_core.py` | YAML配置即可 |
| **Token利用率** | ~60% (重复查询) | ~85% (语义缓存) |
| **并发处理能力** | 单线程 | 10+ 并发任务 |
| **启动时间** | ~500ms | <100ms (延迟加载) |
| **测试覆盖率** | ~40% | >80% |

---

## 八、风险评估与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **重构引入Bug** | 高 | 完整单元测试+双轨验证 |
| **性能下降** | 中 | 基准测试+性能预算 |
| **API破坏性变更** | 中 | 兼容层+迁移工具 |
| **过度设计** | 低 | MVP优先+迭代开发 |
| **社区接受度** | 低 | 文档+示例+快速响应 |

---

## 九、总结

本改造方案旨在将当前**专用Agent框架**升级为**通用Agent平台**,通过以下核心改进:

1. **抽象层解耦** - 支持多模型、多存储后端
2. **插件生态** - 第三方扩展零侵入接入
3. **动态配置** - 运行时热更新无需重启
4. **能力增强** - 多模态、工作流、自学习
5. **可观测性** - 完善的监控和调试工具
6. **性能优化** - 异步化、缓存、并发执行

通过**6个Phase、14-18周**的渐进式改造,最终实现:
- ✅ 高度可扩展的架构
- ✅ 丰富的插件生态
- ✅ 生产级的可观测性
- ✅ 优秀的性能表现
- ✅ 平滑的迁移路径

这将为项目的长期发展奠定坚实基础,支持更广泛的应用场景和更大的社区贡献。
