/**
 * agentBuilder.ts — Fluent builder for creating portable agent instances.
 *
 * Usage:
 * ```ts
 * const agent = new AgentBuilder()
 *   .setProvider('openai', { apiKey: 'sk-...', model: 'gpt-4o' })
 *   .setSystemPrompt('You are a helpful assistant.')
 *   .addTool({ name: 'greet', description: 'Say hi', execute: () => 'Hi!' })
 *   .build();
 * ```
 */

import { LLMProvider } from './llmProtocol';
import {
    ToolDefinition,
    SkillDefinition,
    AgentConfig,
    LLMConfig,
    StorageConfig,
} from './types';
import type { SandboxConfig } from './sandbox';
import type { EmbeddingProvider } from './providers/embeddings';
import type { ProviderName } from './providers/base';
import type { ModelPricing } from './pricing';
import { AgentInstance } from './agentInstance';

export class AgentBuilder {
    private _config: AgentConfig = {
        includeBuiltinTools: true,
        enableMemory: false,
        enableStreaming: false,
        enableContext: true,
        maxToolRounds: 20,
        tools: [],
        skills: [],
    };

    // ---- LLM ----

    /** Provide an LLM config (creates a provider automatically based on config.provider). */
    setLLM(config: LLMConfig): this {
        this._config.llmConfig = config;
        return this;
    }

    /** Provide a custom LLMProvider instance directly. */
    setLLMProvider(provider: LLMProvider): this {
        this._config.llm = provider;
        return this;
    }

    /**
     * Shorthand: select a provider by name and configure it.
     * All providers support baseUrl for API-compatible endpoints.
     *
     * @example
     * builder.setProvider('anthropic', { apiKey: 'sk-ant-...', model: 'claude-sonnet-4-20250514' })
     * builder.setProvider('openai', { apiKey: 'sk-...', baseUrl: 'https://my-proxy.com/v1' })
     * builder.setProvider('google', { apiKey: 'AIza...', model: 'gemini-2.0-flash' })
     */
    setProvider(provider: ProviderName, config: LLMConfig): this {
        this._config.llmConfig = { ...config, provider };
        return this;
    }

    // ---- System prompt ----

    /** Set the base system prompt the agent uses. */
    setSystemPrompt(prompt: string): this {
        this._config.systemPrompt = prompt;
        return this;
    }

    // ---- Tools ----

    /** Add a single user-defined tool. */
    addTool(tool: ToolDefinition): this {
        this._config.tools = this._config.tools ?? [];
        this._config.tools.push(tool);
        return this;
    }

    /** Add multiple user-defined tools at once. */
    addTools(tools: ToolDefinition[]): this {
        this._config.tools = this._config.tools ?? [];
        this._config.tools.push(...tools);
        return this;
    }

    /** Whether to include built-in tools (bash, read_file, etc.). Default: true. */
    setIncludeBuiltinTools(include: boolean): this {
        this._config.includeBuiltinTools = include;
        return this;
    }

    // ---- Skills ----

    /** Add a single skill. */
    addSkill(skill: SkillDefinition): this {
        this._config.skills = this._config.skills ?? [];
        this._config.skills.push(skill);
        return this;
    }

    /** Add multiple skills at once. */
    addSkills(skills: SkillDefinition[]): this {
        this._config.skills = this._config.skills ?? [];
        this._config.skills.push(...skills);
        return this;
    }

    // ---- Storage ----

    /** Configure storage backend. */
    setStorage(config: StorageConfig): this {
        this._config.storage = config;
        return this;
    }

    // ---- Feature toggles ----

    /** Enable long-term memory (episodic + semantic). */
    enableMemory(enable: boolean = true): this {
        this._config.enableMemory = enable;
        return this;
    }

    /** Enable streaming responses by default. */
    enableStreaming(enable: boolean = true): this {
        this._config.enableStreaming = enable;
        return this;
    }

    /** Enable context management (token budgeting, history trimming). */
    enableContext(enable: boolean = true): this {
        this._config.enableContext = enable;
        return this;
    }

