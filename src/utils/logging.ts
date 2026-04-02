export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLogLevel(value?: string): LogLevel {
  switch (value?.trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value.trim().toLowerCase() as LogLevel;
    default:
      return "debug";
  }
}

export function getConfiguredLogLevel(): LogLevel {
  return normalizeLogLevel(process.env.LOG_LEVEL);
}

export function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getConfiguredLogLevel()];
}

export function writeStructuredLog(payload: { level: LogLevel } & Record<string, unknown>): void {
  if (!shouldLog(payload.level)) {
    return;
  }
  process.stderr.write(JSON.stringify(payload) + "\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeArgs(args: unknown[]): Record<string, unknown> {
  if (args.length === 0) {
    return {};
  }

  if (args.length === 1) {
    const [first] = args;
    if (isPlainObject(first)) {
      return { metadata: first };
    }
    return { args: [first] };
  }

  const [first, ...rest] = args;
  if (isPlainObject(first)) {
    return { metadata: first, args: rest };
  }

  return { args };
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const logAtLevel = (level: LogLevel, message: string, ...args: unknown[]): void => {
    writeStructuredLog({
      level,
      timestamp: new Date().toISOString(),
      ...bindings,
      message,
      ...normalizeArgs(args),
    });
  };

  return {
    debug: (message: string, ...args: unknown[]) => logAtLevel("debug", message, ...args),
    info: (message: string, ...args: unknown[]) => logAtLevel("info", message, ...args),
    warn: (message: string, ...args: unknown[]) => logAtLevel("warn", message, ...args),
    error: (message: string, ...args: unknown[]) => logAtLevel("error", message, ...args),
    child: (childBindings: Record<string, unknown>) => createLogger({ ...bindings, ...childBindings }),
  };
}
