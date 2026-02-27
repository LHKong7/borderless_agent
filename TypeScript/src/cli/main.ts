/**
 * cli/main.ts - CLI entry point for the general-purpose agent (REPL, session choice, run_turn).
 */

import * as readline from 'readline';
import { WORKDIR, MODEL, setupAgentLogging, logger, slog } from '../config';
import { SessionManager } from '../sessionCore';
import { SKILLS } from '../skillsCore';
import { getStorageBackend } from '../storage';
import { setMemoryStore, retrieve, consolidateTurn, writeInsight, loadUserPreferences, loadProjectKnowledge, MAX_HISTORY_TURNS } from '../memoryCore';
import { AGENT_TYPES } from '../agentsCore';
import { LOADED_SKILLS, setFileAccessCallback } from '../toolsCore';
import { agentLoop, getBaseSystem } from '../loopCore';
import { LLMProvider } from '../llmProtocol';
import {
    getBudget,
    selectHistory,
    assembleSystem,
    sanitizeUserInput,
    LifecycleManager,
    summarizeRounds,
    contextEnabled,
    replyCacheEnabled,
    getCachedReply,
    setCachedReply,
} from '../contextCore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function createReadlineInterface(): readline.Interface {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer.trim()));
    });
}

// ---------------------------------------------------------------------------
// Session chooser
// ---------------------------------------------------------------------------

async function chooseSession(
    sessionMgr: SessionManager,
    rl: readline.Interface,
): Promise<void> {
    while (true) {
        let choice: string;
        try {
            choice =
                (await ask(
                    rl,
                    'Start: [n]ew session, [l]ist sessions, [r]estore <id> (default n): ',
                )) || 'n';
        } catch {
            choice = 'n';
        }
        choice = choice.toLowerCase();

        if (choice === 'n') {
            sessionMgr.createSession({ context: { started: true } });
            return;
        }
        if (choice === 'l') {
            const summaries = sessionMgr.listSessionsSummary(20);
            if (!summaries.length) {
                console.log('  No saved sessions.');
            } else {
                for (const s of summaries) {
                    const sidShort = s.id.slice(0, 8);
                    const rel = relativeTime(s.updated_at).padStart(10);
                    console.log(
                        `  ${sidShort}  ${rel}  ${s.turns} turns  [${s.state}]  ${s.id}`,
                    );
                }
            }
            continue;
        }
        if (choice.startsWith('r ')) {
            const sid = choice.slice(2).trim();
            if (sessionMgr.restoreSession(sid)) return;
            console.log(`  Session not found: ${sid}`);
            continue;
        }
        console.log('  Use n, l, or r <id>.');
    }
}

// ---------------------------------------------------------------------------
// run_turn
// ---------------------------------------------------------------------------

export async function runTurn(options: {
    userInput: string;
    history: Record<string, any>[];
    sessionMgr: SessionManager;
    lifecycle: LifecycleManager;
    budget: Record<string, number>;
    streamCallback?: (chunk: string) => void;
    llm?: LLMProvider;
}): Promise<{
    history: Record<string, any>[];
    lastAssistantText: string;
}> {
    const turnStart = Date.now();
    LOADED_SKILLS.clear();

    let { userInput } = options;
    let { history } = options;
    const { sessionMgr, lifecycle, budget } = options;

    const sanitized = sanitizeUserInput(userInput);
    userInput = sanitized.text;

    if (
        contextEnabled() &&
        lifecycle.detectTopicShift(userInput, history.slice(-6))
    ) {
        if (history.length) {
            const summary = await summarizeRounds(history);
            if (summary) writeInsight(summary, 0.5);
        }
        history.length = 0;
        lifecycle.resetSession();
    }

    const memoryTuples = retrieve(userInput, 5);
    const ragLines = memoryTuples.map((m) => m[0]).filter(Boolean);

    if (contextEnabled()) {
        history = selectHistory(history, userInput, budget.history, MAX_HISTORY_TURNS);
    } else {
        const maxMessages = MAX_HISTORY_TURNS * 2;
        if (history.length > maxMessages) {
            history = history.slice(-maxMessages);
        }
    }

    history.push({ role: 'user', content: userInput });

    const active = sessionMgr.getActiveSession();
    const sessionId = active?.id ?? '';

    // Reply cache
    if (replyCacheEnabled() && active) {
        const cached = getCachedReply(sessionId, userInput, history);
        if (cached) {
            history.push({ role: 'assistant', content: cached.text });
            consolidateTurn(userInput, cached.text);
            syncSession(sessionMgr, lifecycle, history);
            return { history, lastAssistantText: cached.text };
        }
    }

    let systemOverride: string | undefined;
    if (contextEnabled()) {
        const projectKnowledge = loadProjectKnowledge();
        const prefs = loadUserPreferences();
        let preferencesSummary = `Model: ${prefs.model ?? 'gpt-4o'}.`;
        if (prefs.permissions) {
            preferencesSummary += ` Permissions: ${JSON.stringify(prefs.permissions)}.`;
        }
        let recentFilesSummary: string | undefined;
        if (active) {
            const recent = (active.context.recent_files as any[]) ?? [];
            if (recent.length) {
                recentFilesSummary = recent
                    .slice(0, 10)
                    .map((f: any) => `- ${f.path ?? ''} (accessed ${f.access_count ?? 0}x)`)
                    .join('\n');
            }
        }
        systemOverride = assembleSystem({
            baseSystem: getBaseSystem(),
            ragLines: ragLines.length ? ragLines : undefined,
            conversationSummary: lifecycle.getConversationSummary() || undefined,
            budgetRag: budget.rag,
            projectKnowledge: projectKnowledge ?? undefined,
            preferencesSummary,
            recentFilesSummary,
        });
    }

    const historyBeforeTurn = [...history];
    let lastAssistantText = '';

    try {
        const result = await agentLoop({
            messages: history,
            retrievedMemories: systemOverride ? undefined : ragLines.length ? ragLines : undefined,
            systemOverride,
            budget,
            sessionId,
            onContentDelta: options.streamCallback,
            llm: options.llm,
        });

        history = result.messages;
        lastAssistantText = result.lastAssistantText;

        consolidateTurn(userInput, lastAssistantText);

        if (replyCacheEnabled() && active && !result.hadToolCalls) {
            setCachedReply(
                sessionId,
                userInput,
                historyBeforeTurn,
                lastAssistantText,
                history,
            );
        }

        syncSession(sessionMgr, lifecycle, history);
    } catch (e: any) {
        logger.error(`Error: ${e}`);
        const errMsg = String(e).slice(0, 500);
        history.push({ role: 'assistant', content: `[Error: ${errMsg}]` });
        lastAssistantText = `[Error: ${errMsg}]`;
        syncSession(sessionMgr, lifecycle, history);
    }

    const turnMs = Date.now() - turnStart;
    const sidTag = sessionId.slice(0, 8) || '-';
    slog.debug(
        `run_turn end session=${sidTag} duration_ms=${turnMs} history_len=${history.length}`,
    );

    return { history, lastAssistantText };
}

