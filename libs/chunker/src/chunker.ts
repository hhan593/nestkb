/**
 * 结构感知分块（计划书 8.3，ai-agent/02 §2）：
 * 第一层：标题路径感知（#/##/### 栈式维护）；
 * 第二层：表格行（| 开头）聚合为整块 —— 表格再大也不拦腰切；
 * 第三层：超长段落递归下切，从粗到细分隔符，带尾部重叠。
 */

export interface ChunkDraft {
  content: string;
  chunkNo: number;
  /** 章节路径，如 "第五章 考核 > 5.4 试用期考核" */
  headingPath: string;
  isTable: boolean;
  /** 粗估：中文 ~1.6 字符/token */
  tokenEstimate: number;
}

export interface ChunkOptions {
  /** 中文 500 字 ≈ 300 token */
  maxChars?: number;
  /** 10%~15% 重叠：关键句跨块时兜底 */
  overlapChars?: number;
}

/** 从粗到细的切分层级 */
export const SEPARATORS = ['\n\n', '\n', '。', '；', '，', ''];

export function chunkDocument(text: string, opts: ChunkOptions = {}): ChunkDraft[] {
  const maxChars = opts.maxChars ?? 500;
  const overlap = opts.overlapChars ?? Math.round(maxChars * 0.12);
  const out: ChunkDraft[] = [];
  const mk = (content: string, heading: string, isTable: boolean): void => {
    const trimmed = content.trim();
    if (!trimmed) return;
    out.push({
      content: trimmed,
      chunkNo: out.length,
      headingPath: heading,
      isTable,
      tokenEstimate: Math.ceil(trimmed.length / 1.6),
    });
  };

  for (const sec of splitByHeadings(text)) {
    for (const block of groupTableBlocks(sec.body)) {
      if (block.isTable) {
        // 表格按行聚合下切（保留行完整性），绝不让单个块超 maxChars —— 超长表格直通
        // embedding 必超 token 上限，文档会永远卡在摄取失败
        for (const piece of splitTable(block.text, maxChars)) mk(piece, sec.heading, true);
      } else if (block.text.trim().length <= maxChars) {
        mk(block.text, sec.heading, false);
      } else {
        for (const piece of recursiveSplit(block.text, 0, maxChars, overlap)) mk(piece, sec.heading, false);
      }
    }
  }
  return out;
}

/** 表格下切：按行聚合到 maxChars 为止；表头（前两行：表头行 + 分隔行）在后续片重复，保证每片自含列语义 */
export function splitTable(table: string, maxChars: number): string[] {
  if (table.length <= maxChars) return [table];
  const lines = table.split('\n');
  const hasHeader = lines.length > 2 && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1] ?? '');
  const header = hasHeader ? [lines[0], lines[1]] : [];
  const rest = hasHeader ? lines.slice(2) : lines;
  const pieces: string[] = [];
  let buf = [...header];
  let len = header.join('\n').length;
  const flush = (): void => {
    if (buf.some((l) => l.trim())) pieces.push(buf.join('\n'));
    buf = [...header];
    len = header.join('\n').length;
  };
  for (const line of rest) {
    if (buf.length > header.length && len + line.length + 1 > maxChars) flush();
    buf.push(line);
    len += line.length + 1;
  }
  flush();
  return pieces;
}

export interface HeadingSection {
  heading: string;
  body: string;
}

/** 第一层：#/###### 标题栈 → 章节路径（DOCX h4-h6 会被解析为 ####，必须一并识别） */
export function splitByHeadings(text: string): HeadingSection[] {
  const lines = text.split('\n');
  const sections: HeadingSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let heading = '';
  let buf: string[] = [];

  const push = (): void => {
    if (buf.some((l) => l.trim())) sections.push({ heading, body: buf.join('\n') });
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      push();
      buf = [];
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2] });
      heading = stack.map((s) => s.title).join(' > ');
    } else {
      buf.push(line);
    }
  }
  push();
  return sections;
}

export interface TextBlock {
  text: string;
  isTable: boolean;
}

/** 第二层：连续表格行（| 开头 / +---+ 边框）聚合为整块 */
export function groupTableBlocks(body: string): TextBlock[] {
  const lines = body.split('\n');
  const blocks: TextBlock[] = [];
  let buf: string[] = [];
  let inTable = false;
  const flush = (): void => {
    if (buf.length) {
      blocks.push({ text: buf.join('\n'), isTable: inTable });
      buf = [];
    }
  };
  for (const line of lines) {
    const isTableLine = /^\s*\|/.test(line) || /^\s*\+[-=+]+\+\s*$/.test(line);
    if (isTableLine !== inTable) {
      flush();
      inTable = isTableLine;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

/** 第三层：递归下切 —— 优先最粗分隔符；仍超长用下一级继续，带尾部重叠 */
export function recursiveSplit(segment: string, sepIdx: number, max: number, overlap: number): string[] {
  if (segment.length <= max) return segment.trim() ? [segment] : [];
  const sep = SEPARATORS[sepIdx] ?? '';
  const parts = sep ? segment.split(sep) : Array.from(segment); // '' 兜底按字符切
  const pieces: string[] = [];
  let buf = '';
  for (const part of parts) {
    const candidate = buf ? buf + sep + part : part;
    if (candidate.length > max && buf) {
      pieces.push(buf);
      buf = buf.slice(-overlap) + sep + part;
    } else {
      buf = candidate;
    }
  }
  if (buf.trim()) pieces.push(buf);
  if (sepIdx + 1 < SEPARATORS.length) {
    return pieces.flatMap((p) => (p.length > max ? recursiveSplit(p, sepIdx + 1, max, overlap) : [p]));
  }
  return pieces;
}
