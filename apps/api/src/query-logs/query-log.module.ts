import { Global, Module } from '@nestjs/common';
import { QueryLogService } from './query-log.service';

@Global()
@Module({
  providers: [QueryLogService],
  exports: [QueryLogService],
})
export class QueryLogModule {}
