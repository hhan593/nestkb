import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, FlaskConical, Play, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { fmtCost, fmtTime, type EvalRun } from '../lib/types';

const METRIC_TARGETS: Array<{ key: keyof EvalRun; label: string; target: number; fmt: (v: number | null) => string }> = [
  { key: 'recallAt5', label: 'Recall@5', target: 0.85, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
  { key: 'fidelity', label: '忠实度', target: 0.8, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
  { key: 'citationAcc', label: '引用准确率', target: 0.9, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
  { key: 'relevance', label: '答案相关性', target: 0.75, fmt: (v) => (v === null ? '—' : v.toFixed(4)) },
];

export interface EvalCaseRow {
  id: string;
  question: string;
  caseType: 'fact' | 'table' | 'timeliness' | 'deny' | 'multi_hop';
  goldAnswer: string | null;
  goldMarkers: string[];
  source: 'manual' | 'feedback' | 'incident';
  expectDeny: boolean;
  createdAt: string;
}

const SOURCE_LABEL: Record<string, string> = { manual: '人工', feedback: '点踩回流', incident: '失败专项' };
const TYPE_LABEL: Record<string, string> = { fact: '事实', table: '表格', timeliness: '时效', deny: '拒答', multi_hop: '多跳' };

export default function Eval() {
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [cases, setCases] = useState<EvalCaseRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api<EvalRun[]>('/admin/eval/runs'), api<EvalCaseRow[]>('/admin/eval/cases')]);
      setRuns(r);
      setCases(c);
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
          <div className="card" style={{ overflow: 'hidden', marginBottom: 18 }}>
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

        <div className="page-head" style={{ marginBottom: 12 }}>
          <div>
            <h2 className="page-title" style={{ fontSize: 'var(--fs-xl)' }}>评测用例池（{cases?.length ?? 0}）</h2>
            <p className="page-desc">三来源防过拟合：人工出题 / 点踩回流（feedback）/ 失败专项（incident）</p>
          </div>
          <ImportCasesButton onImported={() => void load()} />
        </div>

        {cases === null ? null : cases.length === 0 ? (
          <div className="card card-pad empty">评测集为空：先运行 pnpm seed</div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>问题</th>
                  <th>类型</th>
                  <th>来源</th>
                  <th>期望</th>
                  <th>gold 标记</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td style={{ maxWidth: 420 }}>
                      {c.question}
                      {c.goldAnswer && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>✓ {c.goldAnswer}</div>}
                    </td>
                    <td><span className="badge badge-neutral">{TYPE_LABEL[c.caseType]}</span></td>
                    <td>
                      <span className={`badge ${c.source === 'feedback' ? 'badge-warn' : c.source === 'incident' ? 'badge-err' : 'badge-info'}`}>
                        {SOURCE_LABEL[c.source]}
                      </span>
                    </td>
                    <td>{c.expectDeny ? <span className="badge badge-cinnabar">应拒答</span> : <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>应命中</span>}</td>
                    <td style={{ fontSize: 12, color: 'var(--ink-3)', maxWidth: 220 }}>
                      {c.goldMarkers.length ? c.goldMarkers.join(' · ') : '—'}
                    </td>
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

/** 批量导入评测用例（粘贴 JSON 数组）：question 必填，caseType/goldMarkers/expectDeny 可选 */
function ImportCasesButton({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const doImport = async () => {
    try {
      const cases = JSON.parse(json);
      const res = await api<{ imported: number }>('/admin/eval/cases/import', { body: { cases } });
      setMsg(`已导入 ${res.imported} 条`);
      setTimeout(() => {
        setOpen(false);
        setMsg(null);
        setJson('');
        onImported();
      }, 900);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '导入失败（检查 JSON 格式）');
    }
  };

  return (
    <>
      <button className="btn btn-secondary" onClick={() => setOpen(true)}>
        <Upload /> 导入用例
      </button>
      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="dialog" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">批量导入评测用例</div>
            <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: '-6px 0 12px' }}>
              JSON 数组，每条：<code className="mono">{'{ "question": "...", "caseType": "fact|table|timeliness|deny", "goldMarkers": ["锚点短语"], "expectDeny": false, "source": "incident" }'}</code>
            </p>
            <textarea
              className="input"
              rows={9}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
              placeholder='[{"question":"公司年会抽奖规则是什么？","caseType":"fact","goldMarkers":["年会抽奖"]}]'
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            {msg && <div style={{ fontSize: 13, marginTop: 10, color: msg.startsWith('已导入') ? 'var(--ok)' : 'var(--err)' }}>{msg}</div>}
            <div className="dialog-foot">
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
              <button className="btn btn-primary" disabled={!json.trim()} onClick={() => void doImport()}>导入</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
