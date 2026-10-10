import { Module } from '@nestjs/common';
import { DEFAULT_KILL_GRACE_MS } from '../ffmpeg/process';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { TranscoderConfigService } from '../shared/config';
import { MediaPipeline, PIPELINE_SETTINGS, type PipelineSettings } from './media-pipeline';

/** Design §4: TIMEOUT after max(300 s, duration x factor) or 120 s without progress. */
export const STALL_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 300_000;

@Module({
  imports: [FfmpegModule],
  providers: [
    {
      provide: PIPELINE_SETTINGS,
      inject: [TranscoderConfigService],
      useFactory: (config: TranscoderConfigService): PipelineSettings => ({
        threads: config.get('TRANSCODER_THREADS'),
        maxShortSide: config.get('TRANSCODER_MAX_HEIGHT'),
        timeoutFactor: config.get('TRANSCODER_TIMEOUT_FACTOR'),
        maxSourceSeconds: config.get('TRANSCODER_MAX_SOURCE_SECONDS'),
        spritesEnabled: config.get('TRANSCODER_SPRITES_ENABLED'),
        stallTimeoutMs: STALL_TIMEOUT_MS,
        killGraceMs: DEFAULT_KILL_GRACE_MS,
        minTimeoutMs: MIN_TIMEOUT_MS,
      }),
    },
    MediaPipeline,
  ],
  exports: [MediaPipeline, FfmpegModule],
})
export class PipelineModule {}
