import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class AskDto {
  @IsString()
  @Length(1, 500, { message: '问题长度需在 1~500 字符之间' })
  question!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;
}

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @Length(0, 100)
  title?: string;
}
