import { describe, expect, it } from 'vitest';
import { chunkDocument, groupTableBlocks, recursiveSplit, splitByHeadings } from './chunker';

describe('chunker：无标题纯文本', () => {
  it('按段落切块并生成 token 估算', () => {
    const text = ['第一段。'.repeat(40), '', '第二段。'.repeat(40)].join('\n\n');
    const chunks = chunkDocument(text, { maxChars: 200, overlapChars: 24 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].headingPath).toBe('');
    expect(chunks[0].chunkNo).toBe(0);
    expect(chunks[1].chunkNo).toBe(1);
    expect(chunks.every((c) => c.tokenEstimate > 0)).toBe(true);
  });

  it('空文本产出空数组', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\n  ')).toEqual([]);
  });
});

describe('chunker：三级标题嵌套', () => {
  const text = [
    '# 第一章 总则',
    '总则内容。',
    '',
    '## 1.1 适用范围',
    '适用范围内容。',
    '',
    '### 1.1.1 特殊说明',
    '特殊说明内容。',
    '',
    '## 1.2 另一节',
    '另一节内容。',
  ].join('\n');

  it('维护标题栈生成章节路径', () => {
    const sections = splitByHeadings(text);
    const paths = sections.map((s) => s.heading);
    expect(paths).toContain('第一章 总则');
    expect(paths).toContain('第一章 总则 > 1.1 适用范围');
    expect(paths).toContain('第一章 总则 > 1.1 适用范围 > 1.1.1 特殊说明');
    // 弹栈：1.2 不应再带 1.1 前缀
    expect(paths).toContain('第一章 总则 > 1.2 另一节');
    expect(paths.filter((p) => p.includes('1.1.1') && p.includes('1.2'))).toHaveLength(0);
  });

  it('每个 chunk 携带所属章节路径', () => {
    const chunks = chunkDocument(text);
    const special = chunks.find((c) => c.content.includes('特殊说明内容'));
    expect(special?.headingPath).toBe('第一章 总则 > 1.1 适用范围 > 1.1.1 特殊说明');
  });
});

describe('chunker：表格分块', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| 行${i} | 数据${i} | 数据${i}${i} |`).join('\n');
  const text = `# 差旅制度\n\n### 3.1 住宿标准\n\n| 职级 | 一线 | 二线 |\n| --- | --- | --- |\n${rows}\n\n表格后段落。`;

  it('超长表格按行聚合下切为多个 isTable 片，每片携带表头，不产生超限毒 chunk', () => {
    const chunks = chunkDocument(text, { maxChars: 100 }); // 故意切小：表格按行下切而非整块直通
    const tableChunks = chunks.filter((c) => c.isTable);
    expect(tableChunks.length).toBeGreaterThan(1); // 30 行被切成多片
    expect(tableChunks.some((c) => c.content.includes('| 行29 |'))).toBe(true); // 全部行都在
    for (const c of tableChunks) {
      expect(c.content).toContain('| 职级 | 一线 | 二线 |'); // 表头随片重复，每片自含列语义
      expect(c.headingPath).toBe('差旅制度 > 3.1 住宿标准');
    }
  });

  it('小表格保持整块不腰斩', () => {
    const chunks = chunkDocument('前言\n\n| a | b |\n| c | d |\n\n后语', { maxChars: 100 });
    const table = chunks.filter((c) => c.isTable);
    expect(table).toHaveLength(1);
    expect(table[0].content).toBe('| a | b |\n| c | d |');
  });

  it('groupTableBlocks 把表格与普通文本分离', () => {
    const blocks = groupTableBlocks('前文。\n| a | b |\n| c | d |\n后文。');
    expect(blocks.map((b) => b.isTable)).toEqual([false, true, false]);
  });
});

describe('chunker：标题后超长段落（重叠下切）', () => {
  const long = '长句内容必须足够长以便触发递归下切逻辑。'.repeat(60); // ~1080 字
  const text = `# 长章节\n\n${long}`;

  it('产出多个块且相邻块带重叠', () => {
    const chunks = chunkDocument(text, { maxChars: 500, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.headingPath === '长章节')).toBe(true);
    // 重叠：后块开头应出现在前块尾部附近
    const first = chunks[0].content;
    const second = chunks[1].content;
    const tailOfFirst = first.slice(-60);
    expect(second.startsWith(tailOfFirst.slice(0, 20)) || second.includes(tailOfFirst.slice(0, 20))).toBe(true);
  });

  it('recursiveSplit 兜底按字符切（无分隔符）', () => {
    const pieces = recursiveSplit('无分隔符'.repeat(400), 5, 200, 20);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 220)).toBe(true);
  });
});
