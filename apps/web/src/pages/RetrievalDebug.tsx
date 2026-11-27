import { useState } from 'react';
import { CircleAlert, Search } from 'lucide-react';
import { api } from '../lib/api';
import { type DebugChunk, type DebugResult } from '../lib/types';

function ChunkRow({ c, score, scoreLabel, hot }: { c: DebugChunk; score: number; scoreLabel?: string; hot?: boolean }) {
  void scoreLabel;
  return (
    <div className="debug-row">
      <span className="citation-no" style={{ fontSize: 10 }}>{c.headingPath ? c.headingPath.split(' > ')[0].slice(0, 8) : '—'}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          《{c.title}》v{c.versionNo} · {c.headingPath || '（无章节）'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.preview}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
        <div className="score-bar"><div className={hot ? 'hot' : undefined} style={{ width: `${Math.min(100, score * 100)}%` }} /></div>
        <span className="num" style={{ fontSize: 12, color: hot ? 'var(--cinnabar)' : 'var(--ink-2)', minWidth: 58, textAlign: 'right' }}>
          {score.toFixed(4)}
        </span>
      </div>
    </div>
  );
}

export default function RetrievalDebug() {
  const [q, setQ] = useState('');
  const [deptId, setDeptId] = useState('');
  const [result, setResult] = useState<DebugResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      const path = `/admin/retrieval/debug?q=${encodeURIComponent(query)}${deptId.trim() ? `&deptId=${deptId.trim()}` : ''}`;
      setResult(await api<DebugResult>(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : '调试请求失败');
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map((result?.chunks ?? []).map((c) => [c.chunkId, c]));
  const list = (ids: Array<{ chunkId: string; score: number }>): DebugChunk[] =>
    ids.flatMap((i) => {
      const c = byId.get(i.chunkId);
      return c ? [{ ...c, score: i.score }] : [];
    });

  const b = result?.debug;
  const bd = b?.breakdown;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">检索调试</h1>
            <p className="page-desc">双路召回分数 · RRF 融合排名 · rerank 前后对比 · 分段延迟 —— 调参不靠感觉</p>
          </div>
        </div>

        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              className="input"
              placeholder="输入测试问题，如：差旅住宿标准中西部上限"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void run()}
            />
            <input
              className="input"
              style={{ width: 260, flex: 'none' }}
              placeholder="部门 ID（留空 = admin 全库）"
              value={deptId}
              onChange={(e) => setDeptId(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || !q.trim()} onClick={() => void run()}>
              <Search /> {busy ? '检索中…' : '调试'}
            </button>
          </div>
        </div>

        {error && <div className="alert-banner alert-critical"><CircleAlert /> {error}</div>}

        {result && (
          <>
            <div className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="stat-row" style={{ marginBottom: 12 }}>
                <div>
                  <div className="stat-num num">{result.retrieval.hitCount}</div>
                  <div className="stat-label">融合候选（hitCount）</div>
                </div>
                <div style={{ width: 32 }} />
                <div>
                  <div className="stat-num num">{b?.versionIdCount ?? 0}</div>
                  <div className="stat-label">可见当前版本数</div>
                </div>
                <div style={{ width: 32 }} />
                <div>
                  <div className="stat-num num">{result.retrieval.latencyMs}ms</div>
                  <div className="stat-label">检索总延迟</div>
                </div>
                <div style={{ width: 32 }} />
                <div>
                  <div className="stat-label" style={{ marginBottom: 4 }}>
                    rerank {result.retrieval.rerankDegraded ? <span className="badge badge-warn">已降级</span> : <span className="badge badge-ok">正常</span>}
                  </div>
                  <div className="breakdown">
                    {bd && (
                      <>
                        <span className="breakdown-item">embed <b>{bd.embedMs}ms</b></span>
                        <span className="breakdown-item">向量 <b>{bd.vectorMs}ms</b></span>
                        <span className="breakdown-item">FTS <b>{bd.ftsMs}ms</b></span>
                        <span className="breakdown-item">融合 <b>{bd.fuseMs}ms</b></span>
                        <span className="breakdown-item">rerank <b>{bd.rerankMs}ms</b></span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="debug-grid" style={{ marginBottom: 14 }}>
              <div className="card card-pad">
                <div className="debug-col-title"><span>向量召回（top10）</span><span>余弦相似</span></div>
                {list(b?.vectorTop ?? []).map((c, i) => (
                  <ChunkRow key={`v-${c.chunkId}-${i}`} c={c} score={c.score} scoreLabel="1 - cosine distance" />
                ))}
                {(b?.vectorTop.length ?? 0) === 0 && <div className="empty" style={{ padding: 16 }}>无召回</div>}
              </div>
              <div className="card card-pad">
                <div className="debug-col-title"><span>关键词召回 FTS（top10）</span><span>ts_rank / trgm</span></div>
                {list(b?.ftsTop ?? []).map((c, i) => (
                  <ChunkRow key={`f-${c.chunkId}-${i}`} c={c} score={c.score} scoreLabel="ts_rank 与 trigram 相似度取大" />
                ))}
                {(b?.ftsTop.length ?? 0) === 0 && <div className="empty" style={{ padding: 16 }}>无召回</div>}
              </div>
            </div>

            <div className="card card-pad">
              <div className="debug-col-title"><span>最终排序（rerank 后 top8）</span><span>{result.retrieval.rerankDegraded ? 'RRF 粗排序（降级）' : 'rerank 分'}</span></div>
              {result.chunks.map((c) => (
                <ChunkRow key={`r-${c.chunkId}`} c={c} score={c.score} hot />
              ))}
              {result.chunks.length === 0 && <div className="empty" style={{ padding: 16 }}>无候选 —— 权限过滤后为空或库为空</div>}
            </div>

            {result.chunks[0]?.debug && (
              <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 10 }}>
                示例分数链路（第 1 名）：<span className="mono">
                  vector={(result.chunks[0].debug!.vectorScore ?? 0).toFixed(4)} · fts={(result.chunks[0].debug!.ftsScore ?? 0).toFixed(4)} · rrf={result.chunks[0].debug!.rrfScore?.toFixed(4)} → rerank={result.chunks[0].debug!.rerankScore?.toFixed(4)}
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
