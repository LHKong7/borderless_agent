/**
 * loopCore.ts - Main agent loop and system prompt (LLM provider abstraction).
 *
 * Integrates long-term memory: optional retrieved_memories injected into system prompt,
 * and returns last assistant text for consolidation.
 */

import { WORKDIR, streamEnabled, defaultLlmProvider, logger, slog } from './config';
import { LLMProvider, LLMResponse, ToolCall, ChatMessage } from './llmProtocol';
import { SKILLS } from './skillsCore';
import { getAgentDescriptions } from './agentsCore';
import { ALL_TOOLS, MAX_TOOL_ROUNDS, executeToolAsync } from './toolsCore';
import { foldObservation, contextEnabled, computeUsageStats } from './contextCore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolsToOpenAI(tools: Record<string, any>[]): Record<string, any>[] {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description ?? '',
            parameters: t.input_schema ?? { type: 'object', properties: {} },
        },
    }));
}

function messagesToOpenAI(
    messages: Record<string, any>[],
): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    for (const m of messages) {
        const role = m.role;
        const content = m.content;
        if (
            role === 'user' &&
            Array.isArray(content) &&
            content.length > 0 &&
            content[0]?.type === 'tool_result'
        ) {
            for (const r of content) {
                out.push({
                    role: 'tool',
                    tool_call_id: r.tool_call_id ?? '',
                    content: r.content ?? '',
                });
            }
            continue;
        }
        out.push({ ...m });
    }
    return out;
}

function lastAssistantText(messages: Record<string, any>[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;
        const content = msg.content;
        if (typeof content === 'string') return content.trim();
        if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block === 'object' && block?.type === 'text') {
                    return (block.text ?? '').trim();
                }
            }
        }
    }
    return '';
}

interface ToolCallMsg {
    id: string;
    function: { name: string; arguments: string };
}

