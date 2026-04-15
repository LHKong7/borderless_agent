/**
 * server/app.ts - Express HTTP server for the general-purpose agent.
 *
 * Endpoints:
 *   POST /sessions
 *   GET  /sessions
 *   GET  /sessions/:id
 *   POST /sessions/:id/turn
 *   POST /sessions/:id/turn/stream (SSE)
 *   POST /sessions/:id/answer      (human-in-the-loop)
 */

import express, { Request, Response } from 'express';
import { MODEL, setupAgentLogging, logger } from '../config';
import { LifecycleManager, getBudget } from '../contextCore';
import { SessionManager } from '../sessionCore';
import { setExecutorApprovalCallback, setFileAccessCallback, setHumanInputCallback } from '../toolsCore';
import { getStorageBackend } from '../storage';
import { setMemoryStore } from '../memoryCore';
import { SKILLS } from '../skillsCore';
import { runTurn } from '../cli/main';
import { humanLoopManager } from './humanLoop';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let sessionMgr: SessionManager | null = null;

/**
 * Current session ID for the active turn.
 * Set before runTurn so the human input callback knows which session to use.
 */
let _currentSessionId = '';

async function getSessionMgr(): Promise<SessionManager> {
    if (!sessionMgr) await initServer();
    return sessionMgr!;
}

function serverApprovalCallback(
    toolName: string,
    toolArgs: Record<string, any>,
): boolean {
    // In server mode, deny mutating tools by default
    return false;
}

/**
 * Human input callback for server mode.
 * When the agent calls ask_user, this blocks on a Promise that resolves
 * when the client posts to /sessions/:id/answer.
 */
async function serverHumanInputCallback(question: string): Promise<string> {
    const sid = _currentSessionId;
    if (!sid) {
        return '[Human input not available] No active session for human input.';
    }
    return humanLoopManager.ask(sid, question);
}

async function initServer(): Promise<void> {
    if (sessionMgr) return;
    setupAgentLogging();
    const backend = await getStorageBackend();
    sessionMgr = new SessionManager({ store: backend.sessionStore });
    setMemoryStore(backend.memoryStore);
    SKILLS.setStore(backend.skillStore);
    setFileAccessCallback((p) => sessionMgr!.recordFileAccess(p));
    setExecutorApprovalCallback(serverApprovalCallback);
    setHumanInputCallback(serverHumanInputCallback);
    logger.info('Agent server started; SessionManager ready.');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// #28: Simple in-memory rate limiter (no external deps)
const _rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

app.use((req: Request, res: Response, next: Function) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const timestamps = _rateLimitMap.get(ip) || [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
        res.status(429).json({ detail: 'Too many requests' });
        return;
    }
    recent.push(now);
    _rateLimitMap.set(ip, recent);
    next();
});

// #6: Safe SSE write helper — guards against writing to closed connections
function safeWrite(res: Response, data: string): boolean {
    if (res.writableEnded || res.destroyed) return false;
    try { res.write(data); return true; }
    catch { return false; }
}

// SSE overall timeout (5 minutes)
const SSE_TIMEOUT_MS = 5 * 60 * 1000;

// POST /sessions — create new session
app.post('/sessions', async (_req: Request, res: Response) => {
    const mgr = await getSessionMgr();
    const session = await mgr.createSession({ context: { started: true } });
    res.status(201).json({ session_id: session.id });
});

// GET /sessions — list sessions
app.get('/sessions', async (req: Request, res: Response) => {
    const mgr = await getSessionMgr();
    const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
        100,
    );
    const summaries = await mgr.listSessionsSummary(limit);
    res.json(summaries);
});

// GET /sessions/:id — get session info
app.get('/sessions/:sessionId', async (req: Request, res: Response) => {
    const mgr = await getSessionMgr();
    const session = await mgr.restoreSession(req.params.sessionId);
    if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
    }
    const turns = session.history.filter((m: Record<string, any>) => m.role === 'user').length;
    res.json({
        id: session.id,
        updated_at: session.updatedAt,
        turns,
        state: session.state,
    });
});

