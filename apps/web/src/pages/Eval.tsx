import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, FlaskConical, Play } from 'lucide-react';
import { api } from '../lib/api';
import { fmtCost, fmtTime, type EvalRun } from '../lib/types';

const METRIC_TARGETS: Array<{ key: keyof EvalRun; label: string; target: number; fmt: (v: number | null) => string }> = [
  { key: 'recallAt5', label: 'Recall@5', target: 0.85, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
  { key: 'fidelity', label: '忠实度', target: 0.8, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
  { key: 'citationAcc', label: '引用准确率', target: 0.9, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
  { key: 'relevance', label: '答案相关性', target: 0.75, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
];

export default function Eval() {
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await api<EvalRun[]>('/admin/eval/runs'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trigger = useCallback(
    async (triggeredBy: string) => {
      setBusy(true);
      setError(null);
      try {
        await api('/admin/eval/runs', { body: { triggeredBy } });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : '评估执行失败');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const latest = runs?.[0];

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">评估回归</h1>
            <p className="page-desc">prompt / 模型 / 检索参数每次变更都必须跑回归 —— eval_runs 是效果账本</p>
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void trigger('manual')}>
            <Play /> {busy ? '评估执行中（约几十秒）…' : '触发回归'}
          </button>
        </div>

        {error && <div className="alert-banner alert-critical"><CircleAlert /> {error}</div>}

        {latest && (
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <FlaskConical style={{ width: 15, height: 15, color: 'var(--cinnabar)' }} />
              <b style={{ fontSize: 14 }}>最新一轮 · {latest.datasetVersion}</b>
              <span className="badge badge-neutral">{latest.triggeredBy}</span>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{fmtTime(latest.createdAt)} · {latest.totalCases} 用例</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {METRIC_TARGETS.map((m) => {
                const v = latest[m.key] as number | null;
                const pass = v !== null && v >= m.target;
                return (
                  <div key={String(m.key)} style={{ padding: '10px 14px', background: 'var(--bg)', borderRadius: 10 }}>
                    <div className="stat-label" style={{ marginBottom: 4 }}>{m.label}（目标 ≥{m.target}）</div>
                    <div className="stat-num num" style={{ color: pass ? 'var(--ok)' : 'var(--warn)' }}>{m.fmt(v)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 12, fontSize: 13, color: 'var(--ink-2)' }}>
              <span>平均成本 <b className="num">{fmtCost(latest.avgCost)}</b> 元/用例</span>
              <span>平均延迟 <b className="num">{latest.avgLatencyMs ?? '—'}</b> ms</span>
            </div>
          </div>
        )}

        {runs === null && !error ? (
          <div className="spinner" style={{ margin: '60px auto' }} />
        ) : runs && runs.length === 0 ? (
          <div className="card card-pad empty">
            <FlaskConical />
            <div className="empty-title">还没有评估记录</div>
            <div>先运行 pnpm seed 生成评测集，再点右上角「触发回归」。</div>
          </div>
        ) : runs ? (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>数据集</th>
                  <th>触发</th>
                  <th>Recall@5</th>
                  <th>忠实度</th>
                  <th>引用准确率</th>
                  <th>相关性</th>
                  <th>成本/用例</th>
                  <th>延迟</th>
                  <th>用例</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12 }}>{fmtTime(r.createdAt)}</td>
                    <td>{r.datasetVersion}</td>
                    <td><span className="badge badge-neutral">{r.triggeredBy}</span></td>
                    <td className="num">{r.recallAt5?.toFixed(4) ?? '—'}</td>
                    <td className="num">{r.fidelity?.toFixed(4) ?? '—'}</td>
                    <td className="num">{r.citationAcc?.toFixed(4) ?? '—'}</td>
                    <td className="num">{r.relevance?.toFixed(4) ?? '—'}</td>
                    <td className="num">{fmtCost(r.avgCost)}</td>
                    <td className="num">{r.avgLatencyMs ?? '—'}ms</td>
                    <td className="num">{r.totalCases}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
