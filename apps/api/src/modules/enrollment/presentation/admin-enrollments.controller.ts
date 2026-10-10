import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminEnrollmentResponse,
  AdminEnrollmentResponseSchema,
  type AdminGrantEnrollmentRequest,
  AdminGrantEnrollmentRequestSchema,
  type AdminRevokeEnrollmentRequest,
  AdminRevokeEnrollmentRequestSchema,
  type AdminUserEnrollments,
  AdminUserEnrollmentsSchema,
  type EnrollmentIdParams,
  EnrollmentIdParamsSchema,
  type UserIdParams,
  UserIdParamsSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { AdminGrantEnrollmentCommand } from '../application/use-cases/admin-grant-enrollment.command';
import { AdminListUserEnrollmentsQuery } from '../application/use-cases/admin-list-user-enrollments.query';
import { AdminRevokeEnrollmentCommand } from '../application/use-cases/admin-revoke-enrollment.command';

/**
 * Admin enrollment support (design §8, admin app): a user's enrollments with their history,
 * and manual grant / revoke with an audited reason. ADMIN permissions exist only in the admin
 * app (D6).
 */
@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('admin')
export class AdminEnrollmentsController {
  constructor(
    private readonly listUserEnrollments: AdminListUserEnrollmentsQuery,
    private readonly grantEnrollment: AdminGrantEnrollmentCommand,
    private readonly revokeEnrollment: AdminRevokeEnrollmentCommand,
  ) {}

  @Get('users/:userId/enrollments')
  @RequirePermissions('enrollment:read:any')
  @ApiOperation({ summary: "A user's enrollments (active and revoked) with their transitions" })
  @ApiOkResponse({ standardSchema: AdminUserEnrollmentsSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'user_not_found' })
  list(@Param({ schema: UserIdParamsSchema }) params: UserIdParams): Promise<AdminUserEnrollments> {
    return this.listUserEnrollments.execute(params.userId);
  }

  @Post('enrollments')
  @RequirePermissions('enrollment:grant:any')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Grant an enrollment (support; source ADMIN)',
    description: 'Re-grants a revoked enrollment. The reason is recorded on the transition.',
  })
  @ApiCreatedResponse({ standardSchema: AdminEnrollmentResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'user_not_found / course_not_found' })
  @ApiConflictResponse({ description: 'already_enrolled' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (reason)' })
  grant(
    @Body({ schema: AdminGrantEnrollmentRequestSchema }) body: AdminGrantEnrollmentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminEnrollmentResponse> {
    return this.grantEnrollment.execute({
      actorId: principal.userId,
      userId: body.userId,
      courseId: body.courseId,
      reason: body.reason,
    });
  }

  @Post('enrollments/:enrollmentId/revoke')
  @RequirePermissions('enrollment:grant:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke an enrollment (support; reason ADMIN)',
    description: 'Paid lectures lock again (cached master playlists expire within 60 s).',
  })
  @ApiOkResponse({ standardSchema: AdminEnrollmentResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'enrollment_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (reason)' })
  revoke(
    @Param({ schema: EnrollmentIdParamsSchema }) params: EnrollmentIdParams,
    @Body({ schema: AdminRevokeEnrollmentRequestSchema }) body: AdminRevokeEnrollmentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminEnrollmentResponse> {
    return this.revokeEnrollment.execute({
      actorId: principal.userId,
      enrollmentId: params.enrollmentId,
      reason: body.reason,
    });
  }
}