// ---------------------------------------------------------------------------
// Agent class (library-style)
// ---------------------------------------------------------------------------

export class Agent {
    llm: LLMProvider;
    workdir?: string;

    constructor(llm: LLMProvider, workdir?: string) {
        this.llm = llm;
        this.workdir = workdir;
    }

    runTurn(options: {
        userInput: string;
        history: Record<string, any>[];
        sessionMgr: SessionManager;
        lifecycle: LifecycleManager;
        budget: Record<string, number>;
        streamCallback?: (chunk: string) => void;
    }) {
        return runTurn({ ...options, llm: this.llm });
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function syncSession(
    sessionMgr: SessionManager,
    lifecycle: LifecycleManager,
    history: Record<string, any>[],
): void {
    const active = sessionMgr.getActiveSession();
    if (active) {
        active.history = history;
        active.context.conversation_summary = lifecycle.getConversationSummary();
        sessionMgr.saveActive();
    }
    if (contextEnabled() && history.length >= 20) {
        // Fire and forget summary
        summarizeRounds(history.slice(0, -2)).then((summary) => {
            if (summary) lifecycle.setConversationSummary(summary);
        });
    }
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
    setupAgentLogging();
    const backend = getStorageBackend();
    const sessionMgr = new SessionManager({ store: backend.sessionStore });
    setMemoryStore(backend.memoryStore);
    SKILLS.setStore(backend.skillStore);
    setFileAccessCallback((p) => sessionMgr.recordFileAccess(p));

    console.log(
        `General-purpose Agent v4 (Skills + Memory + Context) - ${WORKDIR}`,
    );
    console.log(`Skills: ${SKILLS.listSkills().join(', ') || 'none'}`);
    console.log(`Agent types: ${Object.keys(AGENT_TYPES).join(', ')}`);
    console.log("Type 'exit' to quit.\n");

    const rl = createReadlineInterface();
    await chooseSession(sessionMgr, rl);
    const active = sessionMgr.getActiveSession()!;
    let history: Record<string, any>[] = active.history;

    const lifecycle = new LifecycleManager();
    const savedSummary = active.context.conversation_summary;
    if (savedSummary) lifecycle.setConversationSummary(savedSummary);
    const budget = getBudget({ model: MODEL });

    const loop = async () => {
        while (true) {
            let userInput: string;
            try {
                userInput = await ask(rl, 'You: ');
            } catch {
                break;
            }
            if (!userInput || ['exit', 'quit', 'q'].includes(userInput.toLowerCase())) {
                sessionMgr.saveActive();
                break;
            }
            const result = await runTurn({
                userInput,
                history,
                sessionMgr,
                lifecycle,
                budget,
            });
            history = result.history;
            console.log();
        }
        rl.close();
    };

    await loop();
}
