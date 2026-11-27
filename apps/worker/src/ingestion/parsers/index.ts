import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extForMime } from '@lib/contracts';
import { ParseError } from './parse.error';
import { parseDocx } from './docx';

export * from './parse.error';

export interface ParsedDocument {
  text: string;
  pages?: number;
}

/** Markdown 原样保留（#/##/### 标题与 | 表格正是 chunker 需要的结构信号） */
export async function parseMarkdown(buffer: Buffer): Promise<string> {
  return buffer.toString('utf8');
}

interface PdfParseResult {
  text: string;
  numpages: number;
}

export async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  let pdf: (b: Buffer) => Promise<PdfParseResult>;
  try {
    const mod = (await import('pdf-parse')) as { default?: (b: Buffer) => Promise<PdfParseResult> };
    pdf = mod.default ?? (mod as unknown as (b: Buffer) => Promise<PdfParseResult>);
  } catch (err) {
    throw new ParseError('PARSE_FAILED', `pdf-parse load failed: ${String(err)}`);
  }
  try {
    const result = await pdf(buffer);
    return { text: result.text, pages: result.numpages };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(msg)) throw new ParseError('ENCRYPTED_PDF', msg);
    if (/invalid|structure|corrupt/i.test(msg)) throw new ParseError('PARSE_FAILED', msg);
    if (/scan|image/i.test(msg)) throw new ParseError('OCR_NEEDED', msg);
    throw new ParseError('PARSE_FAILED', msg);
  }
}

export function extOf(storageKey: string, mimeType: string): string {
  const fromKey = path.extname(storageKey).toLowerCase();
  if (fromKey) return fromKey;
  return extForMime(mimeType);
}

/** 按 mime/扩展名分发解析（计划书 8.4 步骤 1）；失败必须分类为 ParseError */
export async function parseByMime(storageKey: string, mimeType: string): Promise<ParsedDocument> {
  const ext = extOf(storageKey, mimeType);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(storageKey);
  } catch (err) {
    throw new ParseError('FILE_NOT_FOUND', String(err instanceof Error ? err.message : err));
  }
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt':
      return { text: await parseMarkdown(buffer) };
    case '.pdf':
      return parsePdf(buffer);
    case '.docx':
      return { text: await parseDocx(buffer) };
    default:
      throw new ParseError('UNSUPPORTED_MIME', `ext=${ext} mime=${mimeType}`);
  }
}
