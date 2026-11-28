import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { QaSseEvent } from '@lib/contracts';
import { TraceService } from '@app/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthedUser } from '../auth/auth.service';
import { AskDto, CreateConversationDto, RenameConversationDto } from './dto';
import { QaRateLimitGuard } from './qa-rate-limit.guard';
import { QaService, QaStreamSink } from './qa.service';

/**
 * 问答（SSE 流式，计划书 7.3-④）：
 * 事件顺序固定 meta→delta*→citations→usage→done；error 事件之后流终止。
 * 客户端断开 → req close → AbortController → 上游 LlmModule 取消 → 部分结算。
 */
@Controller('qa')
export class QaController {
  constructor(
    private readonly qa: QaService,
    private readonly trace: TraceService,
  ) {}

  @Post('conversations')
  async create(@CurrentUser() user: AuthedUser, @Body() dto?: CreateConversationDto) {
    return this.qa.createConversation(user, dto?.title);
  }

  @Get('conversations')
  async list(@CurrentUser() user: AuthedUser) {
    return this.qa.listConversations(user);
  }

  @Get('conversations/:id')
  async detail(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.qa.getConversation(user, id);
  }

  @Patch('conversations/:id')
  async rename(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: RenameConversationDto) {
    return this.qa.renameConversation(user, id, dto.title);
  }

  @Delete('conversations/:id')
  async remove(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    await this.qa.deleteConversation(user, id);
    return { deleted: true };
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.OK)
  // 限流只挂提问：会话列表/详情是纯读操作，不应消耗提问配额（否则每次发消息后的列表刷新都在扣额度）
  @UseGuards(QaRateLimitGuard)
  async ask(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @CurrentUser() user: AuthedUser,
    @Param('id') conversationId: string,
    @Body() dto: AskDto,
  ): Promise<void> {
    const requestId = this.trace.requestId || this.trace.newRequestId();
    const abort = new AbortController();
    let closed = false;
    // 客户端断开检测：IncomingMessage 的 close 在 Node16+ 语义多变，socket 级 + aborted 双保险
    const onDisconnect = (): void => {
      if (!res.raw.writableEnded && !closed) {
        closed = true;
        abort.abort();
      }
    };
    req.raw.on('close', onDisconnect);
    req.raw.on('aborted', onDisconnect);
    req.socket.on('close', onDisconnect);
    // keep-alive 会复用同一个 socket：不摘监听器的话每次提问都往 socket 上叠 3 个，
    // 后续请求断开时可能连带 abort 早已结束的旧请求（#27）
    const detachDisconnectListeners = (): void => {
      req.raw.off('close', onDisconnect);
      req.raw.off('aborted', onDisconnect);
      req.socket.off('close', onDisconnect);
    };

    let metaSent = false;
    const write = (ev: QaSseEvent): void => {
      if (closed || res.raw.writableEnded) return;
      res.raw.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    };
    const sink: QaStreamSink = {
      open: (meta) => {
        // 客户端已断就别再写头：向已关闭的连接 writeHead 只会留下无意义的错误栈
        if (metaSent || closed || res.raw.writableEnded) return;
        metaSent = true;
        res.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'x-rerank-degraded': String(meta.retrieval.rerankDegraded),
        });
        write({ event: 'meta', data: meta });
      },
      delta: (text) => write({ event: 'delta', data: { text } }),
      citations: (list) => write({ event: 'citations', data: { citations: list } }),
      usage: (u) => write({ event: 'usage', data: u }),
      done: (d) => write({ event: 'done', data: d }),
      error: (d) => write({ event: 'error', data: d }),
    };

    /** 未开流就抛语义化异常：响应体交给全局过滤器，本方法不得抢先 end（否则客户端拿到空响应） */
    let delegateToFilter = false;

    try {
      await this.qa.ask({
        conversationId,
        user,
        question: dto.question,
        topK: dto.topK,
        mode: dto.mode,
        requestId,
        signal: abort.signal,
        sink,
      });
    } catch (err) {
      // 尚未开流且是语义化异常（404 会话不存在 / 429 限流等）：保留原状态码交给全局过滤器，
      // 不再一律吞成 200 + UPSTREAM_ERROR
      if (!metaSent && err instanceof HttpException) {
        delegateToFilter = true;
        throw err;
      }
      // 已开流的兜底：确保客户端总能收到终止事件
      sink.open({
        messageId: '',
        requestId,
        retrieval: { topK: 0, hitCount: 0, rerankDegraded: false, latencyMs: 0 },
      });
      sink.error({ code: 'UPSTREAM_ERROR', message: '服务内部错误', retryable: true });
      void err;
    } finally {
      detachDisconnectListeners();
      // 交给过滤器时不要 end：fastify 的 reply.sent 就是 raw.writableEnded，
      // 一旦 end 过滤器会认为"已响应"而跳过，404 就退化成空 body
      if (!delegateToFilter) res.raw.end();
    }
  }
}
