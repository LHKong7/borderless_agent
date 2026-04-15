/**
 * telemetry.ts — Lightweight tracing/logging/metrics primitives.
 *
 * Design goals:
 *   - **Zero required dependencies.** OpenTelemetry is intentionally *not*
 *     imported here so that the SDK stays small. An adapter that bridges
 *     `Telemetry` to `@opentelemetry/api` is trivially writable.
 *   - **No-op default.** `Telemetry.noop()` returns an instance whose
 *     methods do nothing, so call sites can unconditionally call
 *     `telemetry.startSpan(...)` without paying any cost when disabled.
 *   - **GenAI semantic conventions.** Helper methods follow the
 *     OpenTelemetry GenAI naming where applicable
 *     (`gen_ai.usage.input_tokens`, etc.).
 */

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

export type SpanStatus = 'ok' | 'error';

export interface SpanData {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    startTimeMs: number;
    endTimeMs?: number;
    durationMs?: number;
    status: SpanStatus;
    statusMessage?: string;
    attributes: Record<string, any>;
    events: { name: string; timestamp: number; attributes?: Record<string, any> }[];
}

export interface Span {
    readonly name: string;
    readonly traceId: string;
    readonly spanId: string;
    setAttribute(key: string, value: any): void;
    setAttributes(attrs: Record<string, any>): void;
    addEvent(name: string, attrs?: Record<string, any>): void;
    setStatus(status: SpanStatus, message?: string): void;
    end(): void;
    readonly data: SpanData;
}

class SpanImpl implements Span {
    public readonly data: SpanData;
    private _ended = false;
    constructor(
        data: SpanData,
        private readonly _onEnd: (data: SpanData) => void,
    ) {
        this.data = data;
    }
    get name() { return this.data.name; }
    get traceId() { return this.data.traceId; }
    get spanId() { return this.data.spanId; }

    setAttribute(key: string, value: any): void {
        if (this._ended) return;
        this.data.attributes[key] = value;
    }
    setAttributes(attrs: Record<string, any>): void {
        if (this._ended) return;
        Object.assign(this.data.attributes, attrs);
    }
    addEvent(name: string, attrs?: Record<string, any>): void {
        if (this._ended) return;
        this.data.events.push({ name, timestamp: Date.now(), attributes: attrs });
    }
    setStatus(status: SpanStatus, message?: string): void {
        if (this._ended) return;
        this.data.status = status;
        if (message) this.data.statusMessage = message;
    }
    end(): void {
        if (this._ended) return;
        this._ended = true;
        this.data.endTimeMs = Date.now();
        this.data.durationMs = this.data.endTimeMs - this.data.startTimeMs;
        this._onEnd(this.data);
    }
}

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    module: string;
    message: string;
    context?: Record<string, any>;
    traceId?: string;
    spanId?: string;
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

export interface TelemetryExporter {
    exportSpan?(span: SpanData): void;
    exportLog?(entry: LogEntry): void;
}

/** Pretty-prints spans/logs to stderr. Useful for development. */
export class ConsoleExporter implements TelemetryExporter {
    constructor(private readonly _verbose: boolean = false) {}
    exportSpan(span: SpanData): void {
        const status = span.status === 'error' ? 'ERR' : 'OK ';
        const line = `[span] ${status} ${span.name} ${span.durationMs}ms`;
        if (this._verbose) {
            // eslint-disable-next-line no-console
            console.error(line, JSON.stringify(span.attributes));
        } else {
            // eslint-disable-next-line no-console
            console.error(line);
        }
    }
    exportLog(entry: LogEntry): void {
        const ctx = entry.context && Object.keys(entry.context).length
            ? ' ' + JSON.stringify(entry.context)
            : '';
        // eslint-disable-next-line no-console
        console.error(`[${entry.level}] ${entry.module}: ${entry.message}${ctx}`);
    }
}

/** Buffers spans/logs in memory. Useful for tests and post-hoc inspection. */
export class MemoryExporter implements TelemetryExporter {
    readonly spans: SpanData[] = [];
    readonly logs: LogEntry[] = [];
    exportSpan(span: SpanData): void { this.spans.push(span); }
    exportLog(entry: LogEntry): void { this.logs.push(entry); }
    clear(): void { this.spans.length = 0; this.logs.length = 0; }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
    serviceName?: string;
    exporter?: TelemetryExporter;
    /** Minimum log level. Default: 'info'. */
    minLogLevel?: LogLevel;
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

let _idCounter = 0;
function genId(): string {
    _idCounter = (_idCounter + 1) & 0xffffffff;
    return `${Date.now().toString(36)}${_idCounter.toString(36).padStart(4, '0')}`;
}

export class Telemetry {
    public readonly serviceName: string;
    private readonly _exporter: TelemetryExporter | null;
    private readonly _minLogRank: number;
    private _activeStack: Span[] = [];

