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
      if (block.isTable || block.text.trim().length <= maxChars) {
        mk(block.text, sec.heading, block.isTable);
      } else {
        for (const piece of recursiveSplit(block.text, 0, maxChars, overlap)) mk(piece, sec.heading, false);
      }
    }
  }
  return out;
}

export interface HeadingSection {
  heading: string;
  body: string;
}

/** 第一层：#/##/### 标题栈 → 章节路径 */
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
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
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
