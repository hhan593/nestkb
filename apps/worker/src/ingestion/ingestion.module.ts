import { Module } from '@nestjs/common';
import { IngestionProcessor } from './ingestion.processor';

@Module({
  providers: [IngestionProcessor],
})
export class IngestionModule {}
