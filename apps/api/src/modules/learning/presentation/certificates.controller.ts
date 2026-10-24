import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminCertificate,
  type AdminCertificateReasonRequest,
  AdminCertificateReasonRequestSchema,
  AdminCertificateSchema,
  type AdminUserCertificates,
  AdminUserCertificatesSchema,
  type Certificate,
  CERTIFICATE_VERIFICATION_CACHE_CONTROL,
  type CertificateCodeParams,
  CertificateCodeParamsSchema,
  type CertificateIdParams,
  CertificateIdParamsSchema,
  type CertificatePage,
  CertificatePageSchema,
  CertificateSchema,
  type CertificateVerification,
  CertificateVerificationSchema,
  type MyCertificatesQuery,
  MyCertificatesQuerySchema,
  type SignedUrl,
  SignedUrlSchema,
  type UserIdParams,
  UserIdParamsSchema,
} from '@udemy/contracts';
import {
  AllowClients,
  CheckPolicy,
  type ClientContext,
  CurrentClient,
  CurrentPrincipal,
  type Principal,
  Public,
  RequirePermissions,
} from '../../../shared/auth';
import {
  AdminCertificateActionCommand,
  AdminListUserCertificatesQuery,
  GetMyCertificatePdfQuery,
  GetMyCertificateQuery,
  GetPublicCertificatePdfQuery,
  ListMyCertificatesQuery,
  VerifyCertificateQuery,
} from '../application/use-cases/certificates.use-cases';
import { certificateIdOf, SIGNED_URL_CACHE_CONTROL } from './learning-http';

/**
 * `/api/v1/me/certificates/...`: the student's own certificates (design §8 "Student", D7,
 * P5-T11). Certificates are issued by the worker; the PDF is a 15 min presigned GET once it is
 * rendered (409 `certificate_pdf_pending` before). IDOR: `certificate` ids resolve to their
 * owner (`@CheckPolicy`, foreign = 404).
 */
@ApiTags('learning')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiBadRequestResponse({ description: 'validation_failed' })
@Controller('me/certificates')
export class MyCertificatesController {
  constructor(
    private readonly listMine: ListMyCertificatesQuery,
    private readonly getMine: GetMyCertificateQuery,
    private readonly myPdf: GetMyCertificatePdfQuery,
  ) {}

