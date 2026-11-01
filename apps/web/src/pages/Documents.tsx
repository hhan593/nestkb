import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, FilePlus2, FileText, History, RefreshCw, Trash2, Upload, X } from 'lucide-react';
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
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailDoc, setDetailDoc] = useState<{ doc: DocumentRow; versions: VersionDto[] } | null>(null);
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

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">文档管理</h1>
            <p className="page-desc">{me?.department.name}可见的知识库文档 · 上传后自动解析分块并向量化</p>
          </div>
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
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
              <button className="btn btn-primary btn-sm" onClick={() => setUploadOpen(true)}>
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
                          {ing?.stage === 'failed' && me?.role === 'admin' && (
                            <button className="icon-btn" title="重放摄取（DLQ）" onClick={() => void reingest(d)}><RefreshCw /></button>
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
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            void load();
          }}
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

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
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
      fd.append('title', title.trim() || file.name.replace(/\.[^.]+$/, ''));
      fd.append('accessLevel', accessLevel);
      if (expiresAt) fd.append('expiresAt', new Date(expiresAt).toISOString());
      await api('/documents', { formData: fd });
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
          {file ? '上传新版本' : '上传文档'}
          {file && <span style={{ fontSize: 13, color: 'var(--ink-3)', fontWeight: 400 }}>（重新上传同标题文档会生成新版本）</span>}
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
          <div>
            <label className="field-label" htmlFor="doc-title">标题</label>
            <input id="doc-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="默认取文件名" />
          </div>
          <div>
            <label className="field-label" htmlFor="doc-level">可见范围</label>
            <select id="doc-level" className="select" value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as typeof accessLevel)}>
              <option value="department">部门内 —— 仅本部门可见</option>
              <option value="company">全公司 —— 所有部门可见</option>
              <option value="whitelist">白名单 —— 仅显式授权可检索</option>
            </select>
          </div>
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
