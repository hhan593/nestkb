import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class AskDto {
  @IsString()
  @Length(1, 500, { message: '问题长度需在 1~500 字符之间' })
  question!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;

  /** rag：知识库检索增强（默认）；chat：纯对话，不检索不带引用 */
  @IsOptional()
  @IsIn(['rag', 'chat'])
  mode?: 'rag' | 'chat';
}

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @Length(0, 100)
  title?: string;
}

export class RenameConversationDto {
  @IsString()
  @Length(1, 60, { message: '标题长度需在 1~60 字符之间' })
  title!: string;
}
