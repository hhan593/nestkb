import { Injectable } from '@nestjs/common';
import { TraceService } from '../trace/trace';

/** 带 requestId 的轻量日志：TraceId 在任意调用层可见（ALS） */
@Injectable()
export class AppLogger {
  constructor(private readonly trace: TraceService) {}

  private fmt(level: string, msg: string, meta?: unknown): string {
    const rid = this.trace.requestId ? ` [${this.trace.requestId.slice(0, 8)}]` : '';
    const m = meta === undefined ? '' : ` ${safeJson(meta)}`;
    return `${new Date().toISOString()} ${level}${rid} ${msg}${m}`;
  }

  log(msg: string, meta?: unknown): void {
    console.log(this.fmt('LOG', msg, meta));
  }

  warn(msg: string, meta?: unknown): void {
    console.warn(this.fmt('WARN', msg, meta));
  }

  error(msg: string, meta?: unknown): void {
    console.error(this.fmt('ERROR', msg, meta));
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
