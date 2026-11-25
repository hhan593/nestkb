/** fetch 流式 SSE 解析（EventSource 不支持 POST）：与后端 7.3-④ 事件协议一一对应 */
import type { CitationDto, RetrievalMetaDto, UsageDto } from './types';

export type QaEvent =
  | { event: 'meta'; data: { messageId: string; requestId: string; retrieval: RetrievalMetaDto } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citations'; data: { citations: CitationDto[] } }
  | { event: 'usage'; data: UsageDto }
  | { event: 'done'; data: { latencyMs: number; cached?: boolean } }
  | { event: 'error'; data: { code: string; message: string; retryable?: boolean; retrieval?: { hitCount: number } } };

export async function* parseSseStream(res: Response, signal?: AbortSignal): AsyncGenerator<QaEvent> {
  if (!res.ok || !res.body) {
    let message = `请求失败（${res.status}）`;
    let code = 'HTTP_ERROR';
    try {
      // 后端错误体形如 { code: 'RATE_LIMITED', message: '...' }：沿用真实 code，前端才能给出准确提示
      const body = (await res.json()) as { code?: string; message?: string };
      if (body.message) message = body.message;
      if (body.code) code = body.code;
    } catch {
      // 保留默认消息
    }
    yield { event: 'error', data: { code, message } };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = block.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event:'));
        const dataLine = lines.find((l) => l.startsWith('data:'));
        if (!eventLine || !dataLine) continue;
        try {
          const event = eventLine.slice(6).trim() as QaEvent['event'];
          const data = JSON.parse(dataLine.slice(5).trim());
          yield { event, data } as QaEvent;
        } catch {
          // 跳过残缺块
        }
      }
    }
  } catch (err) {
    if (!signal?.aborted) throw err;
  }
}
