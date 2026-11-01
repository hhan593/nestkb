import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
      const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '{}';
      return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
    });
}

export function unwrap(body: { code: number; data: unknown }): unknown {
  return body.data;
}

/** supertest 必须指向 fastify 自管 listen 出的端口（裸 server.listen 绕过 fastify 生命周期会触发内部 hook 崩溃） */
export function baseUrlOf(app: INestApplication): string {
  const addr = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

export async function login(app: string, email: string, password = 'Passw0rd!123'): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password }).expect(201);
  return (unwrap(res.body) as { accessToken: string }).accessToken as string;
}

export interface UploadedDoc {
  documentId: string;
  versionId: string;
  versionNo: number;
}

export async function uploadDoc(
  app: string,
  token: string,
  opts: { title: string; accessLevel?: string; content: string; filename?: string },
): Promise<UploadedDoc> {
  const res = await request(app)
    .post('/documents')
    .set('Authorization', `Bearer ${token}`)
    .field('title', opts.title)
    .field('accessLevel', opts.accessLevel ?? 'company')
    .attach('file', Buffer.from(opts.content, 'utf8'), {
      filename: opts.filename ?? 'doc.md',
      contentType: 'text/markdown',
    })
    .expect(202);
  return unwrap(res.body) as UploadedDoc;
}

export async function waitForIngestion(app: string, token: string, documentId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stage = 'queued';
  while (Date.now() < deadline) {
    const res = await request(app).get(`/documents/${documentId}/ingestion`).set('Authorization', `Bearer ${token}`);
    stage = String((res.body?.data as { stage?: string } | undefined)?.stage ?? 'unknown');
    if (stage === 'ready' || stage === 'failed') return stage;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`ingestion timeout: stage=${stage}`);
}

export async function ask(app: string, token: string, conversationId: string, question: string): Promise<SseEvent[]> {
  const res = await request(app)
    .post(`/qa/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`)
    .send({ question })
    .expect(200);
  return parseSse(res.text);
}
