import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CalendarClock, FilePlus2, FileText, History, KeyRound, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  ACCESS_LEVEL_LABEL,
  fmtDate,
  STAGE_LABEL,
  type DocumentRow,
  type VersionDto,
} from '../lib/types';

const stageBadge = (stage: string | undefined): { cls: string; label: string } => {
  switch (stage) {
    case 'ready': return { cls: 'badge-ok', label: '就绪' };
    case 'failed': return { cls: 'badge-err', label: '失败' };
    case 'queued': return { cls: 'badge-neutral', label: '排队中' };
    default: return { cls: 'badge-info', label: STAGE_LABEL[stage ?? ''] ?? '处理中' };
  }
};

export default function Documents() {
  const { me } = useAuth();
  const [rows, setRows] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState<false | 'new' | 'version'>(false);
  const [detailDoc, setDetailDoc] = useState<{ doc: DocumentRow; versions: VersionDto[] } | null>(null);
  const [grantDoc, setGrantDoc] = useState<{ doc: DocumentRow; depts: Array<{ id: string; name: string }> } | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ rows: DocumentRow[]; total: number }>('/documents?pageSize=50');
      setRows(data.rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有非终态任务时 3s 轮询摄取进度
  const hasPending = rows?.some((r) => r.currentVersion?.ingestion && !['ready', 'failed'].includes(r.currentVersion.ingestion.stage));
  useEffect(() => {
    if (hasPending && !pollRef.current) {
      pollRef.current = window.setInterval(() => void load(), 3000);
    }
    if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasPending, load]);

  const remove = useCallback(async (doc: DocumentRow) => {
    if (!window.confirm(`删除《${doc.title}》？其全部版本与检索块将一并清除。`)) return;
    await api(`/documents/${doc.id}`, { method: 'DELETE' });
    void load();
  }, [load]);

  const reingest = useCallback(async (doc: DocumentRow) => {
    await api(`/documents/${doc.id}/reingest`, { body: {} });
    void load();
  }, [load]);

  const openDetail = useCallback(async (doc: DocumentRow) => {
    const detail = await api<{ versions: VersionDto[] }>(`/documents/${doc.id}`);
    setDetailDoc({ doc, versions: detail.versions });
  }, []);

  const markExpired = useCallback(async (doc: DocumentRow) => {
    const input = window.prompt('标记为过期的时间（过期后不可被检索引用）：', new Date(Date.now() + 86400_000).toISOString().slice(0, 16));
    if (!input) return;
    const iso = new Date(input).toISOString();
    await api(`/admin/documents/${doc.id}/expire`, { body: { expiresAt: iso } });
    void load();
  }, [load]);

  const openGrants = useCallback(async (doc: DocumentRow) => {
    const depts = await api<Array<{ id: string; name: string }>>('/admin/departments');
    setGrantDoc({ doc, depts });
  }, []);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">文档管理</h1>
            <p className="page-desc">{me?.department.name}可见的知识库文档 · 上传后自动解析分块并向量化</p>
          </div>
          <button className="btn btn-primary" onClick={() => setUploadOpen('new')}>
            <Upload /> 上传文档
          </button>
        </div>

        {error && <div className="alert-banner alert-critical"><CircleAlert /> {error}</div>}

        {rows === null ? (
          <div className="spinner" style={{ margin: '60px auto' }} />
        ) : rows.length === 0 ? (
          <div className="card card-pad empty">
            <FileText />
            <div className="empty-title">知识库还是空的</div>
            <div>上传第一份 MD / PDF / DOCX 文档（≤20MB），解析分块完成后即可提问。</div>
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setUploadOpen('new')}>
                <Upload /> 上传文档
              </button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>可见范围</th>
                  <th>当前版本</th>
                  <th>摄取状态</th>
                  <th>块数</th>
                  <th>生效 / 过期</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const ing = d.currentVersion?.ingestion;
                  const badge = stageBadge(ing?.stage);
                  return (
                    <tr key={d.id}>
                      <td style={{ fontWeight: 550 }}>
                        {d.title}
                        {d.currentVersion?.expiresAt && new Date(d.currentVersion.expiresAt) < new Date() && (
                          <span className="badge badge-warn" style={{ marginLeft: 8 }}>已过期</span>
                        )}
                      </td>
                      <td><span className="badge badge-cinnabar">{ACCESS_LEVEL_LABEL[d.accessLevel]}</span></td>
                      <td className="num">v{d.currentVersion?.versionNo ?? '—'}（共 {d.versionCount} 版）</td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        {ing?.stage === 'failed' && ing.error && (
                          <div style={{ fontSize: 11, color: 'var(--err)', marginTop: 3 }} className="mono">{ing.error.slice(0, 44)}</div>
                        )}
                      </td>
                      <td className="num">{ing?.chunkCount ?? '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                        {fmtDate(d.currentVersion?.effectiveAt)}
                        {d.currentVersion?.expiresAt ? ` → ${fmtDate(d.currentVersion.expiresAt)}` : ''}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                          <button className="icon-btn" title="版本历史" onClick={() => void openDetail(d)}><History /></button>
                          {me?.role === 'admin' && (
                            <>
                              <button className="icon-btn" title="标记过期" onClick={() => void markExpired(d)}><CalendarClock /></button>
                              <button className="icon-btn" title="白名单授权" onClick={() => void openGrants(d)}><KeyRound /></button>
                              {ing?.stage === 'failed' && (
                                <button className="icon-btn" title="重放摄取（DLQ）" onClick={() => void reingest(d)}><RefreshCw /></button>
                              )}
                            </>
                          )}
                          <button className="icon-btn" title="删除" onClick={() => void remove(d)}><Trash2 /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {uploadOpen && (
        <UploadDialog
          versionOf={uploadOpen === 'version' ? (detailDoc?.doc ?? null) : null}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            setDetailDoc(null);
            void load();
          }}
        />
      )}

      {grantDoc && (
        <GrantsDialog
          doc={grantDoc.doc}
          depts={grantDoc.depts}
          onClose={() => setGrantDoc(null)}
        />
      )}

      {detailDoc && (
        <div className="overlay" onClick={() => setDetailDoc(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="dialog-title" style={{ marginBottom: 0 }}>《{detailDoc.doc.title}》</div>
              <button className="icon-btn" onClick={() => setDetailDoc(null)}><X /></button>
            </div>
            <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '8px 0 14px' }}>
              {ACCESS_LEVEL_LABEL[detailDoc.doc.accessLevel]} · {detailDoc.doc.versionCount} 个版本 · 版本替换后旧版本检索块自动清除
            </p>
            {detailDoc.versions.map((v) => {
              const badge = stageBadge(v.ingestion?.stage);
              return (
                <div key={v.id} className="version-item">
                  <div className="version-no">v{v.versionNo}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {v.isCurrent && <span className="badge badge-cinnabar">当前</span>}
                      <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      {v.ingestion?.chunkCount != null && <span style={{ fontSize: 12, color: 'var(--ink-2)' }} className="num">{v.ingestion.chunkCount} 块</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                      生效 {fmtDate(v.effectiveAt)}
                      {v.expiresAt ? ` · 过期 ${fmtDate(v.expiresAt)}` : ''} · 校验 {v.checksum}
                    </div>
                    {v.ingestion?.error && (
                      <div className="mono" style={{ fontSize: 11, color: 'var(--err)', marginTop: 4 }}>{v.ingestion.error}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadDialog({ onClose, onDone, versionOf }: { onClose: () => void; onDone: () => void; versionOf: DocumentRow | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [accessLevel, setAccessLevel] = useState<'department' | 'company' | 'whitelist'>('department');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!file) {
      setError('请选择文件');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (versionOf) {
        // 新版本：沿用文档标题与可见范围，仅文件与过期时间可变
        fd.append('file', file);
        if (expiresAt) fd.append('expiresAt', new Date(expiresAt).toISOString());
        await api(`/documents/${versionOf.id}/versions`, { formData: fd });
      } else {
        fd.append('title', title.trim() || file.name.replace(/\.[^.]+$/, ''));
        fd.append('accessLevel', accessLevel);
        if (expiresAt) fd.append('expiresAt', new Date(expiresAt).toISOString());
        await api('/documents', { formData: fd });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          {versionOf ? `上传新版本 · 《${versionOf.title}》` : '上传文档'}
          {file && <span style={{ fontSize: 13, color: 'var(--ink-3)', fontWeight: 400 }}>（旧版本自动下线）</span>}
        </div>
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div>
            <label className="field-label">文件</label>
            <button type="button" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => fileRef.current?.click()}>
              <FilePlus2 />
              {file ? `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）` : '选择 MD / PDF / DOCX（≤20MB）'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.txt,.pdf,.docx"
              style={{ display: 'none' }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {!versionOf && (
            <div>
              <label className="field-label" htmlFor="doc-title">标题</label>
              <input id="doc-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="默认取文件名" />
            </div>
          )}
          {!versionOf && (
            <div>
              <label className="field-label" htmlFor="doc-level">可见范围</label>
              <select id="doc-level" className="select" value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as typeof accessLevel)}>
                <option value="department">部门内 —— 仅本部门可见</option>
                <option value="company">全公司 —— 所有部门可见</option>
                <option value="whitelist">白名单 —— 仅显式授权可检索</option>
              </select>
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="doc-expire">过期时间（可选）</label>
            <input id="doc-expire" className="input" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            <div className="field-hint">过期文档不可被检索引用（时效治理）</div>
          </div>
          {error && <div className="login-error">{error}</div>}
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '上传中…' : '上传并入队摄取'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 白名单授权管理：为文档追加部门级授权（用户级授权走 API），列出现有授权 */
function GrantsDialog({ doc, depts, onClose }: { doc: DocumentRow; depts: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [deptId, setDeptId] = useState(depts[0]?.id ?? '');
  const [expiresAt, setExpiresAt] = useState('');
  const [grants, setGrants] = useState<Array<{ id: string; subjectType: string; subjectId: string; expiresAt: string | null }>>([]);
  const [busy, setBusy] = useState(false);

  const loadGrants = useCallback(async () => {
    const detail = await api<{ permissions?: Array<{ id: string; subjectType: string; subjectId: string; expiresAt: string | null }> }>(`/documents/${doc.id}`);
    setGrants(detail.permissions ?? []);
  }, [doc.id]);

  useEffect(() => {
    void loadGrants();
  }, [loadGrants]);

  const grant = async () => {
    if (!deptId) return;
    setBusy(true);
    try {
      await api(`/admin/documents/${doc.id}/grants`, { body: { subjectType: 'dept', subjectId: deptId, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined } });
      await loadGrants();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">白名单授权 · 《{doc.title}》</div>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: '-8px 0 14px' }}>whitelist 文档 default deny，显式授权后该部门/个人可检索引用。</p>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="select" style={{ flex: 1 }} value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <input className="input" style={{ width: 170 }} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} title="授权过期时间（可选）" />
            <button className="btn btn-primary" disabled={busy || !deptId} onClick={() => void grant()}>添加</button>
          </div>
          <div>
            {grants.length === 0 && <div className="empty" style={{ padding: 18 }}>暂无授权记录</div>}
            {grants.map((g) => (
              <div key={g.id} className="version-item">
                <div className="version-no">{g.subjectType === 'dept' ? '部门' : '用户'}</div>
                <div style={{ flex: 1, fontSize: 13 }}>
                  <span className="mono">{g.subjectId.slice(0, 8)}…</span>
                  {g.expiresAt && <span style={{ color: 'var(--ink-3)', marginLeft: 8 }}>至 {new Date(g.expiresAt).toLocaleString('zh-CN')}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
