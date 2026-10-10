import { Module } from '@nestjs/common';
import { TranscoderConfigService } from '../shared/config';
import { FfmpegToolchain, TOOLCHAIN_PATHS, type ToolchainPaths } from './ffmpeg-toolchain.service';

@Module({
  providers: [
    {
      provide: TOOLCHAIN_PATHS,
      inject: [TranscoderConfigService],
      useFactory: (config: TranscoderConfigService): ToolchainPaths => ({
        ffmpeg: config.get('TRANSCODER_FFMPEG_PATH'),
        ffprobe: config.get('TRANSCODER_FFPROBE_PATH'),
      }),
    },
    FfmpegToolchain,
  ],
  exports: [FfmpegToolchain],
})
export class FfmpegModule {}
