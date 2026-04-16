export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): Logger;
};
export declare function createLogger(options?: {
    level?: LogLevel;
}): Logger;
export declare const log: Logger;
export declare function createSilentLogger(): Logger;
