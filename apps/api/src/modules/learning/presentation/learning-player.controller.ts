import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type CompleteLectureRequest,
  CompleteLectureRequestSchema,
  type CompletionState,
  CompletionStateSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type LectureParams,
  LectureParamsSchema,
  type PlayerBootstrap,
  PlayerBootstrapSchema,
  type ProgressAck,
  ProgressAckSchema,
  type RecordHeartbeatRequest,
  RecordHeartbeatRequestSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { CompleteLectureCommand } from '../application/use-cases/complete-lecture.command';
import { GetPlayerBootstrapQuery } from '../application/use-cases/get-player-bootstrap.query';
import { RecordHeartbeatCommand } from '../application/use-cases/record-heartbeat.command';
import { UncompleteLectureCommand } from '../application/use-cases/uncomplete-lecture.command';

/**
 * `/api/v1/me/courses/:courseId/...` learner routes of the student app (design §8 "Student",
 * P5-T10): the player bootstrap, progress heartbeats and lecture completion toggles.
 * `learning:participate` exists in the student app only (an instructor-app token gets 403).
 *
 * IDOR: every lookup is scoped to the principal's user id and to the course's live revision
 * (a lecture id of another course is 404 through this course's path); no route takes a user id.
 */
@ApiTags('learning')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden / enrollment_required' })
@ApiBadRequestResponse({ description: 'validation_failed' })
@RequirePermissions('learning:participate')
@Controller('me/courses/:courseId')
export class LearningPlayerController {
  constructor(
    private readonly bootstrap: GetPlayerBootstrapQuery,
    private readonly heartbeat: RecordHeartbeatCommand,
    private readonly complete: CompleteLectureCommand,
    private readonly uncomplete: UncompleteLectureCommand,
  ) {}

  @Get('learn')
  @ApiOperation({
    summary: 'Player bootstrap: the live curriculum with my progress',
    description:
      'LEARNER with an ACTIVE enrollment; the course owner gets a read-only PREVIEW (every ' +
      'learner field empty). Archived courses stay playable for their learners.',
  })
  @ApiOkResponse({ standardSchema: PlayerBootstrapSchema })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  learn(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PlayerBootstrap> {
    return this.bootstrap.execute({ userId: principal.userId, courseId: params.courseId });
  }

  @Put('lectures/:lectureId/progress')
  @ApiOperation({
    summary: 'Progress heartbeat of a video lecture',
    description:
      'Whole-second played ranges since the last heartbeat (≤ 32) and the position. The server ' +
      'clamps them to the duration and to a wall-clock plausibility budget, merges them into ' +
      '5 s coverage buckets, and completes the lecture at 90 % coverage. 40 per minute: drop ' +
      'a 429; keep the batch and retry later on a 503.',
  })
  @ApiOkResponse({ standardSchema: ProgressAckSchema })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a video)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  @ApiServiceUnavailableResponse({ description: 'service_unavailable (progress buffer)' })
  recordProgress(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: RecordHeartbeatRequestSchema }) body: RecordHeartbeatRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProgressAck> {
    return this.heartbeat.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      positionSeconds: body.positionSeconds,
      ranges: body.ranges,
    });
  }

  @Post('lectures/:lectureId/completion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete an article or resource lecture',
    description:
      'ARTICLE: ARTICLE_READ or MANUAL; RESOURCE: RESOURCE_OPENED or MANUAL. Videos and quizzes ' +
      'are measured by the server. Idempotent. 120 toggles per hour.',
  })
  @ApiOkResponse({ standardSchema: CompletionStateSchema })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'completion_not_allowed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  completeLecture(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: CompleteLectureRequestSchema }) body: CompleteLectureRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CompletionState> {
    return this.complete.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      cause: body.cause,
    });
  }

  @Delete('lectures/:lectureId/completion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Un-complete a lecture',
    description:
      'Any lecture type; idempotent. Never touches the course completion or a certificate.',
  })
  @ApiOkResponse({ standardSchema: CompletionStateSchema })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  uncompleteLecture(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CompletionState> {
    return this.uncomplete.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
    });
  }
}
