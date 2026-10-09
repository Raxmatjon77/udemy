# Backend Technical Task: Udemy Clone

## Overview

Build a fully functional **online course platform** (Udemy clone) backend using **NestJS**. The platform allows instructors to create and manage courses with video content, students to enroll and track their progress, and admins to manage the platform. The system includes real-time chat support, video streaming, background job processing, and caching.

---

## Tech Stack

| Layer            | Technology       | Purpose                          |
| ---------------- | ---------------- | -------------------------------- |
| Framework        | NestJS 10+       | Backend framework                |
| Language         | TypeScript 5+    | Type safety                      |
| Database         | PostgreSQL 14+   | Primary datastore                |
| ORM              | Prisma 6+        | Database access & migrations     |
| Cache            | Redis 7          | Caching & session store          |
| Object Storage   | MinIO            | S3-compatible file/video storage |
| Job Queue        | BullMQ           | Background job processing        |
| Real-time        | Socket.IO        | WebSocket communication          |
| Auth             | Passport + JWT   | Token-based authentication       |
| Containerization | Docker + Compose | Infrastructure orchestration     |

---

## Database

Design the database schema using Prisma ORM with the following models. All IDs should be UUIDs. Use soft deletes (`deletedAt`) where appropriate.

**Models:** User, Course, Section, Lesson, Category, Enrollment, Review, RefreshToken, Star, Comment, Progress, Upload, Notification, Conversation, Message

**Key relationships:**

- User has roles: `USER` (default), `INSTRUCTOR`, `ADMIN`
- Course belongs to User (author) and Category
- Course has many Sections, each Section has many Lessons
- User can enroll in courses (unique per user+course)
- User can review courses (rating + comment)
- User can star/favorite courses
- User can comment on lessons
- Progress tracks lesson completion per user
- Conversations are between User and Admin with Messages
- RefreshToken stores hashed JWT refresh tokens per user
- Upload tracks media files (VIDEO, IMAGE, DOCUMENT)
- Notification stores user notifications (title, body, isRead)

Design proper indexes, unique constraints, and foreign key relationships based on the features below.

---

## Feature Requirements

All API endpoints must be prefixed with `/api/v1`.

---

### 1. Authentication

Implement JWT-based authentication with access and refresh token pairs.

**Endpoints:**

- `POST /auth/signup` — Register new user (public)
- `POST /auth/signin` — Login and receive token pair (public)
- `POST /auth/logout` — Invalidate refresh token (JWT protected)
- `POST /auth/refresh` — Issue new access token using refresh token (JWT protected)

**Requirements:**

- Validate email uniqueness on signup, hash password with bcrypt
- Generate access + refresh token pair on signup and signin
- Store hashed refresh token in the database
- On logout, set refresh token to `null`
- On refresh, validate current refresh token, issue new tokens, rotate refresh token
- Implement Passport JWT strategy extracting Bearer token from Authorization header
- Validate DTOs: email format, password min 8 chars, name required for signup

---

### 2. User Management

**Endpoints:**

- `GET /user` — Get current user profile (JWT)
- `PATCH /user` — Update profile (name, email) (JWT)
- `DELETE /user` — Soft delete account (JWT)

**Requirements:**

- Fetch user by ID from JWT payload with Redis caching (TTL-based)
- Cache invalidation on profile update
- Soft delete by setting `deletedAt` timestamp

---

### 3. Course Browsing (Public)

Read-only endpoints for students browsing the catalog.

**Endpoints:**

- `GET /course` — List all published courses (paginated, public)
- `GET /course/:id` — Get course detail with sections, lessons, author, category (public)
- `GET /sections?courseId=X` — List sections for a course (paginated, public)
- `GET /sections/:id` — Get section with its lessons (public)
- `GET /lessons/:id` — Get lesson detail with user's progress status (JWT)
- `GET /lessons/section/:sectionId` — Get all lessons in a section (public)

**Requirements:**

- Pagination via `pageNumber` and `pageSize` query parameters
- Course detail includes nested sections and lessons
- Lesson detail includes authenticated user's completion status

---

### 4. Dashboard — Content Management (Instructor/Admin)

All dashboard endpoints require JWT authentication.

#### 4.1 Category Management (Admin Only)

- `GET /dashboard/category` — List categories (paginated)
- `GET /dashboard/category/:id` — Get category
- `POST /dashboard/category` — Create category with image upload
- `PATCH /dashboard/category/:id` — Update category

Restrict all category endpoints to `ADMIN` role using `@Roles()` guard.

#### 4.2 Course Management (Instructor)

- `POST /dashboard/course` — Create course with thumbnail/image upload
- `GET /dashboard/course` — List instructor's own courses (paginated)
- `GET /dashboard/course/:id` — Get course detail
- `PATCH /dashboard/course/:id` — Update course with optional image replacement
- `DELETE /dashboard/course/:id` — Delete course (cascade to sections and lessons)

Instructors must only see and manage their own courses.

#### 4.3 Section Management

