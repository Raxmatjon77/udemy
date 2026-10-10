import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminInstructorApplicationsQuery,
  AdminInstructorApplicationsQuerySchema,
  type ApproveInstructorApplicationRequest,
  ApproveInstructorApplicationRequestSchema,
  type InstructorApplication,
  type InstructorApplicationIdParams,
  InstructorApplicationIdParamsSchema,
  type InstructorApplicationPage,
  InstructorApplicationPageSchema,
  InstructorApplicationSchema,
  type RejectInstructorApplicationRequest,
  RejectInstructorApplicationRequestSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { ApproveInstructorApplicationCommand } from '../application/use-cases/approve-instructor-application.command';
import { ListInstructorApplicationsQuery } from '../application/use-cases/list-instructor-applications.query';
import { RejectInstructorApplicationCommand } from '../application/use-cases/reject-instructor-application.command';

/** `/api/v1/admin/instructor-applications`: the review queue (design §8, admin app). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('admin/instructor-applications')
export class AdminInstructorApplicationsController {
  constructor(
    private readonly listApplications: ListInstructorApplicationsQuery,
    private readonly approveApplication: ApproveInstructorApplicationCommand,
    private readonly rejectApplication: RejectInstructorApplicationCommand,
  ) {}

  @Get()
  @RequirePermissions('instructor_application:read:any')
  @ApiOperation({
    summary: 'Review queue: oldest first, keyset paginated (status defaults to PENDING)',
  })
  @ApiOkResponse({ standardSchema: InstructorApplicationPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (foreign cursor)' })
  list(
    @Query({ schema: AdminInstructorApplicationsQuerySchema })
    query: AdminInstructorApplicationsQuery,
  ): Promise<InstructorApplicationPage> {
    return this.listApplications.execute(query);
  }

  @Post(':id/approve')
  @RequirePermissions('instructor_application:review:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve: grants INSTRUCTOR in the same transaction' })
  @ApiOkResponse({ standardSchema: InstructorApplicationSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'self_decision_forbidden / forbidden' })
  @ApiNotFoundResponse({ description: 'not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition / version_conflict' })
  approve(
    @Param({ schema: InstructorApplicationIdParamsSchema }) params: InstructorApplicationIdParams,
    @Body({ schema: ApproveInstructorApplicationRequestSchema })
    body: ApproveInstructorApplicationRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InstructorApplication> {
    return this.approveApplication.execute({
      actorId: principal.userId,
      applicationId: params.id,
      note: body.note,
      expectedVersion: body.expectedVersion,
    });
  }

  @Post(':id/reject')
  @RequirePermissions('instructor_application:review:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject with a reason (10–1000 characters, mailed to the applicant)' })
  @ApiOkResponse({ standardSchema: InstructorApplicationSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (e.g. missing reason)' })
  @ApiForbiddenResponse({ description: 'self_decision_forbidden / forbidden' })
  @ApiNotFoundResponse({ description: 'not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition / version_conflict' })
  reject(
    @Param({ schema: InstructorApplicationIdParamsSchema }) params: InstructorApplicationIdParams,
    @Body({ schema: RejectInstructorApplicationRequestSchema })
    body: RejectInstructorApplicationRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InstructorApplication> {
    return this.rejectApplication.execute({
      actorId: principal.userId,
      applicationId: params.id,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
    });
  }
}
