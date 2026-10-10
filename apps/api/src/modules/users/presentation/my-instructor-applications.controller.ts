import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
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
  type InstructorApplication,
  type InstructorApplicationIdParams,
  InstructorApplicationIdParamsSchema,
  InstructorApplicationSchema,
  type MyInstructorApplicationsResponse,
  MyInstructorApplicationsResponseSchema,
  type SubmitInstructorApplicationRequest,
  SubmitInstructorApplicationRequestSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import {
  CheckPolicy,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import { ListMyInstructorApplicationsQuery } from '../application/use-cases/list-my-instructor-applications.query';
import { SubmitInstructorApplicationCommand } from '../application/use-cases/submit-instructor-application.command';
import { WithdrawInstructorApplicationCommand } from '../application/use-cases/withdraw-instructor-application.command';
import { applicationLocation } from './locations';

/** `/api/v1/me/instructor-applications`: the caller's own applications (design §8). */
@ApiTags('instructor-applications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@Controller('me/instructor-applications')
export class MyInstructorApplicationsController {
  constructor(
    private readonly submit: SubmitInstructorApplicationCommand,
    private readonly listMine: ListMyInstructorApplicationsQuery,
    private readonly withdrawApplication: WithdrawInstructorApplicationCommand,
  ) {}

  @Post()
  @RequirePermissions('instructor_application:create:own')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Apply to become an instructor',
    description: 'Needs a verified email; one PENDING application at a time.',
  })
  @ApiCreatedResponse({
    standardSchema: InstructorApplicationSchema,
    headers: {
      Location: { description: 'URL of the new application', schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'email_not_verified / account_banned / forbidden' })
  @ApiConflictResponse({ description: 'application_already_pending / already_instructor' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (domain rules)' })
  async create(
    @Body({ schema: SubmitInstructorApplicationRequestSchema })
    body: SubmitInstructorApplicationRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InstructorApplication> {
    const application = await this.submit.execute({ applicantId: principal.userId, form: body });
    res.location(applicationLocation(application.id));
    return application;
  }

  @Get()
  @RequirePermissions('instructor_application:read:own')
  @ApiOperation({ summary: 'My applications, newest first, with transitions' })
  @ApiOkResponse({ standardSchema: MyInstructorApplicationsResponseSchema })
  @ApiForbiddenResponse({ description: 'forbidden' })
  list(@CurrentPrincipal() principal: Principal): Promise<MyInstructorApplicationsResponse> {
    return this.listMine.execute(principal.userId);
  }

  @Post(':id/withdraw')
  @CheckPolicy({
    resource: 'instructor_application',
    action: 'withdraw',
    id: (req) => String(req.params.id),
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my pending application' })
  @ApiOkResponse({ standardSchema: InstructorApplicationSchema })
  @ApiNotFoundResponse({ description: "not_found (also for other users' applications)" })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  withdraw(
    @Param({ schema: InstructorApplicationIdParamsSchema }) params: InstructorApplicationIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InstructorApplication> {
    return this.withdrawApplication.execute({
      actorId: principal.userId,
      applicationId: params.id,
    });
  }
}
