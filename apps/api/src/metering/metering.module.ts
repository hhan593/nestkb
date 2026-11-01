import { Global, Module } from '@nestjs/common';
import { MeteringService } from './metering.service';

@Global()
@Module({
  providers: [MeteringService],
  exports: [MeteringService],
})
export class MeteringModule {}
