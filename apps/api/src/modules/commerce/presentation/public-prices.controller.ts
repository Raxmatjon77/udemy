import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PUBLIC_PRICES_CACHE_CONTROL,
  type PublicPricesQuery,
  PublicPricesQuerySchema,
  type PublicPricesResponse,
  PublicPricesResponseSchema,
} from '@udemy/contracts';
import { Public } from '../../../shared/auth';
import { GetPublicPricesQuery } from '../application/use-cases/get-public-prices.query';

/**
 * `/api/v1/commerce/prices` (design §8, public: student BFF client credentials, no session).
 * Course cards and landing pages fetch their prices in one batch per page.
 */
@ApiTags('commerce-public')
@Public()
@Controller('commerce')
export class PublicPricesController {
  constructor(private readonly prices: GetPublicPricesQuery) {}

  @Get('prices')
  @Header('Cache-Control', PUBLIC_PRICES_CACHE_CONTROL)
  @ApiOperation({
    summary: 'Prices of published courses (batch, at most 48 ids)',
    description:
      'Ids that are not published or have no price are omitted. `?courseIds=a,b` or repeated.',
  })
  @ApiOkResponse({ standardSchema: PublicPricesResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  list(
    @Query({ schema: PublicPricesQuerySchema }) query: PublicPricesQuery,
  ): Promise<PublicPricesResponse> {
    return this.prices.execute(query.courseIds);
  }
}
