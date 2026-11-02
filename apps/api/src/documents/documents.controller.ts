import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AccessLevel } from '@prisma/client';
import { ErrorCodes } from '@lib/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/guards/roles.guard';
import type { AuthedUser } from '../auth/auth.service';
import { DocumentsService } from './documents.service';

const ALLOWED_MIME = new Set([
  'text/markdown',
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream', // 部分客户端对 .md 上报 octet-stream，按扩展名兜底
]);

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** multipart 上传（≤20MB）：file + title + accessLevel + 可选 expiresAt（计划书 7.3-②） */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async upload(@Req() req: FastifyRequest, @CurrentUser() user: AuthedUser) {
    if (!req.isMultipart()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: '需要 multipart/form-data' });
    }
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          file = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/file.?too.?large|limit/i.test(msg)) {
        throw new BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: '文件超过 20MB 上限' });
      }
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: msg });
    }
    if (!file) throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: '缺少 file 字段' });
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException({ code: ErrorCodes.UNSUPPORTED_TYPE, message: `不支持的文件类型：${file.mimetype}` });
    }
    const title = fields.title?.trim() || file.filename.replace(/\.[^.]+$/, '');
    if (!title) throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: '缺少 title' });
    const accessLevel = parseAccessLevel(fields.accessLevel);
    const expiresAt = fields.expiresAt ? new Date(fields.expiresAt) : null;
    if (fields.expiresAt && Number.isNaN(expiresAt?.getTime())) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: 'expiresAt 不是合法时间' });
    }
    return this.documents.upload(user, {
      buffer: file.buffer,
      filename: file.filename,
      mimetype: file.mimetype,
      title,
      accessLevel,
      expiresAt,
    });
  }

  /** 重新上传生成新版本（旧版本自动下线） */
  @Post(':id/versions')
  @HttpCode(HttpStatus.ACCEPTED)
  async addVersion(@Req() req: FastifyRequest, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    if (!req.isMultipart()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: '需要 multipart/form-data' });
    }
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          file = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/file.?too.?large|limit/i.test(msg)) {
        throw new BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: '文件超过 20MB 上限' });
      }
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: msg });
    }
    if (!file) throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: '缺少 file 字段' });
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException({ code: ErrorCodes.UNSUPPORTED_TYPE, message: `不支持的文件类型：${file.mimetype}` });
    }
    const expiresAt = fields.expiresAt ? new Date(fields.expiresAt) : null;
    if (fields.expiresAt && Number.isNaN(expiresAt?.getTime())) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: 'expiresAt 不是合法时间' });
    }
    return this.documents.addVersion(user, id, {
      buffer: file.buffer,
      filename: file.filename,
      mimetype: file.mimetype,
      expiresAt,
    });
  }

  @Get()
  async list(@CurrentUser() user: AuthedUser, @Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.documents.list(user, { page: Math.max(1, Number(page) || 1), pageSize: Math.min(100, Math.max(1, Number(pageSize) || 20)) });
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.documents.detail(user, id);
  }

  @Get(':id/ingestion')
  async ingestion(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.documents.ingestionStatus(user, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    await this.documents.remove(user, id);
    return { deleted: true };
  }

  /** DLQ/失败任务人工重放（admin） */
  @Post(':id/reingest')
  @Roles('admin')
  async reingest(@Param('id') id: string) {
    return this.documents.reingest(id);
  }
}

function parseAccessLevel(value?: string): AccessLevel {
  const v = (value ?? 'department').toLowerCase();
  if (v === 'company' || v === 'department' || v === 'whitelist') return v;
  throw new BadRequestException({ code: ErrorCodes.VALIDATION_FAILED, message: `accessLevel 不合法：${value}` });
}

void UseGuards;
