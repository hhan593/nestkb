import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { INGEST_QUEUE } from '@lib/contracts';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [BullModule.registerQueue({ name: INGEST_QUEUE })],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
