import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type RecentSalePage,
  RecentSalePageSchema,
  type RecentSalesQuery,
  RecentSalesQuerySchema,
  type SalesSummary,
  type SalesSummaryQuery,
  SalesSummaryQuerySchema,
  SalesSummarySchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import {
  GetSalesSummaryQuery,
  ListRecentSalesQuery,
} from '../application/use-cases/instructor-sales.queries';

/**
 * `/api/v1/instructor/sales` (design §5, §8, instructor BFF, `sales:read:own`): always the
 * principal's own sales (`order_lines.instructor_id`); a foreign `courseId` filter is simply
 * an empty page. No buyer PII.
 */
@ApiTags('commerce')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('sales:read:own')
@Controller('instructor/sales')
export class InstructorSalesController {
  constructor(
    private readonly summary: GetSalesSummaryQuery,
    private readonly recent: ListRecentSalesQuery,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'My sales in [from, to) (≤ 366 days): totals and per course, 70% share from SQL',
  })
  @ApiOkResponse({ standardSchema: SalesSummarySchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  getSummary(
    @Query({ schema: SalesSummaryQuerySchema }) query: SalesSummaryQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SalesSummary> {
    return this.summary.execute(principal.userId, query);
  }

  @Get()
  @ApiOperation({ summary: 'My recent sales, newest first (keyset)' })
  @ApiOkResponse({ standardSchema: RecentSalePageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (cursor)' })
  list(
    @Query({ schema: RecentSalesQuerySchema }) query: RecentSalesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecentSalePage> {
    return this.recent.execute(principal.userId, {
      limit: query.limit,
      ...(query.courseId === undefined ? {} : { courseId: query.courseId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }
}