  @Get()
  @RequirePermissions('certificate:read:own')
  @ApiOperation({ summary: 'My certificates (newest first, keyset paginated)' })
  @ApiOkResponse({ standardSchema: CertificatePageSchema })
  @ApiForbiddenResponse({ description: 'forbidden' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Query({ schema: MyCertificatesQuerySchema }) query: MyCertificatesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CertificatePage> {
    return this.listMine.execute({
      userId: principal.userId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':certificateId')
  @CheckPolicy({ resource: 'certificate', action: 'read', id: certificateIdOf })
  @ApiOperation({ summary: 'One of my certificates' })
  @ApiOkResponse({ standardSchema: CertificateSchema })
  @ApiNotFoundResponse({ description: 'not_found / certificate_not_found' })
  get(
    @Param({ schema: CertificateIdParamsSchema }) params: CertificateIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Certificate> {
    return this.getMine.execute({
      userId: principal.userId,
      certificateId: params.certificateId,
    });
  }

  @Get(':certificateId/pdf')
  @Header('Cache-Control', SIGNED_URL_CACHE_CONTROL)
  @CheckPolicy({ resource: 'certificate', action: 'read', id: certificateIdOf })
  @ApiOperation({
    summary: 'Download my certificate PDF (presigned, 15 min)',
    description: '409 `certificate_pdf_pending` while the PDF is being prepared.',
  })
  @ApiOkResponse({ standardSchema: SignedUrlSchema })
  @ApiNotFoundResponse({ description: 'not_found / certificate_not_found' })
  @ApiConflictResponse({ description: 'certificate_pdf_pending' })
  pdf(
    @Param({ schema: CertificateIdParamsSchema }) params: CertificateIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SignedUrl> {
    return this.myPdf.execute({
      userId: principal.userId,
      certificateId: params.certificateId,
    });
  }
}

/**
 * `/api/v1/certificates/:code`: public verification (design §8 "Public": student BFF client
 * credentials, no session; the web page sets `noindex` and `Referrer-Policy: no-referrer`).
 * 120 requests per minute per end-user IP.
 */
@ApiTags('learning-public')
@Public()
@AllowClients('student')
@Controller('certificates')
export class PublicCertificatesController {
  constructor(
    private readonly verify: VerifyCertificateQuery,
    private readonly publicPdf: GetPublicCertificatePdfQuery,
  ) {}

  @Get(':code')
  @Header('Cache-Control', CERTIFICATE_VERIFICATION_CACHE_CONTROL)
  @ApiOperation({
    summary: 'Verify a certificate by its public code',
    description: 'What the certificate states and whether it is ACTIVE or REVOKED.',
  })
  @ApiOkResponse({ standardSchema: CertificateVerificationSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (malformed code)' })
  @ApiNotFoundResponse({ description: 'certificate_not_found' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  verification(
    @Param({ schema: CertificateCodeParamsSchema }) params: CertificateCodeParams,
    @CurrentClient() client: ClientContext,
  ): Promise<CertificateVerification> {
    return this.verify.execute({ code: params.code, ip: client.ip });
  }

  @Get(':code/pdf')
  @Header('Cache-Control', SIGNED_URL_CACHE_CONTROL)
  @ApiOperation({
    summary: 'Download a certificate PDF by its public code (ACTIVE only, presigned, 15 min)',
  })
  @ApiOkResponse({ standardSchema: SignedUrlSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (malformed code)' })
  @ApiNotFoundResponse({ description: 'certificate_not_found (also when revoked)' })
  @ApiConflictResponse({ description: 'certificate_pdf_pending' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  pdf(
    @Param({ schema: CertificateCodeParamsSchema }) params: CertificateCodeParams,
    @CurrentClient() client: ClientContext,
  ): Promise<SignedUrl> {
    return this.publicPdf.execute({ code: params.code, ip: client.ip });
  }
}

/**
 * Admin certificate support (design §8 "Admin", D7; the user detail "Certificates" tab):
 * list a user's certificates with their transition log, revoke or reinstate with a reason
 * (cause ADMIN; an admin revocation is never undone by a re-enrollment).
 */
@ApiTags('learning-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@ApiBadRequestResponse({ description: 'validation_failed' })
@RequirePermissions('certificate:manage:any')
@Controller('admin')
export class AdminCertificatesController {
  constructor(
    private readonly listForUser: AdminListUserCertificatesQuery,
    private readonly action: AdminCertificateActionCommand,
  ) {}

  @Get('users/:userId/certificates')
  @ApiOperation({ summary: "A user's certificates with their transitions" })
  @ApiOkResponse({ standardSchema: AdminUserCertificatesSchema })
  @ApiNotFoundResponse({ description: 'user_not_found' })
  userCertificates(
    @Param({ schema: UserIdParamsSchema }) params: UserIdParams,
  ): Promise<AdminUserCertificates> {
    return this.listForUser.execute(params.userId);
  }

  @Post('certificates/:certificateId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a certificate (reason required)',
    description: 'Sticks: a later re-enrollment does not reinstate it automatically.',
  })
  @ApiOkResponse({ standardSchema: AdminCertificateSchema })
  @ApiNotFoundResponse({ description: 'certificate_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (already revoked)' })
  revoke(
    @Param({ schema: CertificateIdParamsSchema }) params: CertificateIdParams,
    @Body({ schema: AdminCertificateReasonRequestSchema }) body: AdminCertificateReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminCertificate> {
    return this.action.execute({
      actorId: principal.userId,
      certificateId: params.certificateId,
      action: 'REVOKE',
      reason: body.reason,
    });
  }

  @Post('certificates/:certificateId/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reinstate a revoked certificate (reason required)' })
  @ApiOkResponse({ standardSchema: AdminCertificateSchema })
  @ApiNotFoundResponse({ description: 'certificate_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (already active)' })
  reinstate(
    @Param({ schema: CertificateIdParamsSchema }) params: CertificateIdParams,
    @Body({ schema: AdminCertificateReasonRequestSchema }) body: AdminCertificateReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminCertificate> {
    return this.action.execute({
      actorId: principal.userId,
      certificateId: params.certificateId,
      action: 'REINSTATE',
      reason: body.reason,
    });
  }
}
