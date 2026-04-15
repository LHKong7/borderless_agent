import { describe, it, expect } from 'vitest';
import {
    AgentError,
    LLMError,
    RateLimitError,
    AuthenticationError,
    ContextOverflowError,
    ToolError,
    ToolTimeoutError,
    ToolExecutionError,
    ValidationError,
    ConfigurationError,
} from '../../src/errors';

describe('AgentError', () => {
    it('has code and message', () => {
        const err = new AgentError('boom', 'TEST_CODE');
        expect(err.message).toBe('boom');
        expect(err.code).toBe('TEST_CODE');
        expect(err.name).toBe('AgentError');
        expect(err).toBeInstanceOf(Error);
    });

    it('serializes to JSON', () => {
        const err = new AgentError('boom', 'TEST');
        const json = err.toJSON();
        expect(json.code).toBe('TEST');
        expect(json.message).toBe('boom');
        expect(json.name).toBe('AgentError');
    });

    it('isRetryable returns false by default', () => {
        expect(AgentError.isRetryable(new AgentError('x', 'y'))).toBe(false);
    });
});

describe('LLMError hierarchy', () => {
    it('RateLimitError is retryable', () => {
        const err = new RateLimitError('rate limited', 5);
        expect(err.retryAfter).toBe(5);
        expect(err.code).toBe('RATE_LIMIT');
        expect(err).toBeInstanceOf(LLMError);
        expect(err).toBeInstanceOf(AgentError);
        expect(LLMError.isRetryable(err)).toBe(true);
    });

    it('AuthenticationError is not retryable', () => {
        const err = new AuthenticationError();
        expect(err.code).toBe('AUTH_ERROR');
        expect(LLMError.isRetryable(err)).toBe(false);
    });

    it('ContextOverflowError carries token info', () => {
        const err = new ContextOverflowError(150_000, 128_000);
        expect(err.tokenCount).toBe(150_000);
        expect(err.budget).toBe(128_000);
        expect(err.code).toBe('CONTEXT_OVERFLOW');
        const json = err.toJSON();
        expect(json.tokenCount).toBe(150_000);
        expect(json.budget).toBe(128_000);
    });
});

describe('ToolError hierarchy', () => {
    it('ToolTimeoutError carries tool name and timeout', () => {
        const err = new ToolTimeoutError('search_docs', 30_000);
        expect(err.toolName).toBe('search_docs');
        expect(err.timeoutMs).toBe(30_000);
        expect(err.code).toBe('TOOL_TIMEOUT');
        expect(err).toBeInstanceOf(ToolError);
    });

    it('ToolExecutionError wraps a cause', () => {
        const cause = new TypeError('null reference');
        const err = new ToolExecutionError('my_tool', cause);
        expect(err.toolName).toBe('my_tool');
        expect(err.cause).toBe(cause);
        expect(err.code).toBe('TOOL_EXECUTION');
        const json = err.toJSON();
        expect((json.cause as any).message).toBe('null reference');
    });
});

describe('Validation and Configuration errors', () => {
    it('ValidationError', () => {
        const err = new ValidationError('bad input');
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err).toBeInstanceOf(AgentError);
    });

    it('ConfigurationError', () => {
        const err = new ConfigurationError('missing key');
        expect(err.code).toBe('CONFIGURATION_ERROR');
        expect(err).toBeInstanceOf(AgentError);
    });
});