    /** Max tool rounds per turn (safety limit). */
    setMaxToolRounds(max: number): this {
        this._config.maxToolRounds = Math.max(1, Math.min(max, 100));
        return this;
    }

    /** Set approval callback for mutating tools. */
    setApprovalCallback(
        cb: (toolName: string, args: Record<string, any>) => Promise<boolean> | boolean,
    ): this {
        this._config.approvalCallback = cb;
        return this;
    }

    /**
     * Set callback for human-in-the-loop interaction.
     * When the agent needs clarification or input from the user mid-task,
     * it calls the `ask_user` tool which invokes this callback.
     */
    setHumanInputCallback(
        cb: (question: string) => Promise<string> | string,
    ): this {
        this._config.humanInputCallback = cb;
        return this;
    }

    // ---- Embeddings (optional) ----

    /**
     * Set an embedding provider for vector-based memory retrieval.
     * This is entirely optional — without it, memory uses keyword-based scoring.
     */
    setEmbeddingProvider(provider: EmbeddingProvider): this {
        this._config.embeddingProvider = provider;
        return this;
    }

    // ---- Pricing ----

    /**
     * Override model pricing for cost estimation.
     */
    setModelPricing(pricing: Record<string, ModelPricing>): this {
        const { setModelPricing } = require('./pricing');
        setModelPricing(pricing);
        return this;
    }

    // ---- MCP ----

    /** Add an MCP server to connect to when the agent is built. */
    addMCPServer(config: import('./mcpClient').MCPServerConfig): this {
        this._config.mcpServers = this._config.mcpServers ?? [];
        this._config.mcpServers.push(config);
        return this;
    }

    /** Add multiple MCP servers at once. */
    addMCPServers(configs: import('./mcpClient').MCPServerConfig[]): this {
        this._config.mcpServers = this._config.mcpServers ?? [];
        this._config.mcpServers.push(...configs);
        return this;
    }

    // ---- Sandbox ----

    /** Configure the execution sandbox (file guards, command filtering, resource limits). */
    setSandbox(config: SandboxConfig): this {
        this._config.sandbox = config;
        return this;
    }

    // ---- Build ----

    /** Validate config and build the agent instance. */
    build(): AgentInstance {
        // Resolve LLM provider
        if (!this._config.llm) {
            const cfg = this._config.llmConfig;
            if (!cfg?.apiKey) {
                throw new Error(
                    'AgentBuilder: must call .setLLM({ apiKey }), .setProvider(), or .setLLMProvider() before .build()',
                );
            }
            this._config.llm = this._createProvider(cfg);
        }

        return new AgentInstance({ ...this._config });
    }

    // ---- Private ----

    private _createProvider(cfg: LLMConfig): LLMProvider {
        const provider = cfg.provider ?? 'openai';

        switch (provider) {
            case 'openai': {
                const { OpenAIProvider } = require('./providers/openai');
                return new OpenAIProvider({
                    apiKey: cfg.apiKey,
                    model: cfg.model ?? 'gpt-4o',
                    baseUrl: cfg.baseUrl,
                    timeout: cfg.timeout ?? 120,
                });
            }
            case 'anthropic': {
                const { AnthropicProvider } = require('./providers/anthropic');
                return new AnthropicProvider({
                    apiKey: cfg.apiKey,
                    model: cfg.model ?? 'claude-sonnet-4-20250514',
                    baseUrl: cfg.baseUrl,
                    timeout: cfg.timeout ?? 120,
                });
            }
            case 'google': {
                const { GoogleProvider } = require('./providers/google');
                return new GoogleProvider({
                    apiKey: cfg.apiKey,
                    model: cfg.model ?? 'gemini-2.0-flash',
                    baseUrl: cfg.baseUrl,
                });
            }
            default:
                throw new Error(`Unknown provider: ${provider}. Use 'openai', 'anthropic', or 'google'.`);
        }
    }
}