// POST /sessions/:id/turn — synchronous turn
// Note: ask_user is NOT supported in sync mode (no way to deliver question to client mid-request).
// The agent will get a "not available" response and proceed with best judgment.
app.post('/sessions/:sessionId/turn', async (req: Request, res: Response) => {
    const mgr = await getSessionMgr();
    const createIfMissing = req.query.create_if_missing === 'true';
    let session = await mgr.restoreSession(req.params.sessionId);
    let created = false;

    if (!session) {
        if (createIfMissing) {
            session = await mgr.createSession({ context: { started: true } });
            created = true;
        } else {
            res.status(404).json({ detail: 'Session not found' });
            return;
        }
    }

    const message = (req.body?.message ?? '').trim();
    if (!message) {
        res.status(400).json({ detail: 'message must be non-empty' });
        return;
    }

    // For sync turns, disable human input (can't interact mid-request)
    const prevCallback = _currentSessionId;
    _currentSessionId = ''; // empty = callback returns "not available"

    try {
        const lifecycle = new LifecycleManager();
        const savedSummary = session.context.conversation_summary;
        if (savedSummary) lifecycle.setConversationSummary(savedSummary);
        const budget = getBudget({ model: MODEL });
        const history = [...session.history];

        const result = await runTurn({
            userInput: message,
            history,
            sessionMgr: mgr,
            lifecycle,
            budget,
        });

        res.json({
            reply: result.lastAssistantText ?? '',
            pending_approvals: [],
            session_id: created ? session.id : undefined,
        });
    } catch (e: any) {
        logger.error(`turn failed: ${e}`);
        res.status(500).json({ detail: String(e).slice(0, 500) });
    } finally {
        _currentSessionId = prevCallback;
    }
});

// POST /sessions/:id/turn/stream — SSE streaming turn
// Supports ask_user: sends {"type":"ask_user","question":"..."} event.
// Client should POST /sessions/:id/answer with {"answer":"..."} to continue.
app.post(
    '/sessions/:sessionId/turn/stream',
    async (req: Request, res: Response) => {
        const mgr = await getSessionMgr();
        const createIfMissing = req.query.create_if_missing === 'true';
        let session = await mgr.restoreSession(req.params.sessionId);

        if (!session) {
            if (createIfMissing) {
                session = await mgr.createSession({ context: { started: true } });
            } else {
                res.status(404).json({ detail: 'Session not found' });
                return;
            }
        }

        const message = (req.body?.message ?? '').trim();
        if (!message) {
            res.status(400).json({ detail: 'message must be non-empty' });
            return;
        }

        const sessionId = session.id;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // #9: Overall SSE timeout
        const sseTimer = setTimeout(() => {
            safeWrite(res, `data: ${JSON.stringify({ type: 'error', detail: 'SSE timeout — request took too long' })}\n\n`);
            humanLoopManager.cancel(sessionId);
            if (!res.writableEnded) res.end();
        }, SSE_TIMEOUT_MS);

        // Cancel pending question on client disconnect
        req.on('close', () => {
            clearTimeout(sseTimer);
            humanLoopManager.cancel(sessionId);
        });

        // #6: Use safeWrite for all SSE writes
        const streamCallback = (chunk: string) => {
            safeWrite(res, `data: ${JSON.stringify({ type: 'delta', delta: chunk })}\n\n`);
        };

        // Set up human input: when ask_user is called, send SSE event then block
        // NOTE: concurrent streaming requests may conflict on this global callback (#2/#14)
        const prevSessionId = _currentSessionId;
        _currentSessionId = sessionId;

        const origCallback = serverHumanInputCallback;
        setHumanInputCallback(async (question: string) => {
            safeWrite(res, `data: ${JSON.stringify({ type: 'ask_user', question })}\n\n`);
            return humanLoopManager.ask(sessionId, question);
        });

        try {
            const lifecycle = new LifecycleManager();
            const savedSummary = session.context.conversation_summary;
            if (savedSummary) lifecycle.setConversationSummary(savedSummary);
            const budget = getBudget({ model: MODEL });
            const history = [...session.history];

            const result = await runTurn({
                userInput: message,
                history,
                sessionMgr: mgr,
                lifecycle,
                budget,
                streamCallback,
            });

            safeWrite(res, `data: ${JSON.stringify({
                type: 'done',
                reply: result.lastAssistantText ?? '',
                pending_approvals: [],
            })}\n\n`);
        } catch (e: any) {
            logger.error(`turn_stream failed: ${e}`);
            safeWrite(res, `data: ${JSON.stringify({
                type: 'error',
                detail: String(e).slice(0, 500),
            })}\n\n`);
        } finally {
            clearTimeout(sseTimer);
            _currentSessionId = prevSessionId;
            setHumanInputCallback(origCallback);
            // #11: attempt to save session even on interruption
            try { await mgr.saveSession(session); }
            catch (e: any) { logger.error(`Failed to save session on stream end: ${e}`); }
            if (!res.writableEnded) res.end();
        }
    },
);

// POST /sessions/:id/answer — submit answer for human-in-the-loop
app.post('/sessions/:sessionId/answer', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const answer = (req.body?.answer ?? '').trim();

    if (!answer) {
        res.status(400).json({ detail: 'answer must be non-empty' });
        return;
    }

    const success = humanLoopManager.answer(sessionId, answer);
    if (!success) {
        res.status(404).json({ detail: 'No pending question for this session' });
        return;
    }

    res.json({ status: 'ok' });
});

export { app };

// Start server if run directly
if (require.main === module) {
    const port = parseInt(process.env.PORT ?? '8000', 10);
    initServer().then(() => {
        app.listen(port, () => {
            logger.info(`Agent API server listening on port ${port}`);
        });
    });
}
