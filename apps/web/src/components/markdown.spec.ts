import { describe, expect, it } from 'vitest';
import { parseBlocks, renderInline } from './markdown';

describe('parseBlocks（轻量 Markdown 块级解析）', () => {
  it('标题/段落/列表混合', () => {
    const blocks = parseBlocks('# 标题\n\n正文第一段。\n\n- 甲\n- 乙\n\n1. 一\n2. 二');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'p', 'ul', 'ol']);
  });

  it('表格：管道行 + 分隔行聚合，单元格裁剪', () => {
    const blocks = parseBlocks('| 职级 | 标准 |\n| --- | --- |\n| 经理 | 600 |\n| 员工 | 450 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'table', header: ['职级', '标准'] });
    expect(blocks[0].rows).toEqual([['经理', '600'], ['员工', '450']]);
  });

  it('代码块与引用行', () => {
    const blocks = parseBlocks('> 引用内容\n\n```js\nconst a = 1;\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['quote', 'code']);
    expect(blocks[1].text).toBe('const a = 1;');
  });

  it('空行与空输入', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\n\n\n')).toEqual([]);
  });
});

describe('renderInline（行内：粗体/斜体/代码/[n] 引用）', () => {
  const refs = {
    maxRef: 3,
    ref: (n: number, key: string) => `<ref-${n}-${key}>` as unknown as React.ReactNode,
  };

  it('[n] 编号调用 ref 渲染器（合法范围内）', () => {
    const out = renderInline('依据[1]与[3]', refs as never);
    const rendered = out.map((x) => String(x)).join('');
    expect(rendered).toContain('ref-1');
    expect(rendered).toContain('ref-3');
    expect(rendered).toContain('依据');
  });

  it('越界编号按普通文本渲染', () => {
    const out = renderInline('编造的[9]', refs as never);
    expect(out.join('')).toContain('[9]');
  });

  it('粗体/斜体/行内代码', () => {
    const out = renderInline('**加粗** 与 *斜体* 与 `code`');
    expect(JSON.stringify(out)).toContain('加粗');
    expect(JSON.stringify(out)).toContain('code');
  });
});
