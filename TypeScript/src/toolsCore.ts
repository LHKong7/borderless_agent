/**
 * toolsCore.ts - Tool definitions and implementations (bash, file ops, skills, tasks).
 *
 * Read: pagination (offset/limit) and chunked read for large files.
 * Grep: context lines (before/after) around matches.
 * Write: atomic write + backup before overwrite.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WORKDIR, defaultLlmProvider, logger } from './config';
import { LLMProvider, LLMResponse, ToolCall, ChatMessage } from './llmProtocol';
import { SKILLS } from './skillsCore';
import { TODO } from './todoCore';
import { AGENT_TYPES, EXECUTOR_MUTATING_TOOLS } from './agentsCore';

// Mid-term memory: optional callback when a file is read
let _fileAccessCallback: ((path: string) => void) | null = null;

export function setFileAccessCallback(
    cb: ((path: string) => void) | null,
): void {
    _fileAccessCallback = cb;
}

// ---------------------------------------------------------------------------
// Tool format conversion
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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const BASE_TOOLS: Record<string, any>[] = [
    {
        name: 'bash',
        description: 'Run shell command.',
        input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
        },
    },
    {
        name: 'read_file',
        description:
            'Read file contents with pagination. Use offset/limit for large files to avoid token overflow.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                offset: {
                    type: 'integer',
                    description: 'Line number to start from (0-based). Default 0.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max lines to return. Default 500. Omit for first page only.',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'grep',
        description:
            'Search for pattern in file; show matching lines with optional context (lines before/after).',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                pattern: { type: 'string' },
                context_before: {
                    type: 'integer',
                    description: 'Lines to show before each match. Default 0.',
                },
                context_after: {
                    type: 'integer',
                    description: 'Lines to show after each match. Default 0.',
                },
            },
            required: ['path', 'pattern'],
        },
    },
    {
        name: 'write_file',
        description:
            'Write to file. Creates backup of existing file before overwrite (rollback-friendly).',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'edit_file',
        description: 'Replace text in file.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                old_text: { type: 'string' },
                new_text: { type: 'string' },
            },
            required: ['path', 'old_text', 'new_text'],
        },
    },
    {
        name: 'TodoWrite',
        description: 'Update task list.',
        input_schema: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            content: { type: 'string' },
                            status: {
                                type: 'string',
                                enum: ['pending', 'in_progress', 'completed'],
                            },
                            activeForm: { type: 'string' },
                        },
                        required: ['content', 'status', 'activeForm'],
                    },
                },
            },
            required: ['items'],
        },
    },
    {
        name: 'search_knowledge_base',
        description:
            'Query knowledge base (stub). Use for Explorer when user asks to look up docs or KB.',
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        },
    },
    {
        name: 'read_email',
        description:
            'Read emails (stub). Use for Explorer when user asks to check or read mail.',
        input_schema: {
            type: 'object',
            properties: {
                folder: { type: 'string', description: 'Inbox, Sent, etc.' },
                limit: { type: 'integer' },
            },
            required: [],
        },
    },
];

export const TASK_TOOL: Record<string, any> = {
    name: 'Task',
    description:
        'Spawn a subagent for a focused subtask.\n\nAgent types:\n' +
        Object.entries(AGENT_TYPES)
            .map(([name, cfg]) => `- ${name}: ${cfg.description}`)
            .join('\n'),
    input_schema: {
        type: 'object',
        properties: {
            description: {
                type: 'string',
                description: 'Short task description (3-5 words)',
            },
            prompt: {
                type: 'string',
                description: 'Detailed instructions for the subagent',
            },
            agent_type: {
                type: 'string',
                enum: Object.keys(AGENT_TYPES),
            },
        },
        required: ['description', 'prompt', 'agent_type'],
    },
};

export const SKILL_TOOL: Record<string, any> = {
    name: 'Skill',
    description: `Load a skill to gain specialized knowledge for a task.

Available skills:
${SKILLS.getDescriptions()}

When to use:
- IMMEDIATELY when user task matches a skill description
- Before attempting domain-specific work (PDF, MCP, etc.)

The skill content will be injected into the conversation, giving you
detailed instructions and access to resources.`,
    input_schema: {
        type: 'object',
        properties: {
            skill: {
                type: 'string',
                description: 'Name of the skill to load',
            },
        },
        required: ['skill'],
    },
};

export const ALL_TOOLS: Record<string, any>[] = [
    ...BASE_TOOLS,
    TASK_TOOL,
    SKILL_TOOL,
];

// Safety limit
export const MAX_TOOL_ROUNDS = 20;

// Track loaded skills per interaction
export const LOADED_SKILLS: Set<string> = new Set();

// Approval callback for Executor
let _executorApprovalCallback:
    | ((toolName: string, toolArgs: Record<string, any>) => boolean)
    | null = null;

export function setExecutorApprovalCallback(
    callback:
        | ((toolName: string, toolArgs: Record<string, any>) => boolean)
        | null,
): void {
    _executorApprovalCallback = callback;
}

function defaultExecutorApproval(
    toolName: string,
    toolArgs: Record<string, any>,
): boolean {
    let summary = `[Executor] ${toolName}`;
    if (toolName === 'bash') {
        summary += `: ${(toolArgs.command ?? '').slice(0, 80)}`;
    } else if (toolName === 'write_file') {
        summary += `: write ${toolArgs.path ?? ''} (${(toolArgs.content ?? '').length} chars)`;
    } else if (toolName === 'edit_file') {
        summary += `: edit ${toolArgs.path ?? ''}`;
    } else {
        summary += `: ${JSON.stringify(toolArgs)}`;
    }
    // In non-interactive contexts, deny by default
    logger.info(`\n${summary}\nApproval required (auto-denied in non-interactive mode)`);
    return false;
}

export function getToolsForAgent(agentType: string): Record<string, any>[] {
    const allowed = AGENT_TYPES[agentType]?.tools ?? '*';
    if (allowed === '*') return BASE_TOOLS;
    return BASE_TOOLS.filter((t) => (allowed as string[]).includes(t.name));
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

export function safePath(p: string): string {
    const resolved = path.resolve(WORKDIR, p);
    if (!resolved.startsWith(path.resolve(WORKDIR))) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const READ_DEFAULT_LIMIT = 500;
const READ_MAX_CHARS = 50_000;

export function runBash(cmd: string): string {
    if (['rm -rf /', 'sudo', 'shutdown'].some((d) => cmd.includes(d))) {
        return 'Error: Dangerous command';
    }
    try {
        const result = execSync(cmd, {
            cwd: WORKDIR,
            encoding: 'utf-8',
            timeout: 60_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return (result || '(no output)').trim().slice(0, 50_000);
    } catch (e: any) {
        const stderr = e.stderr?.toString() ?? '';
        const stdout = e.stdout?.toString() ?? '';
        return ((stdout + stderr).trim() || `Error: ${e.message}`).slice(0, 50_000);
    }
}

export function runRead(
    filePath: string,
    offset: number = 0,
    limit?: number,
): string {
    try {
        const fp = safePath(filePath);
        if (!fs.existsSync(fp)) return `Error: File not found: ${filePath}`;
        if (_fileAccessCallback) {
            try { _fileAccessCallback(filePath); } catch { /* ignore */ }
        }
        const effectiveLimit = Math.max(1, Math.min(limit ?? READ_DEFAULT_LIMIT, 2000));
        offset = Math.max(0, offset);
        const content = fs.readFileSync(fp, 'utf-8');
        const allLines = content.split('\n');
        const lines = allLines.slice(offset, offset + effectiveLimit);

        if (lines.length >= effectiveLimit && offset + effectiveLimit < allLines.length) {
            const footer = `\n[Lines ${offset + 1}-${offset + lines.length}; use offset=${offset + effectiveLimit} for next page]`;
            let out = lines.join('\n');
            if (out.length > READ_MAX_CHARS) out = out.slice(0, READ_MAX_CHARS) + '\n...[truncated]';
            return out + footer;
        }

        let out = lines.join('\n');
        if (out.length > READ_MAX_CHARS) out = out.slice(0, READ_MAX_CHARS) + '\n...[truncated]';
        return out + `\n[Lines ${offset + 1}-${offset + lines.length}]`;
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runGrep(
    filePath: string,
    pattern: string,
    contextBefore: number = 0,
    contextAfter: number = 0,
): string {
    try {
        const fp = safePath(filePath);
        if (!fs.existsSync(fp)) return `Error: File not found: ${filePath}`;
        contextBefore = Math.max(0, Math.min(contextBefore, 10));
        contextAfter = Math.max(0, Math.min(contextAfter, 10));
        let pat: RegExp;
        try {
            pat = new RegExp(pattern);
        } catch {
            pat = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        }
        const lines = fs.readFileSync(fp, 'utf-8').split('\n');
        const results: string[] = [];
        let i = 0;
        while (i < lines.length) {
            if (pat.test(lines[i])) {
                const start = Math.max(0, i - contextBefore);
                const end = Math.min(lines.length, i + 1 + contextAfter);
                for (let j = start; j < end; j++) {
                    const prefix = j !== i ? '  ' : '> ';
                    results.push(`${prefix}${j + 1}: ${lines[j]}`);
                }
                results.push('');
                i = end;
            } else {
                i++;
            }
        }
        if (!results.length)
            return `No matches for pattern '${pattern.slice(0, 60)}' in ${filePath}`;
        return results.join('\n').trim().slice(0, READ_MAX_CHARS);
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runWrite(filePath: string, content: string): string {
    try {
        const fp = safePath(filePath);
        const dir = path.dirname(fp);
        fs.mkdirSync(dir, { recursive: true });
        let didBackup = false;
        let backupName = '';
        if (fs.existsSync(fp)) {
            backupName = fp + '.bak';
            fs.copyFileSync(fp, backupName);
            didBackup = true;
        }
        const tmp = fp + '.tmp';
        fs.writeFileSync(tmp, content, 'utf-8');
        fs.renameSync(tmp, fp);
        return (
            `Wrote ${content.length} bytes to ${filePath}` +
            (didBackup ? ` (backup: ${path.basename(backupName)})` : '')
        );
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runEdit(
    filePath: string,
    oldText: string,
    newText: string,
): string {
    try {
        const fp = safePath(filePath);
        const text = fs.readFileSync(fp, 'utf-8');
        if (!text.includes(oldText)) return `Error: Text not found in ${filePath}`;
        fs.writeFileSync(fp, text.replace(oldText, newText), 'utf-8');
        return `Edited ${filePath}`;
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runTodo(items: any[]): string {
    try {
        return TODO.update(items);
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runSearchKnowledgeBase(query: string): string {
    return (
        '[Stub] Knowledge base is not connected. ' +
        'Use read_file and grep on local files under the workspace for retrieval.'
    );
}

export function runReadEmail(
    folder: string = 'Inbox',
    limit: number = 10,
): string {
    return (
        '[Stub] Email is not connected. ' +
        'When integrated, this would list emails from the specified folder.'
    );
}

export function runSkill(skillName: string): string {
    if (LOADED_SKILLS.has(skillName)) {
        return (
            `(Skill '${skillName}' is already loaded for this task. ` +
            'Use the previously loaded knowledge to answer the user directly, ' +
            'and do NOT call the Skill tool again.)'
        );
    }
    LOADED_SKILLS.add(skillName);
    const content = SKILLS.getSkillContent(skillName);
    if (content === null) {
        const available = SKILLS.listSkills().join(', ') || 'none';
        return `Error: Unknown skill '${skillName}'. Available: ${available}`;
    }
    return `<skill-loaded name="${skillName}">
${content}
</skill-loaded>

You have now loaded this skill. Use the knowledge above to complete the user's task.
Do NOT call the Skill tool again for this task; respond with your full answer in natural language.`;
}

// ---------------------------------------------------------------------------
// run_task (subagent)
// ---------------------------------------------------------------------------

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

export async function runTask(
    description: string,
    prompt: string,
    agentType: string,
    llm?: LLMProvider,
): Promise<string> {
    if (!llm) llm = defaultLlmProvider;
    if (!(agentType in AGENT_TYPES))
        return `Error: Unknown agent type '${agentType}'`;

    const config = AGENT_TYPES[agentType];
    const subSystem = `You are a ${agentType} subagent at ${WORKDIR}.

${config.prompt}

Complete the task and return a clear, concise summary.`;

    const subTools = getToolsForAgent(agentType);
    const openaiTools = toolsToOpenAI(subTools);
    const apiMessages: Record<string, any>[] = [
        { role: 'system', content: subSystem },
        { role: 'user', content: prompt },
    ];

    logger.info(`  [${agentType}] ${description}`);
    const start = Date.now();
    let toolCount = 0;
    let toolRounds = 0;
    let lastText = '(subagent returned no text)';

    while (true) {
        const response = (await llm.chat(apiMessages, {
            tools: openaiTools,
            maxTokens: 8000,
            stream: false,
        })) as LLMResponse;

        const tcs = response.toolCalls?.length
            ? toolCallsToMsgShape(response.toolCalls)
            : [];

        const usage = response.usage;
        if (usage && (usage.input_tokens || usage.output_tokens)) {
            logger.info(
                `  [${agentType}] Tokens: in ${usage.input_tokens ?? 0} out ${usage.output_tokens ?? 0}`,
            );
        }

        if (response.content) lastText = response.content.trim();
        if (!tcs.length) break;

        toolRounds++;
        if (toolRounds >= MAX_TOOL_ROUNDS) {
            logger.warning(
                `  [${agentType}] Reached tool-use limit, stopping tool calls.`,
            );
            break;
        }

        const assistantToolCalls = tcs.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
        }));

        const results: { tool_call_id: string; content: string }[] = [];
        for (const tc of tcs) {
            toolCount++;
            const name = tc.function.name;
            let args: Record<string, any>;
            try {
                args = JSON.parse(tc.function.arguments || '{}');
            } catch {
                args = {};
            }
            let output: string;
            if (config.requiresApproval && EXECUTOR_MUTATING_TOOLS.has(name)) {
                const ask = _executorApprovalCallback ?? defaultExecutorApproval;
                if (!ask(name, args)) {
                    output = 'Action not approved by user.';
                } else {
                    output = executeTool(name, args);
                }
            } else {
                output = executeTool(name, args);
            }
            results.push({ tool_call_id: tc.id, content: output });
        }

        apiMessages.push({
            role: 'assistant',
            content: response.content ?? '',
            tool_calls: assistantToolCalls,
        });
        for (const r of results) {
            apiMessages.push({
                role: 'tool',
                tool_call_id: r.tool_call_id,
                content: r.content,
            });
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(
        `  [${agentType}] ${description} - done (${toolCount} tools, ${elapsed}s)`,
    );
    return lastText;
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export function executeTool(name: string, args: Record<string, any>): string {
    switch (name) {
        case 'bash':
            return runBash(args.command);
        case 'read_file':
            return runRead(args.path, args.offset ?? 0, args.limit);
        case 'grep':
            return runGrep(
                args.path,
                args.pattern,
                args.context_before ?? 0,
                args.context_after ?? 0,
            );
        case 'write_file':
            return runWrite(args.path, args.content);
        case 'edit_file':
            return runEdit(args.path, args.old_text, args.new_text);
        case 'TodoWrite':
            return runTodo(args.items);
        case 'search_knowledge_base':
            return runSearchKnowledgeBase(args.query ?? '');
        case 'read_email':
            return runReadEmail(args.folder ?? 'Inbox', args.limit ?? 10);
        case 'Task':
            // runTask is async; return a placeholder — callers should use executeToolAsync
            return '(Task tool requires async execution)';
        case 'Skill':
            return runSkill(args.skill);
        default:
            return `Unknown tool: ${name}`;
    }
}

export async function executeToolAsync(
    name: string,
    args: Record<string, any>,
): Promise<string> {
    if (name === 'Task') {
        return runTask(args.description, args.prompt, args.agent_type);
    }
    return executeTool(name, args);
}
