/**
 * 50 并发问答压测（计划书 W6 / E4）：autocannon 或内置 http 压测。
 * 用法：先起 api（:5050 或 PORT），然后
 *   pnpm seed && pnpm seed:docs && 起 worker
 *   node scripts/loadtest.js --url http://localhost:5050 --users 50 --duration 20
 * 无 autocannon 时退化为内置压测循环；mock provider 下主要验证管线吞吐与错误率。
 */
const http = require('node:http');

// keep-alive 连接池：每请求新建连接会耗尽临时端口（TIME_WAIT），与真实浏览器行为不符
const agent = new http.Agent({ keepAlive: true, maxSockets: Number(process.env.LT_MAX_SOCKETS || 64) });

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
// 默认 127.0.0.1：localhost 可能解析为 ::1 而 api 监听 0.0.0.0（IPv4），http.request 不做回退
const URL_BASE = args.url || `http://127.0.0.1:${process.env.PORT || 5050}`;
const CONCURRENCY = Number(args.users || 50);
const DURATION = Number(args.duration || 20);

const EMAIL = args.email || 'alice@a-dept.com';
const PASSWORD = args.password || 'Passw0rd!123';
const QUESTION = args.question || '员工试用期考核不通过怎么处理？';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

/**
 * 预扣配额（quota:res NX）按设计将单用户并发问答串行化 —— E4 的"50 并发"
 * 应理解为 50 个不同员工。--accounts N（默认 = 并发数）轮换压测账号。
 */
async function ensureAccounts(n) {
  const dept = await prisma.department.findFirstOrThrow({ where: { name: '研发部' } });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const email = `lt-${i}@loadtest.io`;
    await prisma.user.upsert({
      where: { email },
      update: { passwordHash: hash },
      create: { email, passwordHash: hash, departmentId: dept.id },
    });
    accounts.push(email);
  }
  return accounts;
}

async function login(email) {
  const res = await fetch(`${URL_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`login failed: ${body.message}`);
  return body.data.accessToken;
}

/** 单次问答（SSE 完整消费，计一次成功/失败） */
const firstError = { code: '', seen: false };
async function askOnce(token) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request(
      `${URL_BASE}/qa/conversations`,
      { method: 'POST', agent, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            if (!firstError.seen && res.statusCode !== 201 && res.statusCode !== 200) {
              firstError.code = `${res.statusCode} ${raw.slice(0, 120)}`;
              firstError.seen = true;
            }
            const convId = JSON.parse(raw).data.id;
            const req2 = http.request(
              `${URL_BASE}/qa/conversations/${convId}/messages`,
              { method: 'POST', agent, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } },
              (res2) => {
                let done = false;
                res2.on('data', (c) => {
                  if (String(c).includes('event: done')) done = true;
                });
                res2.on('end', () => resolve({ ok: done, ms: Date.now() - started }));
              },
            );
            req2.on('error', (e) => {
              if (!firstError.seen) { firstError.code = `ask-conn: ${e.code}`; firstError.seen = true; }
              resolve({ ok: false, ms: Date.now() - started });
            });
            req2.end(JSON.stringify({ question: QUESTION }));
          } catch {
            resolve({ ok: false, ms: Date.now() - started });
          }
        });
      },
    );
    req.on('error', (e) => {
      if (!firstError.seen) { firstError.code = `conv-conn: ${e.code}`; firstError.seen = true; }
      resolve({ ok: false, ms: Date.now() - started });
    });
    req.end(JSON.stringify({}));
  });
}

async function main() {
  const accountCount = Number(args.accounts || CONCURRENCY);
  const emails = await ensureAccounts(accountCount);
  const tokens = [];
  for (const email of emails) tokens.push(await login(email));
  console.log(`loadtest: ${CONCURRENCY} 并发（${emails.length} 账号轮换）× ${DURATION}s → ${URL_BASE}`);
  const stats = { ok: 0, fail: 0, latencies: [] };
  const deadline = Date.now() + DURATION * 1000;
  let cursor = 0;
  // 模拟真实使用节奏：每个"员工"提问后停顿 INTERVAL（默认 500ms）—— E4 语义是 50 人同时用而非洪泛
  const interval = Number(args.interval || 500);
  const workers = Array.from({ length: CONCURRENCY }, async (_, w) => {
    // 错峰启动，避免瞬时 SYN 洪峰
    await new Promise((r2) => setTimeout(r2, w * 20));
    while (Date.now() < deadline) {
      const token = tokens[cursor++ % tokens.length];
      const r = await askOnce(token);
      stats[r.ok ? 'ok' : 'fail']++;
      stats.latencies.push(r.ms);
      await new Promise((r2) => setTimeout(r2, interval));
    }
  });
  await Promise.all(workers);
  await prisma.$disconnect();

  const lat = stats.latencies.sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.floor(lat.length * q)] : 0);
  const total = stats.ok + stats.fail;
  console.log(`总计 ${total} 次问答：成功 ${stats.ok}，失败 ${stats.fail}（错误率 ${(total ? (stats.fail / total) * 100 : 0).toFixed(2)}%）`);
  console.log(`延迟 P50=${p(0.5)}ms P95=${p(0.95)}ms P99=${p(0.99)}ms`);
  if (stats.fail) console.log(`首个失败样例: ${firstError.code || '(连接层错误，未到 HTTP)'}`);
  const errRate = total ? (stats.fail / total) * 100 : 0;
  console.log(errRate < 1 ? '✓ 错误率 <1%，达到 E4 门槛' : `✗ 错误率 ≥1%，未达 E4 门槛`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
