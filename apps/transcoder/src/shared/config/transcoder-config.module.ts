import { Global, Module } from '@nestjs/common';
import { TranscoderConfigService } from './transcoder-config.service';

@Global()
@Module({
  providers: [TranscoderConfigService],
  exports: [TranscoderConfigService],
})
export class TranscoderConfigModule {}