- `POST /sections` — Create section in a course
- `GET /sections` — List sections (filtered by courseId)
- `GET /sections/:id` — Get section
- `PATCH /sections/:id` — Update section (title, order)
- `DELETE /sections/:id` — Delete section

#### 4.4 Lesson Management

- `POST /dashboard/lessons` — Create lesson (title, videoUrl, freePreview, sectionId, order)
- `GET /dashboard/lessons/:id` — Get lesson

---

### 5. Enrollment

**Endpoints:**

- `POST /enroll/:courseId` — Enroll in a course (JWT)
- `GET /enroll` — List user's enrollments with course details (JWT, paginated)

**Requirements:**

- Prevent duplicate enrollment (unique constraint on userId + courseId)
- Validate course exists before enrolling
- Return enrollment with nested course information

---

### 6. Reviews & Ratings

**Endpoints:**

- `POST /reviews/:courseId` — Create review (JWT)
- `GET /reviews/:courseId` — List course reviews (public, paginated)
- `PATCH /reviews/:id` — Update own review (JWT)
- `DELETE /reviews/:id` — Soft delete own review (JWT)
- `GET /reviews/user` — Get current user's reviews (JWT)

**Requirements:**

- Only enrolled users can review a course
- One review per user per course
- Rating: integer 1–5
- Only the review author can update or delete
- Soft delete reviews (set `deletedAt`)

---

### 7. Video Upload & Streaming

Implement chunked video upload and HTTP range-based streaming using MinIO (S3-compatible).

**Upload Endpoints:**

- `POST /upload/init?key=filename` — Initialize multipart upload, return `uploadId` and `key` (JWT)
- `POST /upload/chunk` — Upload a file chunk with `key`, `uploadId`, `partNumber` in body, return `ETag` and `PartNumber` (JWT)
- `POST /upload/complete` — Finalize upload with `key`, `uploadId`, and parts array `[{ETag, PartNumber}]` (JWT)

**Streaming Endpoint:**

- `GET /stream/:key` — Stream video with HTTP Range header support (public)

**Requirements:**

- Configure AWS SDK S3 client pointing to MinIO with `forcePathStyle: true`
- Support `Range` header for partial content delivery
- Return `206 Partial Content` with proper `Content-Range` and `Content-Length` headers
- Use `FileInterceptor` for chunk uploads

---

### 8. Real-time Chat (WebSocket)

Implement a support chat system where users can message admins in real-time.

**REST Endpoints:**

- `POST /chat/conversation` — Create new conversation (JWT)
- `GET /chat/conversations` — List user's conversations (JWT)
- `POST /chat/assign-admin` — Assign admin to a conversation (JWT + ADMIN)

**WebSocket Gateway Events:**

- `sendMessage` (client → server) — Send message in a conversation
- `receiveMessage` (server → client) — Broadcast received message to room

**Requirements:**

- Verify JWT token on WebSocket connection in `handleConnection`
- Join socket rooms by user ID
- Persist all messages in the database
- Broadcast messages to the conversation's participants
- Include sender info in message payload
- Admin assignment to handle conversations

---

### 9. Background Jobs (Queue)

Implement background job processing using BullMQ with Redis.

**Requirements:**

- Register queues: `mail` and `audio`
- **Mail Queue:** Send welcome email on signup, enrollment confirmation
- Implement `JobsProcessor` extending `WorkerHost` with concurrency of 10
- Implement `MailService` for email delivery
- Configure retry policy: 3 attempts with exponential backoff
- Set up **Bull Board** admin dashboard at `/queues` route for monitoring jobs

---

### 10. Notifications

Implement a notification system for user events.

**Endpoints:**

- `GET /notifications` — List user's notifications (JWT, paginated)
- `PATCH /notifications/:id` — Mark notification as read (JWT)
- `DELETE /notifications/:id` — Delete notification (JWT)

**Requirements:**

- Create notifications on key events: enrollment, new review on instructor's course, chat message
- Support marking as read (single and bulk)
- Support pagination

---

### 11. Stars / Favorites

Implement course favoriting functionality.

**Endpoints:**

- `POST /stars/:courseId` — Star/favorite a course (JWT)
- `DELETE /stars/:courseId` — Remove star (JWT)
- `GET /stars` — List user's starred courses (JWT)

**Requirements:**

- Prevent duplicate stars per user per course
- Return starred courses with course details

---

### 12. Lesson Comments

Implement a commenting system for lessons.

**Endpoints:**

- `POST /comments/:lessonId` — Add comment to a lesson (JWT)
- `GET /comments/:lessonId` — List lesson comments (public, paginated)
- `DELETE /comments/:id` — Delete own comment (JWT)

**Requirements:**

- Only enrolled users can comment on lessons
- Support pagination
- Only comment author can delete their comment

---

### 13. Progress Tracking

Track user progress through course lessons.

**Endpoints:**

- `POST /progress/:lessonId` — Mark/unmark lesson as completed (JWT)
- `GET /progress/:courseId` — Get course progress summary with completion percentage (JWT)

