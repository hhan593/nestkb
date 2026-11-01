import { Body, Controller, Param, Post } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthedUser } from '../auth/auth.service';
import { FeedbackService } from './feedback.service';

export class FeedbackDto {
  @IsIn(['up', 'down'])
  rating!: 'up' | 'down';

  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(5)
  @IsIn(['wrong', 'no_citation', 'outdated', 'not_found', 'other'], { each: true })
  reasons!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** 点赞/点踩 + 原因标签（计划书 7.3-⑤） */
  @Post('messages/:id/feedback')
  async create(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.feedback.create(user, id, { rating: dto.rating, reasons: dto.reasons, comment: dto.comment });
  }
}
