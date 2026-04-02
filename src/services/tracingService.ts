import { randomUUID } from "node:crypto";
import { TraceContext } from "../types";
import { createLogger, LogLevel } from "../utils/logging";

const log = createLogger();

export class TracingService {
  createTrace(tenantId: string, command: string): TraceContext {
    return {
      traceId: randomUUID(),
      spanId: randomUUID(),
      tenantId,
      command,
    };
  }

  log(
    trace: TraceContext,
    message: string,
    metadata?: Record<string, unknown>,
    level: LogLevel = "info",
  ): void {
    log
      .child({
        traceId: trace.traceId,
        spanId: trace.spanId,
        tenantId: trace.tenantId,
        command: trace.command,
      })
      [level](message, metadata ?? {});
  }

  debug(trace: TraceContext, message: string, metadata?: Record<string, unknown>): void {
    this.log(trace, message, metadata, "debug");
  }

  warn(trace: TraceContext, message: string, metadata?: Record<string, unknown>): void {
    this.log(trace, message, metadata, "warn");
  }

  error(trace: TraceContext, message: string, metadata?: Record<string, unknown>): void {
    this.log(trace, message, metadata, "error");
  }
}
