# API overview
All paths prefixed `/api`. Protected endpoints require `Authorization: Bearer <JWT>`.
- `GET /health`
- `POST /auth/register` `{name,email,password}`; public signup always creates a student.
- `POST /auth/login` `{email,password}`
- `GET /auth/me` safe current account profile
- `POST /auth/logout` revoke tokens
- `POST /auth/bootstrap-admin` one-time setup using `BOOTSTRAP_ADMIN_KEY`
- `GET /auth/admin/users` paginated/filterable admin-only directory
- `PATCH /auth/admin/users/:id` admin-only role/status update
- `GET /courses`, `GET /courses/:id`
- `POST /courses` instructor/admin; course JSON schema
- `PATCH /courses/:id` owner/admin
- `POST /courses/:id/enroll` student (free course flow)
- `GET /me/enrollments`
- `POST /enrollments/:id/lessons/:lessonIndex/complete`
- `POST /enrollments/:id/quizzes/:quizIndex/submit` `{answers:[optionIndex,...]}`
- `GET /enrollments/:id/certificate` PDF after all lessons complete
- `GET /instructor/analytics`
- `POST /payments/order` `{courseId}`; `POST /payments/verify` Razorpay signature fields
- `POST /live/token` `{room}`
- `POST /videos/upload-url` `{filename,contentType}`; presigned source upload
- `POST /videos/process` `{key}`; `GET /videos/jobs/:id`


## Phase 2: Instructor course studio
Instructor/admin session required: `GET /api/instructor/courses/mine`, `POST /api/instructor/courses`, `GET/PATCH /api/instructor/courses/:id`, `POST /api/instructor/courses/:id/lessons`, `PATCH/DELETE /api/instructor/courses/:id/lessons/:lessonId`, `POST /api/instructor/courses/:id/lessons/:lessonId/upload-intent`, `POST /api/instructor/courses/assets/:assetId/upload-complete`, `GET /api/instructor/courses/assets/:assetId`, `POST /api/instructor/courses/:id/publish`, `POST /api/instructor/courses/:id/unpublish`. Details and request examples are documented in `PHASE2-COURSE-STUDIO.md`.
