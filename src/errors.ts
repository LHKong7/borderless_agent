/**
 * errors.ts — Typed error hierarchy for the borderless-agent SDK.
 *
 * Provides structured errors for LLM calls, tool execution, validation,
 * and configuration. Each error carries a machine-readable `code` and
 * a static `isRetryable` helper for retry logic.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export class AgentError extends Error {
    readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = 'AgentError';
        this.code = code;
    }

    static isRetryable(_err: unknown): boolean {
        return false;
    }

    toJSON(): Record<string, unknown> {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            stack: this.stack,
        };
    }
}

// ---------------------------------------------------------------------------
// LLM errors
// ---------------------------------------------------------------------------

export class LLMError extends AgentError {
    constructor(message: string, code: string = 'LLM_ERROR') {
        super(message, code);
        this.name = 'LLMError';
    }

    static override isRetryable(err: unknown): boolean {
        return err instanceof RateLimitError;
    }
}

export class RateLimitError extends LLMError {
    readonly retryAfter: number;

    constructor(message: string, retryAfter: number = 0) {
        super(message, 'RATE_LIMIT');
        this.name = 'RateLimitError';
        this.retryAfter = retryAfter;
    }

    override toJSON(): Record<string, unknown> {
        return { ...super.toJSON(), retryAfter: this.retryAfter };
    }
}

export class AuthenticationError extends LLMError {
    constructor(message: string = 'Authentication failed') {
        super(message, 'AUTH_ERROR');
        this.name = 'AuthenticationError';
    }
}

export class ContextOverflowError extends LLMError {
    readonly tokenCount: number;
    readonly budget: number;

    constructor(tokenCount: number, budget: number) {
        super(
            `Context overflow: ${tokenCount} tokens exceeds budget of ${budget}`,
            'CONTEXT_OVERFLOW',
        );
        this.name = 'ContextOverflowError';
        this.tokenCount = tokenCount;
        this.budget = budget;
    }

    override toJSON(): Record<string, unknown> {
        return { ...super.toJSON(), tokenCount: this.tokenCount, budget: this.budget };
    }
}

// ---------------------------------------------------------------------------
// Tool errors
// ---------------------------------------------------------------------------

export class ToolError extends AgentError {
    readonly toolName: string;

    constructor(message: string, toolName: string, code: string = 'TOOL_ERROR') {
        super(message, code);
        this.name = 'ToolError';
        this.toolName = toolName;
    }

    override toJSON(): Record<string, unknown> {
        return { ...super.toJSON(), toolName: this.toolName };
    }
}

export class ToolTimeoutError extends ToolError {
    readonly timeoutMs: number;

    constructor(toolName: string, timeoutMs: number) {
        super(
            `Tool "${toolName}" timed out after ${timeoutMs}ms`,
            toolName,
            'TOOL_TIMEOUT',
        );
        this.name = 'ToolTimeoutError';
        this.timeoutMs = timeoutMs;
    }

    override toJSON(): Record<string, unknown> {
        return { ...super.toJSON(), timeoutMs: this.timeoutMs };
    }
}

export class ToolExecutionError extends ToolError {
    readonly cause: Error;

    constructor(toolName: string, cause: Error) {
        super(
            `Tool "${toolName}" failed: ${cause.message}`,
            toolName,
            'TOOL_EXECUTION',
        );
        this.name = 'ToolExecutionError';
        this.cause = cause;
    }

    override toJSON(): Record<string, unknown> {
        return {
            ...super.toJSON(),
            cause: {
                name: this.cause.name,
                message: this.cause.message,
            },
        };
    }
}

// ---------------------------------------------------------------------------
// Validation & configuration
// ---------------------------------------------------------------------------

export class ValidationError extends AgentError {
    constructor(message: string) {
        super(message, 'VALIDATION_ERROR');
        this.name = 'ValidationError';
    }
}

export class ConfigurationError extends AgentError {
    constructor(message: string) {
        super(message, 'CONFIGURATION_ERROR');
        this.name = 'ConfigurationError';
    }
}
