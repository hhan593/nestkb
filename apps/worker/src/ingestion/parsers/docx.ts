import mammoth from 'mammoth';
import { ParseError } from './parse.error';

/**
 * DOCX → 结构化文本：走 convertToHtml 保留标题层级与表格，
 * 再转 markdown 形态（# 标题、| 表格行），与 chunker 的结构感知对齐。
 */
export async function parseDocx(buffer: Buffer): Promise<string> {
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    return htmlToMarkdownLite(html);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/corrupt|zip|end of central directory/i.test(msg)) throw new ParseError('DOCX_CORRUPTED', msg);
    throw new ParseError('PARSE_FAILED', msg);
  }
}

export function htmlToMarkdownLite(html: string): string {
  let out = html;
  // 标题层级
  out = out.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n\n# ${stripTags(t)}\n`);
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n\n## ${stripTags(t)}\n`);
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n\n### ${stripTags(t)}\n`);
  out = out.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_m, t) => `\n\n#### ${stripTags(t)}\n`);
  // 表格 → markdown 管道行
  out = out.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]).replace(/\|/g, '\\|').trim());
    return `\n| ${cells.join(' | ')} |`;
  });
  out = out.replace(/<\/?(table|thead|tbody|tfoot)[^>]*>/gi, '\n');
  // 列表与段落
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${stripTags(t)}`);
  out = out.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t) => `\n${stripTags(t)}\n`);
  out = out.replace(/<br\s*\/?>/gi, '\n');
  return out
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n');
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
