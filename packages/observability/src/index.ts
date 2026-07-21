import { randomUUID } from 'node:crypto';

export interface LogContext { correlationId?: string; [key: string]: unknown }
export interface TraceSpan { id: string; name: string; startedAt: string; endedAt?: string; attributes: Record<string, string> }

export class JsonLogger {
  constructor(private readonly sink: (line: string) => void = console.log) {}
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, context: LogContext = {}): void {
    this.sink(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context }));
  }
}

export class InMemoryTracer {
  readonly spans: TraceSpan[] = [];
  constructor(private readonly idGenerator: () => string = randomUUID, private readonly clock: () => string = () => new Date().toISOString()) {}
  start(name: string, attributes: Record<string, string> = {}): { end: () => void; span: TraceSpan } {
    const span: TraceSpan = { id: this.idGenerator(), name, startedAt: this.clock(), attributes };
    this.spans.push(span);
    return { span, end: () => { span.endedAt = this.clock(); } };
  }
}