function toolCallsToMsgShape(toolCalls: ToolCall[]): ToolCallMsg[] {
    return toolCalls.map((tc) => ({
        id: tc.id,
        function: {
            name: tc.name,
            arguments: tc.arguments ? JSON.stringify(tc.arguments) : '{}',
        },
    }));
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function getBaseSystem(): string {
    return `You are a general-purpose assistant. Your workspace is ${WORKDIR}.

You can help with many kinds of tasks: answering questions, searching and reading files, writing or editing content, running commands, and using specialized knowledge via skills and subagents.

**Skills** (invoke with Skill tool when the task matches a domain):
${SKILLS.getDescriptions()}

**Subagents** (invoke with Task tool for focused subtasks—e.g. exploration vs. execution):
${getAgentDescriptions()}

Rules:
- Use Skill at most ONCE per request; after loading a skill, answer using that knowledge and do not call Skill again.
- Use Task when a subtask fits an Explorer (read-only) or Executor (write/run, with approval) agent.
- Use TodoWrite to track multi-step work.
- Prefer using tools when they help; otherwise respond clearly in natural language.
- Be concise and helpful. If you take actions, briefly say what you did.`;
}

function buildSystem(retrievedMemories?: string[]): string {
    let base = getBaseSystem();
    if (retrievedMemories?.length) {
        const memoryBlock =
            '**Relevant past context (long-term memory):**\n' +
            retrievedMemories.map((m) => `- ${m}`).join('\n');
        base = base + '\n\n' + memoryBlock;
    }
    return base;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function agentLoop(options: {
    messages: Record<string, any>[];
    retrievedMemories?: string[];
    systemOverride?: string;
    budget?: Record<string, number>;
    sessionId?: string;
    onContentDelta?: (chunk: string) => void;
    llm?: LLMProvider;
}): Promise<{
    messages: Record<string, any>[];
    lastAssistantText: string;
    hadToolCalls: boolean;
}> {
    const llm = options.llm ?? defaultLlmProvider;
    const loopStart = Date.now();
    let toolRounds = 0;
    let hadToolCalls = false;
    let totalToolCount = 0;
    const system = options.systemOverride ?? buildSystem(options.retrievedMemories);
    const openaiTools = toolsToOpenAI(ALL_TOOLS);
    const messages = options.messages;
    const apiMessages: Record<string, any>[] = [
        { role: 'system', content: system },
        ...messagesToOpenAI(messages),
    ];

    const sidTag = options.sessionId?.slice(0, 8) ?? '-';
    slog.debug(`agent_loop start session=${sidTag} rounds_limit=${MAX_TOOL_ROUNDS}`);

    while (true) {
        const reqStart = Date.now();
        const useStream =
            (streamEnabled() || options.onContentDelta != null) &&
            llm.supportsStreaming;

        let msgContent = '';
        let msgToolCalls: ToolCallMsg[] = [];
        let usage: Record<string, number> = {};

        if (useStream) {
            const stream = llm.chat(apiMessages, {
                tools: openaiTools,
                maxTokens: 8000,
                stream: true,
            }) as AsyncGenerator<LLMResponse>;

            let lastResponse: LLMResponse | null = null;
            for await (const r of stream) {
                if (r.content && options.onContentDelta) {
                    options.onContentDelta(r.content);
                } else if (r.content && streamEnabled()) {
                    process.stdout.write(r.content);
                }
                lastResponse = r;
            }
            if (lastResponse?.content && streamEnabled() && !options.onContentDelta) {
                process.stdout.write('\n');
            }
            msgContent = lastResponse?.content ?? '';
            const tcs = lastResponse?.toolCalls ?? [];
            msgToolCalls = tcs.length ? toolCallsToMsgShape(tcs) : [];
            usage = lastResponse?.usage ?? {};
            const reqMs = Date.now() - reqStart;
            slog.debug(`api_call session=${sidTag} duration_ms=${reqMs} (stream)`);
        } else {
            const response = (await llm.chat(apiMessages, {
                tools: openaiTools,
                maxTokens: 8000,
                stream: false,
            })) as LLMResponse;
            const reqMs = Date.now() - reqStart;
            slog.debug(`api_call session=${sidTag} duration_ms=${reqMs}`);
            msgContent = response.content ?? '';
            msgToolCalls = response.toolCalls?.length
                ? toolCallsToMsgShape(response.toolCalls)
                : [];
            usage = response.usage ?? {};
        }

        // Token usage
        if (usage && (usage.input_tokens || usage.output_tokens)) {
            const inp =
                (usage.input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0);
            const out = usage.output_tokens ?? 0;
            if (options.budget?.total) {
                const stats = computeUsageStats(usage, options.budget.total);
                if (stats.used != null) {
                    logger.info(`  [Tokens: in ${inp} out ${out} (${stats.used}% of budget)]`);
                } else {
                    logger.info(`  [Tokens: in ${inp} out ${out}]`);
                }
            } else {
                logger.info(`  [Tokens: in ${inp} out ${out}]`);
            }
        }

        if (msgContent && !streamEnabled()) {
            console.log(msgContent);
        }

        if (!msgToolCalls.length) {
            messages.push({ role: 'assistant', content: (msgContent ?? '').trim() });
            const totalMs = Date.now() - loopStart;
            slog.debug(
                `agent_loop end session=${sidTag} duration_ms=${totalMs} rounds=${toolRounds} tools=${totalToolCount}`,
            );
            return {
                messages,
                lastAssistantText: (msgContent ?? '').trim(),
                hadToolCalls,
            };
        }

        hadToolCalls = true;
        toolRounds++;
        if (toolRounds >= MAX_TOOL_ROUNDS) {
            logger.warning(
                '[agent] Reached tool-use limit, stopping further tool calls.',
            );
            messages.push({
                role: 'assistant',
                content:
                    'Stopped tool calls due to safety limit. Please rephrase or narrow your request if you still need help.',
            });
            const totalMs = Date.now() - loopStart;
            slog.debug(
                `agent_loop end session=${sidTag} duration_ms=${totalMs} rounds=${toolRounds} tools=${totalToolCount} (limit hit)`,
            );
            return {
                messages,
                lastAssistantText: lastAssistantText(messages),
                hadToolCalls,
            };
        }

        // Build tool_calls in OpenAI format
        const assistantToolCalls = msgToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
        }));

        const results: { tool_call_id: string; content: string }[] = [];
        for (const tc of msgToolCalls) {
            totalToolCount++;
            const name = tc.function.name;
            let args: Record<string, any>;
            try {
                args = JSON.parse(tc.function.arguments || '{}');
            } catch {
                args = {};
            }

            if (name === 'Task') {
                logger.info(`> Task: ${args.description ?? 'subtask'}`);
            } else if (name === 'Skill') {
                logger.info(`> Loading skill: ${args.skill ?? '?'}`);
            } else {
                logger.info(`> ${name}`);
            }

            let output = await executeToolAsync(name, args);
            if (contextEnabled()) {
                output = foldObservation(output);
            }

            if (name === 'Skill') {
                logger.info(`  Skill loaded (${output.length} chars)`);
            } else if (name !== 'Task') {
                const preview =
                    output.length > 200 ? output.slice(0, 200) + '...' : output;
                logger.info(`  ${preview}`);
            }

            results.push({ tool_call_id: tc.id, content: output });
        }

        // Append to API messages
        apiMessages.push({
            role: 'assistant',
            content: msgContent || '',
            tool_calls: assistantToolCalls,
        });
        for (const r of results) {
            apiMessages.push({
                role: 'tool',
                tool_call_id: r.tool_call_id,
                content: r.content,
            });
        }
        // Keep local messages in sync
        messages.push({
            role: 'assistant',
            content: msgContent || '',
            tool_calls: assistantToolCalls,
        });
        for (const r of results) {
            messages.push({
                role: 'tool',
                tool_call_id: r.tool_call_id,
                content: r.content,
            });
        }
    }
}