**Requirements:**

- Toggle lesson completion status
- Calculate course completion percentage: `completed lessons / total lessons * 100`
- Only enrolled users can track progress

---

### 14. Search & Filtering

Implement course search and filtering.

**Endpoints:**

- `GET /search/courses` — Search and filter courses (public)

**Requirements:**

- Full-text search on course title and description
- Filter by: category, price range (min/max), rating, instructor
- Sort by: price, rating, newest, popularity (enrollment count)
- Pagination support

---

## Guards, Interceptors & Cross-cutting Concerns

### JWT Guard

- Extend `AuthGuard('jwt')` from Passport
- Apply to all protected routes

### Roles Guard

- Read `@Roles()` decorator metadata, compare against `request.user.role`
- Return `ForbiddenException` if role doesn't match

### Roles Decorator

- Custom decorator using `SetMetadata` to define required roles
- Roles enum: `USER`, `INSTRUCTOR`, `ADMIN`

### Logger Interceptor (Global)

- Log every request: timestamp, HTTP method, URL, headers, body, query params
- Log every response: status code, duration (ms), response body
- Log errors: status code, duration, error message
- Generate unique `requestId` (UUID) for request tracing

### Verify User Interceptor

- Extract from request headers: IP address, User-Agent, device ID
- Attach device info to request for downstream processing

### Global Validation Pipe

- Enable `class-validator` globally via `ValidationPipe`
- Auto-transform payloads to DTO instances

---

## Infrastructure

### Docker Compose

Set up the following services:

- **app** — NestJS application (Node 20 Alpine, port 4000)
- **postgres** — PostgreSQL 14 with persistent volume
- **minio** — MinIO S3-compatible storage (ports 9000 API, 9001 console) with persistent volume
- **redis** — Redis 7 (port 6379)

Use named volumes for data persistence and an overlay network for service communication.

### Dockerfile

- Multi-stage build using `node:20-alpine`
- Builder stage: install deps, generate Prisma client, build app
- Runner stage: copy artifacts, run migrations on startup, start server

### Environment Variables

```
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/udemy?schema=public
JWT_AT_SECRET=<access-token-secret>
JWT_RT_SECRET=<refresh-token-secret>
MINIO_USER=<minio-access-key>
MINIO_PASS=<minio-secret-key>
MINIO_PORT=9000
MINIO_URL=http://localhost:9000
MINIO_BUCKET_VIDEO=videos
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Application Bootstrap

- Listen on port `4000`
- Global prefix: `/api/v1`
- Enable CORS
- Body parser limit: `5MB`
- Apply global `ValidationPipe` and `LoggerInterceptor`
- Enable shutdown hooks

### MinIO / S3 Client Service

Implement a reusable MinIO service with methods:

- `uploadFile(bucket, file)` — Upload a single file
- `getFileUrl(bucket, objectName)` — Generate a presigned URL
- `deleteFile(bucket, objectName)` — Delete a file

### Prisma Setup

- Global `PrismaModule` with `PrismaService` extending `PrismaClient`
- Connect on module init, disconnect on destroy
- Use `DATABASE_URL` from environment

---

## Evaluation Criteria

### Must Have

- [ ] Working authentication with JWT access/refresh tokens
- [ ] Role-based authorization (USER, INSTRUCTOR, ADMIN)
- [ ] Full CRUD for courses, sections, and lessons
- [ ] Category management (Admin only)
- [ ] Course enrollment with duplicate prevention
- [ ] Reviews and ratings system
- [ ] Chunked video upload to MinIO
- [ ] Video streaming with HTTP range requests
- [ ] Real-time chat via WebSocket (Socket.IO)
- [ ] Background job processing with BullMQ
- [ ] Redis caching for frequently accessed data
- [ ] Docker Compose setup with all services
- [ ] Prisma migrations and schema
- [ ] Global validation, logging interceptor
- [ ] Proper error handling and HTTP status codes
- [ ] Clean, modular NestJS architecture

### Should Have

- [ ] Notification system (CRUD + event-driven creation)
- [ ] Stars/favorites functionality
- [ ] Lesson comments
- [ ] Progress tracking with completion percentage
- [ ] Search and filtering for courses
- [ ] Pagination on all list endpoints
- [ ] Input validation with class-validator DTOs

### Nice to Have

- [ ] Swagger/OpenAPI documentation (`@nestjs/swagger`)
- [ ] Unit tests for services (Jest)
- [ ] E2E tests for critical flows (auth, enrollment, video upload)
- [ ] CI/CD pipeline configuration (GitLab CI or GitHub Actions)
- [ ] Payment integration (Stripe) for course purchases
- [ ] Rate limiting
- [ ] Health check endpoint

---

## Submission

1. Push your code to a Git repository
2. Include a `README.md` with:
   - Setup instructions
   - How to run with Docker Compose
   - API documentation or Postman collection link
3. Ensure `docker-compose up` starts all services and the app is functional
4. Include Prisma migrations in the repository
