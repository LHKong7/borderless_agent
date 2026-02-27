/**
 * config.ts - Shared configuration for the agentic system.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { OpenAIProvider } from './llmProtocol';

dotenv.config({ override: true });

// Logging: AGENT_VERBOSE=1 or true => DEBUG, else INFO
const _verbose = ['1', 'true', 'yes'].includes(
    (process.env.AGENT_VERBOSE ?? '').trim().toLowerCase(),
);
export const LOG_LEVEL: string = _verbose ? 'debug' : 'info';

/**
 * Simple logger matching the Python agent logger behavior.
 */
export const logger = {
    level: LOG_LEVEL,
    debug(...args: any[]) {
        if (this.level === 'debug') console.debug(...args);
    },
    info(...args: any[]) {
        console.log(...args);
    },
    warning(...args: any[]) {
        console.warn(...args);
    },
    error(...args: any[]) {
        console.error(...args);
    },
};

export const slog = {
    debug(...args: any[]) {
        if (LOG_LEVEL === 'debug') {
            const ts = new Date().toISOString().slice(11, 19);
            console.debug(`[${ts}]`, ...args);
        }
    },
};

export function setupAgentLogging(): void {
    // In Node.js the console is always available; this is a no-op placeholder
    // matching the Python setup_agent_logging().
}

// Workspace and skills directory
export const WORKDIR = process.cwd();
export const SKILLS_DIR = path.join(WORKDIR, 'skills');

// API timeout in seconds (per-request)
export const API_TIMEOUT: number = parseFloat(
    process.env.AGENT_API_TIMEOUT ?? '120',
);

// Stream LLM output token-by-token
export function streamEnabled(): boolean {
    return ['1', 'true', 'yes'].includes(
        (process.env.AGENT_STREAM ?? '').trim().toLowerCase(),
    );
}

// OpenAI model
export const MODEL: string = process.env.MODEL_ID ?? 'gpt-4o';

// Default LLM provider
export const defaultLlmProvider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY ?? 'sk-placeholder',
    model: MODEL,
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
    timeout: API_TIMEOUT,
});
