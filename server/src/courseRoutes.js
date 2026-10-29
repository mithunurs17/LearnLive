
import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { Course, VideoAsset } from './models.js';
import { auth, roles } from './middleware.js';

const router = Router();

const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024;

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm'
]);

const s3 = new S3Client({
  region: process.env.AWS_REGION,

  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    : undefined
});

const validId = (id) =>
  mongoose.isValidObjectId(id);

const fail = (res, status, error) =>
  res.status(status).json({ error });

const ownerOrAdmin = (course, user) =>
  user.role === 'admin' ||
  String(course.instructor) === user.id;

router.use(auth);

/* =========================================
   GET MY COURSES
========================================= */

router.get(
  '/mine',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      const filter =
        req.user.role === 'admin'
          ? {}
          : { instructor: req.user.id };

      const courses = await Course.find(filter)
        .sort({ updatedAt: -1 })
        .select('-quizzes.questions.correctIndex');

      res.json({ courses });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   CREATE COURSE
========================================= */

router.post(
  '/',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      const {
        title,
        description = '',
        category = '',
        pricePaise = 0
      } = req.body || {};

      if (
        typeof title !== 'string' ||
        title.trim().length < 3 ||
        title.trim().length > 180
      ) {
        return fail(
          res,
          400,
          'Course title must be 3–180 characters'
        );
      }

      if (
        typeof description !== 'string' ||
        description.length > 10000
      ) {
        return fail(
          res,
          400,
          'Description must be at most 10,000 characters'
        );
      }

      if (
        typeof category !== 'string' ||
        category.length > 100
      ) {
        return fail(
          res,
          400,
          'Category must be at most 100 characters'
        );
      }

      if (
        !Number.isSafeInteger(pricePaise) ||
        pricePaise < 0
      ) {
        return fail(
          res,
          400,
          'pricePaise must be a non-negative integer'
        );
      }

      const course = await Course.create({
        title: title.trim(),
        description,
        category,
        pricePaise,
        instructor: req.user.id,
        published: false,
        lessons: []
      });

      return res.status(201).json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   GET COURSE FOR INSTRUCTOR
========================================= */

router.get(
  '/:id',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return fail(res, 400, 'Invalid course ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      return res.json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   UPDATE COURSE
========================================= */

router.patch(
  '/:id',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return fail(res, 400, 'Invalid course ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      const allowedFields = [
        'title',
        'description',
        'category',
        'pricePaise'
      ];

      for (const key of allowedFields) {
        if (!Object.hasOwn(req.body || {}, key)) {
          continue;
        }

        const value = req.body[key];

        if (
          key === 'title' &&
          (
            typeof value !== 'string' ||
            value.trim().length < 3 ||
            value.trim().length > 180
          )
        ) {
          return fail(res, 400, 'Invalid title');
        }

        if (
          key === 'description' &&
          (
            typeof value !== 'string' ||
            value.length > 10000
          )
        ) {
          return fail(res, 400, 'Invalid description');
        }

        if (
          key === 'category' &&
          (
            typeof value !== 'string' ||
            value.length > 100
          )
        ) {
          return fail(res, 400, 'Invalid category');
        }

        if (
          key === 'pricePaise' &&
          (
            !Number.isSafeInteger(value) ||
            value < 0
          )
        ) {
          return fail(res, 400, 'Invalid pricePaise');
        }

        course[key] =
          key === 'title'
            ? value.trim()
            : value;
      }

      await course.save();

      return res.json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   ADD LESSON
========================================= */

router.post(
  '/:id/lessons',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return fail(res, 400, 'Invalid course ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      const {
        title,
        description = ''
      } = req.body || {};

      if (
        typeof title !== 'string' ||
        title.trim().length < 2 ||
        title.trim().length > 180
      ) {
        return fail(
          res,
          400,
          'Lesson title must be 2–180 characters'
        );
      }

      if (
        typeof description !== 'string' ||
        description.length > 4000
      ) {
        return fail(
          res,
          400,
          'Invalid lesson description'
        );
      }

      course.lessons.push({
        title: title.trim(),
        description,
        order: course.lessons.length,
        videoStatus: 'missing'
      });

      await course.save();

      return res.status(201).json({
        course,
        lesson: course.lessons.at(-1)
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   UPDATE LESSON
========================================= */

router.patch(
  '/:id/lessons/:lessonId',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (
        !validId(req.params.id) ||
        !validId(req.params.lessonId)
      ) {
        return fail(res, 400, 'Invalid ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      const lesson = course.lessons.id(
        req.params.lessonId
      );

      if (!lesson) {
        return fail(res, 404, 'Lesson not found');
      }

      const {
        title,
        description,
        order
      } = req.body || {};

      if (title !== undefined) {
        if (
          typeof title !== 'string' ||
          title.trim().length < 2 ||
          title.trim().length > 180
        ) {
          return fail(
            res,
            400,
            'Invalid lesson title'
          );
        }

        lesson.title = title.trim();
      }

      if (description !== undefined) {
        if (
          typeof description !== 'string' ||
          description.length > 4000
        ) {
          return fail(
            res,
            400,
            'Invalid description'
          );
        }

        lesson.description = description;
      }

      if (order !== undefined) {
        if (
          !Number.isInteger(order) ||
          order < 0 ||
          order >= course.lessons.length
        ) {
          return fail(
            res,
            400,
            'Invalid lesson order'
          );
        }

        const list = course.lessons.filter(
          item =>
            String(item._id) !== String(lesson._id)
        );

        list.splice(order, 0, lesson);

        list.forEach((item, index) => {
          item.order = index;
        });

        course.lessons = list;
      }

      await course.save();

      return res.json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   DELETE LESSON
========================================= */

router.delete(
  '/:id/lessons/:lessonId',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (
        !validId(req.params.id) ||
        !validId(req.params.lessonId)
      ) {
        return fail(res, 400, 'Invalid ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      const lesson = course.lessons.id(
        req.params.lessonId
      );

      if (!lesson) {
        return fail(res, 404, 'Lesson not found');
      }

      // This removes the lesson reference.
      // It does not automatically delete the S3 object.
      course.lessons.pull({
        _id: lesson._id
      });

      course.lessons.forEach((item, index) => {
        item.order = index;
      });

      await course.save();

      return res.json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   PUBLISH COURSE
========================================= */

router.post(
  '/:id/publish',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return fail(res, 400, 'Invalid course ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      if (
        course.title.trim().length < 3 ||
        !course.lessons.length
      ) {
        return fail(
          res,
          400,
          'Add a course title and at least one lesson before publishing'
        );
      }

      const notReady = course.lessons.filter(
        lesson =>
          lesson.videoStatus !== 'ready' ||
          !lesson.videoUrl
      );

      if (notReady.length) {
        return fail(
          res,
          400,
          `${notReady.length} lesson video(s) are not ready yet`
        );
      }

      course.published = true;

      await course.save();

      return res.json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   UNPUBLISH COURSE
========================================= */

router.post(
  '/:id/unpublish',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return fail(res, 400, 'Invalid course ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      course.published = false;

      await course.save();

      return res.json({ course });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   CREATE VIDEO UPLOAD INTENT
========================================= */

router.post(
  '/:id/lessons/:lessonId/upload-intent',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!process.env.S3_BUCKET) {
        return fail(
          res,
          503,
          'Video storage is not configured'
        );
      }

      if (
        !validId(req.params.id) ||
        !validId(req.params.lessonId)
      ) {
        return fail(res, 400, 'Invalid ID');
      }

      const course = await Course.findById(
        req.params.id
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      if (!ownerOrAdmin(course, req.user)) {
        return fail(
          res,
          403,
          'You do not manage this course'
        );
      }

      const lesson = course.lessons.id(
        req.params.lessonId
      );

      if (!lesson) {
        return fail(res, 404, 'Lesson not found');
      }

      const {
        filename,
        contentType,
        size
      } = req.body || {};

      if (
        typeof filename !== 'string' ||
        filename.length > 255 ||
        !ALLOWED_VIDEO_TYPES.has(contentType) ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > MAX_VIDEO_SIZE
      ) {
        return fail(
          res,
          400,
          'Choose MP4, MOV, or WebM video up to 2 GB'
        );
      }

      const assetId = new mongoose.Types.ObjectId();

      const key =
        `sources/${req.user.id}/${course.id}/` +
        `${assetId}/${crypto.randomUUID()}`;

      const asset = await VideoAsset.create({
        _id: assetId,
        course: course._id,
        lesson: lesson._id,
        owner: req.user.id,
        key,
        originalName: filename
          .replace(/[\\/\0]/g, '_')
          .slice(0, 255),
        contentType,
        expectedBytes: size,
        status: 'awaiting-upload'
      });

      lesson.videoAssetId = asset._id;
      lesson.videoStatus = 'uploading';
      lesson.videoUrl = undefined;

      await course.save();

      try {
        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: contentType,
            ContentLength: size
          }),
          {
            expiresIn: 600
          }
        );

        return res.status(201).json({
          assetId: asset.id,
          uploadUrl,
          headers: {
            'Content-Type': contentType
          },
          expiresIn: 600,
          maxBytes: MAX_VIDEO_SIZE
        });
      } catch (error) {
        await VideoAsset.findByIdAndDelete(
          asset._id
        );

        lesson.videoStatus = 'missing';
        lesson.videoAssetId = undefined;

        await course.save();

        throw error;
      }
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   VERIFY UPLOAD AND QUEUE PROCESSING
========================================= */

router.post(
  '/assets/:assetId/upload-complete',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.assetId)) {
        return fail(res, 400, 'Invalid asset ID');
      }

      const asset = await VideoAsset.findById(
        req.params.assetId
      );

      if (!asset) {
        return fail(
          res,
          404,
          'Upload record not found'
        );
      }

      if (
        req.user.role !== 'admin' &&
        String(asset.owner) !== req.user.id
      ) {
        return fail(res, 403, 'Not your upload');
      }

      if (asset.status !== 'awaiting-upload') {
        return fail(
          res,
          409,
          'This upload has already been submitted'
        );
      }

      /* -------------------------------
         VERIFY OBJECT IN S3
      -------------------------------- */

      let head;

      try {
        head = await s3.send(
          new HeadObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: asset.key
          })
        );
      } catch (storageError) {
        console.error(
          'S3 upload verification failed',
          {
            name: storageError?.name,
            code:
              storageError?.Code ||
              storageError?.code,
            status:
              storageError?.$metadata
                ?.httpStatusCode,
            requestId:
              storageError?.$metadata
                ?.requestId,
            key: asset.key
          }
        );

        const status =
          storageError?.$metadata
            ?.httpStatusCode;

        if (
          status === 403 ||
          storageError?.name === 'AccessDenied'
        ) {
          return res.status(503).json({
            error:
              'S3 could not verify the uploaded video. Check the backend AWS identity and grant s3:GetObject for the sources/* object prefix.',
            code: 'S3_VERIFY_ACCESS_DENIED'
          });
        }

        if (
          status === 404 ||
          storageError?.name === 'NotFound'
        ) {
          return res.status(409).json({
            error:
              'Video object was not found in S3. Retry the upload with a fresh upload link.',
            code: 'S3_OBJECT_NOT_FOUND'
          });
        }

        return res.status(502).json({
          error:
            'S3 video verification failed. Check server logs and AWS configuration.',
          code: 'S3_VERIFY_FAILED'
        });
      }

      /* -------------------------------
         VALIDATE UPLOADED OBJECT
      -------------------------------- */

      if (
        head.ContentLength !== asset.expectedBytes ||
        head.ContentType !== asset.contentType
      ) {
        return fail(
          res,
          400,
          'Uploaded file size/type does not match upload request'
        );
      }

      /* -------------------------------
         VERIFY COURSE AND LESSON
      -------------------------------- */

      const course = await Course.findById(
        asset.course
      );

      if (!course) {
        return fail(res, 404, 'Course not found');
      }

      const lesson = course.lessons.id(
        asset.lesson
      );

      if (
        !lesson ||
        String(lesson.videoAssetId) !== asset.id
      ) {
        return fail(
          res,
          409,
          'This video no longer belongs to the lesson'
        );
      }

      /* -------------------------------
         QUEUE VIDEO PROCESSING
      -------------------------------- */

      const { videoQueue } = req.app.locals;

      if (!videoQueue) {
        return fail(
          res,
          503,
          'Video processing queue is unavailable'
        );
      }

      const job = await videoQueue.add(
        'transcode',
        {
          key: asset.key,
          userId: String(asset.owner),
          assetId: asset.id,
          courseId: String(asset.course),
          lessonId: String(asset.lesson)
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000
          },
          removeOnComplete: 100,
          removeOnFail: 200
        }
      );

      asset.status = 'queued';
      asset.jobId = String(job.id);

      await asset.save();

      lesson.videoStatus = 'processing';

      await course.save();

      return res.status(202).json({
        assetId: asset.id,
        jobId: job.id,
        status: 'queued'
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================
   GET VIDEO ASSET STATUS
========================================= */

router.get(
  '/assets/:assetId',
  roles('instructor', 'admin'),
  async (req, res, next) => {
    try {
      if (!validId(req.params.assetId)) {
        return fail(res, 400, 'Invalid asset ID');
      }

      const asset = await VideoAsset.findById(
        req.params.assetId
      );

      if (!asset) {
        return fail(res, 404, 'Asset not found');
      }

      if (
        req.user.role !== 'admin' &&
        String(asset.owner) !== req.user.id
      ) {
        return fail(res, 403, 'Not your asset');
      }

      return res.json({
        asset: {
          id: asset.id,
          status: asset.status,
          error: asset.error || null,
          jobId: asset.jobId
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