    constructor(config: TelemetryConfig = {}) {
        this.serviceName = config.serviceName ?? 'borderless-agent';
        this._exporter = config.exporter ?? null;
        this._minLogRank = LOG_LEVEL_RANK[config.minLogLevel ?? 'info'];
    }

    /** A telemetry instance whose methods are all no-ops. */
    static noop(): Telemetry {
        return new Telemetry();
    }

    /** Start a new span. Pass `parent` (or omit to use the top of the active stack). */
    startSpan(name: string, options: { parent?: Span; attributes?: Record<string, any> } = {}): Span {
        const parent = options.parent ?? this._activeStack[this._activeStack.length - 1];
        const traceId = parent?.traceId ?? genId();
        const spanId = genId();
        const data: SpanData = {
            name,
            traceId,
            spanId,
            parentSpanId: parent?.spanId,
            startTimeMs: Date.now(),
            status: 'ok',
            attributes: { 'service.name': this.serviceName, ...(options.attributes ?? {}) },
            events: [],
        };
        const span = new SpanImpl(data, (d) => {
            this._exporter?.exportSpan?.(d);
            // pop if it's on top of the stack
            const top = this._activeStack[this._activeStack.length - 1];
            if (top && top.spanId === spanId) this._activeStack.pop();
        });
        this._activeStack.push(span);
        return span;
    }

    /** Run `fn` inside a new span, ending it (and recording errors) automatically. */
    async withSpan<T>(
        name: string,
        fn: (span: Span) => Promise<T> | T,
        options: { attributes?: Record<string, any> } = {},
    ): Promise<T> {
        const span = this.startSpan(name, options);
        try {
            const result = await fn(span);
            return result;
        } catch (err: any) {
            span.setStatus('error', err?.message ?? String(err));
            span.setAttribute('error.name', err?.name ?? 'Error');
            throw err;
        } finally {
            span.end();
        }
    }

    /** Returns the current top-of-stack span, if any. */
    activeSpan(): Span | undefined {
        return this._activeStack[this._activeStack.length - 1];
    }

    // -- Structured logging --

    log(level: LogLevel, module: string, message: string, context?: Record<string, any>): void {
        if (LOG_LEVEL_RANK[level] < this._minLogRank) return;
        const active = this.activeSpan();
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            module,
            message,
            context,
            traceId: active?.traceId,
            spanId: active?.spanId,
        };
        this._exporter?.exportLog?.(entry);
    }
    debug(module: string, message: string, context?: Record<string, any>): void { this.log('debug', module, message, context); }
    info(module: string, message: string, context?: Record<string, any>): void { this.log('info', module, message, context); }
    warn(module: string, message: string, context?: Record<string, any>): void { this.log('warn', module, message, context); }
    error(module: string, message: string, context?: Record<string, any>): void { this.log('error', module, message, context); }

    // -- GenAI / agent-specific helpers --

    recordChat(span: Span, model: string, usage: { input?: number; output?: number; total?: number }, durationMs: number): void {
        span.setAttributes({
            'gen_ai.system': 'agent',
            'gen_ai.request.model': model,
            'gen_ai.usage.input_tokens': usage.input ?? 0,
            'gen_ai.usage.output_tokens': usage.output ?? 0,
            'gen_ai.usage.total_tokens': usage.total ?? ((usage.input ?? 0) + (usage.output ?? 0)),
            'llm.duration_ms': durationMs,
        });
    }

    recordToolCall(span: Span, toolName: string, durationMs: number, success: boolean, errorCode?: string): void {
        span.setAttributes({
            'agent.tool.name': toolName,
            'agent.tool.duration_ms': durationMs,
            'agent.tool.success': success,
        });
        if (!success) {
            span.setAttribute('agent.tool.error_code', errorCode ?? 'UNKNOWN');
            span.setStatus('error', errorCode ?? 'UNKNOWN');
        }
    }

    recordMemoryRetrieval(span: Span, retrievedCount: number, scores: number[]): void {
        const sum = scores.reduce((a, b) => a + b, 0);
        span.setAttributes({
            'agent.memory.retrieved_count': retrievedCount,
            'agent.memory.avg_score': scores.length ? sum / scores.length : 0,
            'agent.memory.max_score': scores.length ? Math.max(...scores) : 0,
        });
    }
}
