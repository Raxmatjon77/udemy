import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
  type CourseDetail,
  CourseDetailSchema,
  type CreateCourseRequest,
  CreateCourseRequestSchema,
  type MyCoursePage,
  MyCoursePageSchema,
  type MyCoursesQuery,
  MyCoursesQuerySchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { CreateCourseCommand } from '../application/use-cases/create-course.command';
import { ListMyCoursesQuery } from '../application/use-cases/list-my-courses.query';
import { courseLocation } from './catalog-http';

/** `/api/v1/instructor/courses`: the instructor's own courses (design §8). */
@ApiTags('catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden (not an instructor)' })
@Controller('instructor/courses')
export class InstructorCoursesController {
  constructor(
    private readonly listMyCourses: ListMyCoursesQuery,
    private readonly createCourse: CreateCourseCommand,
  ) {}

  @Get()
  @RequirePermissions('course:read:own')
  @ApiOperation({ summary: 'My courses, most recently changed first (with status badges)' })
  @ApiOkResponse({ standardSchema: MyCoursePageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Query({ schema: MyCoursesQuerySchema }) query: MyCoursesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyCoursePage> {
    return this.listMyCourses.execute({
      ownerId: principal.userId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @RequirePermissions('course:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a draft course',
    description: 'The URL slug is generated from the title (editable until the first publication).',
  })
  @ApiCreatedResponse({
    standardSchema: CourseDetailSchema,
    headers: { Location: { description: 'URL of the course', schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'category_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'category_inactive / category_not_leaf' })
  async create(
    @Body({ schema: CreateCourseRequestSchema }) body: CreateCourseRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CourseDetail> {
    const course = await this.createCourse.execute({
      ownerId: principal.userId,
      title: body.title,
      categoryId: body.categoryId,
    });
    res.location(courseLocation(course.id));
    return course;
  }
}
