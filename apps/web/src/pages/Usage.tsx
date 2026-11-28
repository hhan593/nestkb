import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { fmtCost, fmtNum, type UsageSummary } from '../lib/types';

const DIMS = [
  { key: 'dept', label: '按部门' },
  { key: 'user', label: '按用户' },
  { key: 'day', label: '按天' },
  { key: 'scene', label: '按场景' },
] as const;

const SCENE_LABEL: Record<string, string> = {
  qa: '问答',
  ingest_embed: '摄取向量化',
  rerank: '重排',
  eval: '评估',
  summary: '会话摘要',
};

function monthRange(): [string, string] {
  // 用本地日期拼 yyyy-MM-dd，避免 toISOString 的 UTC 偏移把月初错位一天
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return [fmt(from), fmt(to)];
}

export default function Usage() {
  const [dim, setDim] = useState<(typeof DIMS)[number]['key']>('dept');
  const [from, to] = monthRange();
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // out-of-order 防护：快速切换筛选时，只有最后一次请求的结果允许写入
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setError(null);
    setLoading(true);
    try {
      const d = await api<UsageSummary>(`/admin/usage/summary?dim=${dim}&from=${fromDate}T00:00:00Z&to=${toDate}T23:59:59Z`);
      if (seq !== seqRef.current) return;
      setData(d);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [dim, fromDate, toDate]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">成本看板</h1>
            <p className="page-desc">usage_records 按 PRICE_JSON 折算（元）—— 每一次 LLM 调用都有归属</p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--panel)', borderRadius: 10, padding: 3 }}>
            {DIMS.map((d) => (
              <button
                key={d.key}
                className={`btn btn-sm${dim === d.key ? ' btn-primary' : ' btn-ghost'}`}
                onClick={() => setDim(d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <input className="input" type="date" style={{ width: 150 }} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <span style={{ color: 'var(--ink-3)' }}>→</span>
          <input className="input" type="date" style={{ width: 150 }} value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>

        {data?.alerts.map((a, i) => (
          <div key={i} className={`alert-banner alert-${a.level === 'critical' ? 'critical' : 'warn'}`}>
            <CircleAlert /> {a.message}
          </div>
        ))}

        {error && <div className="alert-banner alert-critical"><CircleAlert /> {error}</div>}

        {loading ? (
          <div className="spinner" style={{ margin: '60px auto' }} />
        ) : data === null || data.rows.length === 0 ? (
          <div className="card card-pad empty">所选时间范围内没有 usage 记录</div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{dim === 'dept' ? '部门' : dim === 'user' ? '用户' : dim === 'scene' ? '场景' : '日期'}</th>
                  <th>问答次数</th>
                  <th>Prompt tokens</th>
                  <th>Completion tokens</th>
                  <th>成本（元）</th>
                  <th>平均 / 次</th>
                  <th>P95 / 次</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 550 }}>{dim === 'scene' ? SCENE_LABEL[r.label] ?? r.label : r.label}</td>
                    <td className="num">{fmtNum(r.qaCalls)}</td>
                    <td className="num">{fmtNum(r.promptTokens)}</td>
                    <td className="num">{fmtNum(r.completionTokens)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtCost(r.costCny)}</td>
                    <td className="num">{fmtCost(r.avgCostPerQa)}</td>
                    <td className="num">{fmtCost(r.p95CostPerQa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
