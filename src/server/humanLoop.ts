/**
 * humanLoop.ts — Human-in-the-loop manager for server mode.
 *
 * When the agent calls `ask_user` during a streaming turn, the tool blocks
 * on a Promise. The pending question is published via SSE to the client.
 * The client submits their answer to POST /sessions/:id/answer, which
 * resolves the Promise and unblocks the agent loop.
 */

export interface PendingQuestion {
    sessionId: string;
    question: string;
    resolve: (answer: string) => void;
    createdAt: number;
    resolved: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class HumanLoopManager {
    private _pending = new Map<string, PendingQuestion>();

    /**
     * Block until the client answers or timeout.
     * Called from within the agent loop (tool execution).
     */
    ask(
        sessionId: string,
        question: string,
        timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ): Promise<string> {
        // Cancel any existing pending question for this session
        this.cancel(sessionId);

        return new Promise<string>((resolve) => {
            const pq: PendingQuestion = {
                sessionId,
                question,
                resolved: false,
                resolve: (answer: string) => {
                    if (pq.resolved) return;
                    pq.resolved = true;
                    clearTimeout(timer);
                    this._pending.delete(sessionId);
                    resolve(answer);
                },
                createdAt: Date.now(),
            };

            const timer = setTimeout(() => {
                if (pq.resolved) return;
                pq.resolved = true;
                this._pending.delete(sessionId);
                resolve('[Timeout] User did not respond within the time limit. Proceed with your best judgment.');
            }, timeoutMs);

            this._pending.set(sessionId, pq);
        });
    }

    /**
     * Submit the user's answer. Called from the /answer endpoint.
     * Returns true if a pending question was found and resolved.
     */
    answer(sessionId: string, answer: string): boolean {
        const pending = this._pending.get(sessionId);
        if (!pending || pending.resolved) return false;
        pending.resolve(answer || '(User provided no response)');
        return true;
    }

    /** Get the current pending question for a session (if any). */
    getPending(sessionId: string): PendingQuestion | undefined {
        return this._pending.get(sessionId);
    }

    /** Cancel a pending question (e.g. on client disconnect). */
    cancel(sessionId: string): void {
        const pending = this._pending.get(sessionId);
        if (pending) {
            pending.resolve('[Cancelled] Human input request was cancelled. Proceed with your best judgment.');
            this._pending.delete(sessionId);
        }
    }
}

/** Singleton instance used by the server. */
export const humanLoopManager = new HumanLoopManager();
