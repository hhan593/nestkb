import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { INGEST_QUEUE } from '@lib/contracts';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { QueuesBoardService } from './queues-board.service';

@Module({
  imports: [BullModule.registerQueue({ name: INGEST_QUEUE })],
  controllers: [AdminController],
  providers: [AdminService, QueuesBoardService],
  exports: [AdminService],
})
export class AdminModule {}
