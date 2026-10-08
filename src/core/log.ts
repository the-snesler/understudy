export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keeps the most recent entries in memory for the web UI. */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly capacity = 500) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  /** Newest first, optionally filtered to one scope. */
  recent(limit = 100, scope?: string): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i]!;
      if (!scope || e.scope === scope) out.push(e);
    }
    return out;
  }
}

export class Logger {
  constructor(
    private readonly buffer: LogBuffer,
    private readonly scope = 'app',
    private readonly minLevel: LogLevel = 'info',
  ) {}

  child(scope: string): Logger {
    return new Logger(this.buffer, scope, this.minLevel);
  }

  debug(message: string): void {
    this.write('debug', message);
  }
  info(message: string): void {
    this.write('info', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
  }

  private write(level: LogLevel, message: string): void {
    if (RANK[level] < RANK[this.minLevel]) return;
    const entry: LogEntry = { at: Date.now(), level, scope: this.scope, message };
    this.buffer.push(entry);
    const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
