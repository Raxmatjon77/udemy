import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AssetIdParams,
  AssetIdParamsSchema,
  type CompleteUploadRequest,
  CompleteUploadRequestSchema,
  type CompleteUploadResponse,
  CompleteUploadResponseSchema,
  type InitiateUploadRequest,
  InitiateUploadRequestSchema,
  type InitiateUploadResponse,
  InitiateUploadResponseSchema,
  type PresignPartsRequest,
  PresignPartsRequestSchema,
  type PresignPartsResponse,
  PresignPartsResponseSchema,
  type UploadStatus,
  UploadStatusSchema,
} from '@udemy/contracts';
import type { Request, Response } from 'express';
import {
  CheckPolicy,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import { AbortUploadCommand } from '../application/use-cases/abort-upload.command';
import { CompleteUploadCommand } from '../application/use-cases/complete-upload.command';
import { GetUploadStatusQuery } from '../application/use-cases/get-upload-status.query';
import { InitiateUploadCommand } from '../application/use-cases/initiate-upload.command';
import { PresignPartsCommand } from '../application/use-cases/presign-parts.command';
import { uploadLocation, withUploadProblems } from './media-http';

const assetIdOf = (req: Request): string => String(req.params.assetId);

/**
 * `/api/v1/media/uploads`: resumable multipart uploads straight to S3 (design §8, D10).
 * Part bytes never pass through the api or the BFF: the browser PUTs each part to its presigned
 * URL with exactly the signed Content-Length.
 */
@ApiTags('media')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@Controller('media/uploads')
export class MediaUploadsController {
  constructor(
    private readonly initiateUpload: InitiateUploadCommand,
    private readonly uploadStatus: GetUploadStatusQuery,
    private readonly presignParts: PresignPartsCommand,
    private readonly completeUpload: CompleteUploadCommand,
    private readonly abortUpload: AbortUploadCommand,
  ) {}

  @Post()
  @RequirePermissions('media_asset:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start an upload',
    description: 'Checks the purpose policy, quota and concurrency; the server chooses the parts.',
  })
  @ApiCreatedResponse({
    standardSchema: InitiateUploadResponseSchema,
    headers: { Location: { description: 'URL of the upload', schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'forbidden' })
  @ApiUnprocessableEntityResponse({
    description: 'unsupported_media_type / upload_too_large / quota_exceeded / validation_failed',
  })
  @ApiTooManyRequestsResponse({ description: 'too_many_uploads / rate_limited' })
  async initiate(
    @Body({ schema: InitiateUploadRequestSchema }) body: InitiateUploadRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InitiateUploadResponse> {
    const result = await this.initiateUpload.execute({ ownerId: principal.userId, ...body });
    res.location(uploadLocation(result.assetId));
    return result;
  }

  @Get(':assetId')
  @CheckPolicy({ resource: 'media_asset', action: 'read', id: assetIdOf })
  @ApiOperation({ summary: 'Upload state and the parts S3 already has (resume)' })
  @ApiOkResponse({ standardSchema: UploadStatusSchema })
  @ApiNotFoundResponse({ description: "media_asset_not_found (also for other users' assets)" })
  status(@Param({ schema: AssetIdParamsSchema }) params: AssetIdParams): Promise<UploadStatus> {
    return this.uploadStatus.execute(params.assetId);
  }

  @Post(':assetId/part-urls')
  @CheckPolicy({ resource: 'media_asset', action: 'upload', id: assetIdOf })
  @HttpCode(HttpStatus.OK)
  // The URLs are bearer capabilities: never cache them.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Presigned part URLs',
    description: 'Each URL signs the exact Content-Length of its part; TTL MEDIA_PART_URL_TTL_S.',
  })
  @ApiOkResponse({ standardSchema: PresignPartsResponseSchema })
  @ApiNotFoundResponse({ description: "media_asset_not_found (also for other users' assets)" })
  @ApiConflictResponse({ description: 'upload_not_in_progress' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (part number > partCount)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  partUrls(
    @Param({ schema: AssetIdParamsSchema }) params: AssetIdParams,
    @Body({ schema: PresignPartsRequestSchema }) body: PresignPartsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PresignPartsResponse> {
    return this.presignParts.execute({
      ownerId: principal.userId,
      assetId: params.assetId,
      partNumbers: body.partNumbers,
    });
  }

  @Post(':assetId/complete')
  @CheckPolicy({ resource: 'media_asset', action: 'upload', id: assetIdOf })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete an upload (idempotent)',
    description: 'Verifies the parts server-side (ListParts) and the object size.',
  })
  @ApiOkResponse({ standardSchema: CompleteUploadResponseSchema })
  @ApiNotFoundResponse({ description: "media_asset_not_found (also for other users' assets)" })
  @ApiConflictResponse({
    description: 'upload_incomplete (+ missingParts) / upload_not_in_progress',
  })
  @ApiUnprocessableEntityResponse({ description: 'upload_size_mismatch' })
  complete(
    @Param({ schema: AssetIdParamsSchema }) params: AssetIdParams,
    @Body({ schema: CompleteUploadRequestSchema }) _body: CompleteUploadRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CompleteUploadResponse> {
    return withUploadProblems(() =>
      this.completeUpload.execute({ ownerId: principal.userId, assetId: params.assetId }),
    );
  }

  @Delete(':assetId')
  @CheckPolicy({ resource: 'media_asset', action: 'upload', id: assetIdOf })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an upload' })
  @ApiNoContentResponse({ description: 'Aborted' })
  @ApiNotFoundResponse({ description: "media_asset_not_found (also for other users' assets)" })
  @ApiConflictResponse({ description: 'upload_not_in_progress' })
  async abort(
    @Param({ schema: AssetIdParamsSchema }) params: AssetIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.abortUpload.execute({ ownerId: principal.userId, assetId: params.assetId });
  }
}
