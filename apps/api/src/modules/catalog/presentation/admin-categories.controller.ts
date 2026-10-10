import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminCategoryTreeResponse,
  AdminCategoryTreeResponseSchema,
  type Category,
  type CategoryIdParams,
  CategoryIdParamsSchema,
  CategorySchema,
  type CreateCategoryRequest,
  CreateCategoryRequestSchema,
  type ReorderCategoriesRequest,
  ReorderCategoriesRequestSchema,
  type UpdateCategoryRequest,
  UpdateCategoryRequestSchema,
} from '@udemy/contracts';
import { RequirePermissions } from '../../../shared/auth';
import { AdminListCategoriesQuery } from '../application/use-cases/admin-list-categories.query';
import { CreateCategoryCommand } from '../application/use-cases/create-category.command';
import { DeleteCategoryCommand } from '../application/use-cases/delete-category.command';
import { ReorderCategoriesCommand } from '../application/use-cases/reorder-categories.command';
import { UpdateCategoryCommand } from '../application/use-cases/update-category.command';

/** `/api/v1/admin/categories`: the two-level category tree (design §5, §8; `category:manage`). */
@ApiTags('catalog-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('category:manage')
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(
    private readonly listCategories: AdminListCategoriesQuery,
    private readonly createCategory: CreateCategoryCommand,
    private readonly updateCategory: UpdateCategoryCommand,
    private readonly reorderCategories: ReorderCategoriesCommand,
    private readonly deleteCategory: DeleteCategoryCommand,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The whole tree (inactive included) with course counts' })
  @ApiOkResponse({ standardSchema: AdminCategoryTreeResponseSchema })
  list(): Promise<AdminCategoryTreeResponse> {
    return this.listCategories.execute();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a group (no parent) or a subcategory (depth-1 parent)' })
  @ApiCreatedResponse({ standardSchema: CategorySchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'category_not_found (parent)' })
  @ApiConflictResponse({ description: 'slug_taken' })
  @ApiUnprocessableEntityResponse({ description: 'category_depth_exceeded' })
  create(
    @Body({ schema: CreateCategoryRequestSchema }) body: CreateCategoryRequest,
  ): Promise<Category> {
    return this.createCategory.execute(body);
  }

  @Put('order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reorder the children of one parent (null = groups)' })
  @ApiNoContentResponse({ description: 'Reordered' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'category_not_found (parent)' })
  @ApiConflictResponse({ description: 'order_mismatch' })
  async reorder(
    @Body({ schema: ReorderCategoriesRequestSchema }) body: ReorderCategoriesRequest,
  ): Promise<void> {
    await this.reorderCategories.execute(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, re-slug, (de)activate, or move a subcategory' })
  @ApiOkResponse({ standardSchema: CategorySchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'category_not_found' })
  @ApiConflictResponse({ description: 'slug_taken' })
  @ApiUnprocessableEntityResponse({ description: 'category_depth_exceeded' })
  update(
    @Param({ schema: CategoryIdParamsSchema }) params: CategoryIdParams,
    @Body({ schema: UpdateCategoryRequestSchema }) body: UpdateCategoryRequest,
  ): Promise<Category> {
    return this.updateCategory.execute({ id: params.id, ...body });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unused category (otherwise deactivate it)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'category_not_found' })
  @ApiConflictResponse({ description: 'category_in_use' })
  async remove(@Param({ schema: CategoryIdParamsSchema }) params: CategoryIdParams): Promise<void> {
    await this.deleteCategory.execute(params.id);
  }
}
