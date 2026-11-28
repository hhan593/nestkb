/**
 * 轻量 Markdown 块级渲染器 —— 只支持 LLM 制度回答实际会用到的结构：
 * 标题 / 无序有序列表 / 管道表格 / 代码块 / 引用行 / 粗体斜体行内代码。
 * 全部输出 React 元素（无 dangerouslySetInnerHTML），资料内容即不可信输入，杜绝 XSS 面。
 * 行内 [n] 引用编号交给调用方的 renderer 处理（保留点击定位交互）。
 */
import type { ReactNode } from 'react';

export interface RenderRefs {
  /** [n] 编号 → 行内元素（含点击定位） */
  ref: (n: number, key: string) => ReactNode;
  /** 引用合法上限（越界编号按普通文本渲染） */
  maxRef: number;
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'quote'; text: string }
  | { kind: 'p'; text: string };

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // 代码块
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // 跳过收尾 ```
      blocks.push({ kind: 'code', text: buf.join('\n'), lang });
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3 | 4, text: h[2] });
      i++;
      continue;
    }
    // 表格：| a | b | 下一行 |---|---|
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) =>
        l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    // 引用行
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) buf.push(lines[i++].slice(2));
      blocks.push({ kind: 'quote', text: buf.join('\n') });
      continue;
    }
    // 列表（连续行聚合）
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push({ kind: 'ul', items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push({ kind: 'ol', items });
      continue;
    }
    // 段落（连续非空行聚合）
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+[.)]\s|>\s|\s*\|)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    blocks.push({ kind: 'p', text: buf.join('\n') });
  }
  return blocks;
}

/** 行内渲染：**粗体** / *斜体* / `代码` / [n] 引用 */
export function renderInline(text: string, refs?: RenderRefs, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  // 行内代码必须最先切分保护：否则 `arr[1]` 里的 [1] 会被当成引用上标拆坏
  const parts = text.split(/(`[^`]+`|\[\d{1,2}\]|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  parts.forEach((part, pi) => {
    if (/^`[^`]+`$/.test(part)) {
      out.push(<code key={`${keyBase}-${pi}`} className="mono inline-code">{part.slice(1, -1)}</code>);
      return;
    }
    const ref = part.match(/^\[(\d{1,2})\]$/);
    if (ref) {
      const n = Number(ref[1]);
      if (refs && n >= 1 && n <= refs.maxRef) {
        out.push(refs.ref(n, `${keyBase}-${pi}`));
      } else {
        out.push(part);
      }
      return;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      out.push(<strong key={`${keyBase}-${pi}`}>{part.slice(2, -2)}</strong>);
      return;
    }
    if (/^\*[^*]+\*$/.test(part)) {
      out.push(<em key={`${keyBase}-${pi}`}>{part.slice(1, -1)}</em>);
      return;
    }
    if (part) out.push(part);
  });
  return out;
}
