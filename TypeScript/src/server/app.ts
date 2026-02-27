/**
 * server/app.ts - Express HTTP server for the general-purpose agent.
 *
 * Same endpoints as the Python FastAPI server:
 *   POST /sessions
 *   GET  /sessions
 *   GET  /sessions/:id
 *   POST /sessions/:id/turn
 *   POST /sessions/:id/turn/stream (SSE)
 */

import express, { Request, Response } from 'express';
import { MODEL, setupAgentLogging, logger } from '../config';
import { LifecycleManager, getBudget } from '../contextCore';
import { SessionManager } from '../sessionCore';
import { setExecutorApprovalCallback, setFileAccessCallback } from '../toolsCore';
import { getStorageBackend } from '../storage';
import { setMemoryStore } from '../memoryCore';
import { SKILLS } from '../skillsCore';
import { runTurn } from '../cli/main';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let sessionMgr: SessionManager | null = null;

function getSessionMgr(): SessionManager {
    if (!sessionMgr) initServer();
    return sessionMgr!;
}

function serverApprovalCallback(
    toolName: string,
    toolArgs: Record<string, any>,
): boolean {
    // In server mode, deny mutating tools by default
    return false;
}

function initServer(): void {
    if (sessionMgr) return;
    setupAgentLogging();
    const backend = getStorageBackend();
    sessionMgr = new SessionManager({ store: backend.sessionStore });
    setMemoryStore(backend.memoryStore);
    SKILLS.setStore(backend.skillStore);
    setFileAccessCallback((p) => sessionMgr!.recordFileAccess(p));
    setExecutorApprovalCallback(serverApprovalCallback);
    logger.info('Agent server started; SessionManager ready.');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// POST /sessions — create new session
app.post('/sessions', (_req: Request, res: Response) => {
    const mgr = getSessionMgr();
    const session = mgr.createSession({ context: { started: true } });
    res.status(201).json({ session_id: session.id });
});

// GET /sessions — list sessions
app.get('/sessions', (req: Request, res: Response) => {
    const mgr = getSessionMgr();
    const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
        100,
    );
    const summaries = mgr.listSessionsSummary(limit);
    res.json(summaries);
});

// GET /sessions/:id — get session info
app.get('/sessions/:sessionId', (req: Request, res: Response) => {
    const mgr = getSessionMgr();
    const session = mgr.restoreSession(req.params.sessionId);
    if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
    }
    const turns = session.history.filter((m) => m.role === 'user').length;
    res.json({
        id: session.id,
        updated_at: session.updatedAt,
        turns,
        state: session.state,
    });
});

// POST /sessions/:id/turn — synchronous turn
app.post('/sessions/:sessionId/turn', async (req: Request, res: Response) => {
    const mgr = getSessionMgr();
    const createIfMissing = req.query.create_if_missing === 'true';
    let session = mgr.restoreSession(req.params.sessionId);
    let created = false;

    if (!session) {
        if (createIfMissing) {
            session = mgr.createSession({ context: { started: true } });
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
    }
});

// POST /sessions/:id/turn/stream — SSE streaming turn
app.post(
    '/sessions/:sessionId/turn/stream',
    async (req: Request, res: Response) => {
        const mgr = getSessionMgr();
        const createIfMissing = req.query.create_if_missing === 'true';
        let session = mgr.restoreSession(req.params.sessionId);

        if (!session) {
            if (createIfMissing) {
                session = mgr.createSession({ context: { started: true } });
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

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const streamCallback = (chunk: string) => {
            res.write(`data: ${JSON.stringify({ type: 'delta', delta: chunk })}\n\n`);
        };

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

            res.write(
                `data: ${JSON.stringify({
                    type: 'done',
                    reply: result.lastAssistantText ?? '',
                    pending_approvals: [],
                })}\n\n`,
            );
        } catch (e: any) {
            logger.error(`turn_stream failed: ${e}`);
            res.write(
                `data: ${JSON.stringify({
                    type: 'error',
                    detail: String(e).slice(0, 500),
                })}\n\n`,
            );
        } finally {
            res.end();
        }
    },
);

export { app };

// Start server if run directly
if (require.main === module) {
    const port = parseInt(process.env.PORT ?? '8000', 10);
    initServer();
    app.listen(port, () => {
        logger.info(`Agent API server listening on port ${port}`);
    });
}
