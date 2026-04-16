// structured json line logger
// emits ndjson to stdout/stderr, supports child loggers for scoped context

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): Logger;
};

const LEVEL_VALUES: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

function resolveLevel(): LogLevel {
    const env = (typeof process !== 'undefined' && process.env?.GATHO_LOG_LEVEL) || '';
    const lower = env.toLowerCase();
    if (lower in LEVEL_VALUES) return lower as LogLevel;
    return 'info';
}

// serialize a value, handling Error instances that JSON.stringify turns into {}
function serializeValue(value: unknown): unknown {
    if (value instanceof Error) {
        return { message: value.message, stack: value.stack };
    }
    return value;
}

function buildLine(
    level: LogLevel,
    msg: string,
    context: Record<string, unknown>,
    fields: Record<string, unknown> | undefined,
): string {
    const entry: Record<string, unknown> = { ts: Date.now(), level, msg };

    for (const key in context) {
        entry[key] = serializeValue(context[key]);
    }

    if (fields) {
        for (const key in fields) {
            entry[key] = serializeValue(fields[key]);
        }
    }

    return JSON.stringify(entry);
}

function createLoggerInternal(minLevel: number, context: Record<string, unknown>): Logger {
    function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
        if (LEVEL_VALUES[level] < minLevel) return;

        const line = buildLine(level, msg, context, fields);

        if (level === 'error') {
            process.stderr.write(`${line}\n`);
        } else {
            process.stdout.write(`${line}\n`);
        }
    }

    return {
        debug: (msg, fields) => log('debug', msg, fields),
        info: (msg, fields) => log('info', msg, fields),
        warn: (msg, fields) => log('warn', msg, fields),
        error: (msg, fields) => log('error', msg, fields),
        child(fields: Record<string, unknown>): Logger {
            return createLoggerInternal(minLevel, { ...context, ...fields });
        },
    };
}

export function createLogger(options?: { level?: LogLevel }): Logger {
    const level = options?.level ?? resolveLevel();
    return createLoggerInternal(LEVEL_VALUES[level], {});
}

// module-scope singleton — reads GATHO_LOG_LEVEL at import time
export const log: Logger = createLogger();

// silent logger for tests — all methods are no-ops
export function createSilentLogger(): Logger {
    const noop = () => {};
    const logger: Logger = {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        child() {
            return logger;
        },
    };
    return logger;
}
