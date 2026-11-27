import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { AuthedUser } from '../auth/auth.service';
import { QaController } from './qa.controller';
import type { QaStreamSink } from './qa.service';

const user: AuthedUser = { userId: 'u-1', email: 'u@a-dept.com', role: 'member', deptId: 'd-1' };
const dto = { question: '你好' } as never;

/** keep-alive 下 socket 会被复用，监听器数量是这里唯一能观测到的泄漏指标 */
function makeHttp(socket = new EventEmitter()) {
  const rawReq = new EventEmitter() as EventEmitter & { aborted?: boolean };
  const rawRes = {
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  };
  const req = { raw: rawReq, socket } as never;
  const res = { raw: rawRes } as never;
  return { req, res, rawReq, socket, rawRes };
}

function makeController(askImpl: (opts: { sink: QaStreamSink }) => Promise<void>) {
  const qa = { ask: vi.fn(askImpl) };
  const trace = { requestId: 'req-1', newRequestId: () => 'req-2' };
  return { controller: new QaController(qa as never, trace as never), qa };
}

const openAndDone = async ({ sink }: { sink: QaStreamSink }) => {
  sink.open({
    messageId: 'm-1',
    requestId: 'req-1',
    retrieval: { topK: 8, hitCount: 0, rerankDegraded: false, latencyMs: 3 },
  });
  sink.delta('你好');
  sink.done({ latencyMs: 5 });
};

describe('QaController.ask —— 响应归属（#27）', () => {
  it('未开流就抛 404 时不得抢先 end：响应体留给全局过滤器', async () => {
    const { controller } = makeController(async () => {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '会话不存在' });
    });
    const { req, res, rawRes } = makeHttp();

    await expect(controller.ask(req, res, user, 'c-x', dto)).rejects.toBeInstanceOf(NotFoundException);

    expect(rawRes.end).not.toHaveBeenCalled();
    expect(rawRes.writeHead).not.toHaveBeenCalled();
  });

  it('已开流时由自己收尾（end 恰好一次）', async () => {
    const { controller } = makeController(openAndDone);
    const { req, res, rawRes } = makeHttp();

    await controller.ask(req, res, user, 'c-1', dto);

    expect(rawRes.writeHead).toHaveBeenCalledTimes(1);
    expect(rawRes.end).toHaveBeenCalledTimes(1);
  });

  it('已开流后上游异常：写 error 事件并结束，不冒泡给过滤器', async () => {
    const { controller } = makeController(async ({ sink }) => {
      sink.open({
        messageId: 'm-1',
        requestId: 'req-1',
        retrieval: { topK: 8, hitCount: 0, rerankDegraded: false, latencyMs: 1 },
      });
      throw new Error('boom');
    });
    const { req, res, rawRes } = makeHttp();

    await controller.ask(req, res, user, 'c-1', dto);

    const payload = rawRes.write.mock.calls.map((c) => String(c[0])).join('');
    expect(payload).toContain('event: error');
    expect(rawRes.end).toHaveBeenCalledTimes(1);
  });
});

describe('QaController.ask —— 监听器不泄漏（#27）', () => {
  it('连续 50 次问答后 socket 的 close 监听器数不增长', async () => {
    const { controller } = makeController(openAndDone);
    const socket = new EventEmitter(); // 同一条 keep-alive 连接
    for (let i = 0; i < 50; i++) {
      const { req, res } = makeHttp(socket);
      await controller.ask(req, res, user, 'c-1', dto);
      expect(socket.listenerCount('close')).toBe(0); // 每个请求结束即摘除
    }
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('异常路径同样摘除监听器', async () => {
    const { controller } = makeController(async () => {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '会话不存在' });
    });
    const { req, res, rawReq, socket } = makeHttp();

    await expect(controller.ask(req, res, user, 'c-x', dto)).rejects.toBeInstanceOf(NotFoundException);

    expect(rawReq.listenerCount('close')).toBe(0);
    expect(rawReq.listenerCount('aborted')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
  });
});
