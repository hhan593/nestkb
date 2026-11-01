/** 解析失败分类（计划书 8.1：不可重试 → UnrecoverableError → DLQ，防毒文档烧钱） */
export type ParseErrorCode =
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_MIME'
  | 'ENCRYPTED_PDF'
  | 'EMPTY_DOCUMENT'
  | 'DOCX_CORRUPTED'
  | 'OCR_NEEDED'
  | 'PARSE_FAILED';

export class ParseError extends Error {
  constructor(
    readonly code: ParseErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ParseError';
  }
}
