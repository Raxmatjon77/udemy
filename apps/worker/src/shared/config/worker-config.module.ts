import { Global, Module } from '@nestjs/common';
import { WorkerConfigService } from './worker-config.service';

@Global()
@Module({
  providers: [WorkerConfigService],
  exports: [WorkerConfigService],
})
export class WorkerConfigModule {}
