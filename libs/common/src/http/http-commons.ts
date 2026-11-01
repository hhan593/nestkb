import {
  BadRequestException,
  Catch,
  CallHandler,
  ExecutionContext,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  PipeTransform,
  SetMetadata,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCodes } from '@lib/contracts';
import { TraceService } from '../trace/trace';

// ============ 统一响应包裹 { code, data, requestId }（计划书 7.1） ============

export const SKIP_WRAP_KEY = 'skipResponseWrap';
/** SSE 等自管响应的路由打此标记，跳过统一包裹 */
export const SkipResponseWrap = () => SetMetadata(SKIP_WRAP_KEY, true);

@Injectable()
export class ResponseWrapInterceptor implements NestInterceptor {
  constructor(private readonly trace: TraceService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    const skip = Reflect.getMetadata(SKIP_WRAP_KEY, ctx.getHandler()) || Reflect.getMetadata(SKIP_WRAP_KEY, ctx.getClass());
    if (skip || (request as { skipResponseWrap?: boolean }).skipResponseWrap) return next.handle();
    return next.handle().pipe(
      map((data) => {
        const reply = ctx.switchToHttp().getResponse<FastifyReply>();
        if (reply.sent) return data; // SSE 等流式响应已自行写出
        return { code: 0, data: data ?? null, requestId: this.trace.requestId };
      }),
    );
  }
}

// ============ 统一异常出口 ============

function statusToCode(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED: return ErrorCodes.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN: return ErrorCodes.FORBIDDEN;
    case HttpStatus.NOT_FOUND: return ErrorCodes.NOT_FOUND;
    case HttpStatus.TOO_MANY_REQUESTS: return ErrorCodes.RATE_LIMITED;
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY: return ErrorCodes.VALIDATION_FAILED;
    default: return ErrorCodes.INTERNAL_ERROR;
  }
}

function extractErrorBody(exception: HttpException): { code?: string; message?: string | string[] } {
  const res = exception.getResponse();
  if (typeof res === 'string') return { message: res };
  if (typeof res === 'object' && res !== null) return res as { code?: string; message?: string | string[] };
  return {};
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly trace: TraceService) {}

  catch(exception: unknown, host: ExecutionContext): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    if (reply.sent) return;

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let code = statusToCode(status);
    let message = 'Internal server error';
    if (exception instanceof HttpException) {
      const body = extractErrorBody(exception);
      code = body.code ?? code;
      message = Array.isArray(body.message) ? body.message.join('; ') : body.message ?? exception.message;
    }
    const rid = this.trace.requestId;
    console.error(
      `${new Date().toISOString()} ERROR${rid ? ` [${rid.slice(0, 8)}]` : ''} ${request.method} ${request.url} -> ${status} ${code}: ${message}`,
      exception instanceof Error && status >= 500 ? exception.stack : '',
    );
    const payload = { code, message, requestId: rid };
    // 中间件上下文拿到的是原生 ServerResponse（无 .status 方法），路由上下文是 FastifyReply
    if (typeof (reply as { status?: unknown }).status === 'function') {
      void (reply as FastifyReply).status(status).send(payload); // 对象走 fastify 序列化，content-type 正确
    } else {
      const raw = reply as unknown as { statusCode: number; writableEnded?: boolean; setHeader(n: string, v: string): void; end(b: string): void };
      if (!raw.writableEnded) {
        raw.statusCode = status;
        raw.setHeader('content-type', 'application/json');
        raw.end(JSON.stringify(payload));
      }
    }
  }
}

// ============ 语义化异常 ============

export class QuotaExceededException extends HttpException {
  constructor(deptId: string, usedCny: number, quotaCny: number) {
    super(
      { code: ErrorCodes.QUOTA_EXCEEDED, message: `本部门月度配额已用尽（已用 ${usedCny.toFixed(2)}/${quotaCny} 元），已降级为只读检索` },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    void deptId;
  }
}

export class RateLimitedException extends HttpException {
  constructor(message = '请求过于频繁，请稍后再试') {
    super({ code: ErrorCodes.RATE_LIMITED, message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

// ============ 数值类 DTO 清洗（string -> number 等），配合全局 ValidationPipe ============

@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value === 'string') return value.trim();
    return value;
  }
}

export function ensure(condition: boolean, status: HttpStatus, code: string, message: string): void {
  if (!condition) throw new HttpException({ code, message }, status);
}

export function badRequest(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message });
}
