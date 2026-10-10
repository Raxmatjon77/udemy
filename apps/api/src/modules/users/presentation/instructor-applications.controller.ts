import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  type InstructorApplicationDetail,
  InstructorApplicationDetailSchema,
  type InstructorApplicationIdParams,
  InstructorApplicationIdParamsSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { GetInstructorApplicationQuery } from '../application/use-cases/get-instructor-application.query';

/** `/api/v1/instructor-applications/:id`: own (applicant) or any (admin), design §8. */
@ApiTags('instructor-applications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@Controller('instructor-applications')
export class InstructorApplicationsController {
  constructor(private readonly getApplication: GetInstructorApplicationQuery) {}

  @Get(':id')
  @CheckPolicy({
    resource: 'instructor_application',
    action: 'read',
    id: (req) => String(req.params.id),
  })
  @ApiOperation({ summary: 'An application with its transitions and applicant summary' })
  @ApiOkResponse({ standardSchema: InstructorApplicationDetailSchema })
  @ApiNotFoundResponse({ description: "not_found (also for other users' applications)" })
  get(
    @Param({ schema: InstructorApplicationIdParamsSchema }) params: InstructorApplicationIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InstructorApplicationDetail> {
    return this.getApplication.execute({ principal, applicationId: params.id });
  }
}
