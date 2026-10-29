
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import PDFDocument from 'pdfkit';
import { AccessToken } from 'livekit-server-sdk';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { Course, Enrollment, Payment } from './models.js';
import { auth, roles } from './middleware.js';
import authRoutes from './authRoutes.js';
import courseRoutes from './courseRoutes.js';

const app = express();

// --------------------------------------------------
// 1. APP CONFIGURATION
// --------------------------------------------------

app.use(helmet());

app.use(
  cors({
    origin:
      process.env.CLIENT_ORIGIN?.split(',') ||
      'http://localhost:5173',
  })
);

app.use(express.json({ limit: '1mb' }));

app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 120,
  })
);

// --------------------------------------------------
// 2. ENVIRONMENT VALIDATION
// --------------------------------------------------

if (
  !process.env.MONGODB_URI ||
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32
) {
  throw new Error(
    'MONGODB_URI and a JWT_SECRET of at least 32 characters are required'
  );
}

// --------------------------------------------------
// 3. DATABASE CONNECTION
// --------------------------------------------------

await mongoose.connect(process.env.MONGODB_URI);

console.log('MongoDB connected successfully');

// --------------------------------------------------
// 4. REDIS AND VIDEO PROCESSING QUEUE
// --------------------------------------------------

const redis = new IORedis(
  process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  {
    maxRetriesPerRequest: null,
  }
);

const videoQueue = new Queue('video-processing', {
  connection: redis,
});

// Shared queue for course/video routes.
app.locals.videoQueue = videoQueue;

// --------------------------------------------------
// 5. HEALTH CHECK
// --------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'LearnLive API',
  });
});

// --------------------------------------------------
// 6. AUTHENTICATION ROUTES
// --------------------------------------------------

app.use('/api/auth', authRoutes);

// --------------------------------------------------
// 7. PHASE 2: INSTRUCTOR COURSE MANAGEMENT
// --------------------------------------------------

// Instructor Studio APIs:
// Create courses
// Edit courses
// Manage lessons
// Upload videos
// Request video processing
// Publish/unpublish courses

app.use('/api/instructor/courses', courseRoutes);

// --------------------------------------------------
// 8. PUBLIC COURSE CATALOG
// --------------------------------------------------

app.get('/api/courses', async (req, res) => {
  const courses = await Course.find({
    published: true,
  })
    .populate('instructor', 'name')
    .select('-quizzes.questions.correctIndex');

  res.json(courses);
});

// --------------------------------------------------
// 9. GET COURSE DETAILS
// --------------------------------------------------

app.get('/api/courses/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      error: 'Invalid course ID',
    });
  }

  const course = await Course.findOne({
    _id: req.params.id,
    published: true,
  })
    .populate('instructor', 'name')
    .select('-quizzes.questions.correctIndex');

  if (!course) {
    return res.status(404).json({
      error: 'Course not found',
    });
  }

  res.json(course);
});

// --------------------------------------------------
// 10. STUDENT ENROLLMENT
// --------------------------------------------------

app.post(
  '/api/courses/:id/enroll',
  auth,
  roles('student'),
  async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid course ID',
      });
    }

    const course = await Course.findOne({
      _id: req.params.id,
      published: true,
    });

    if (!course) {
      return res.sendStatus(404);
    }

    if (
      course.pricePaise > 0 &&
      !(await Payment.findOne({
        student: req.user.id,
        course: course.id,
        status: 'paid',
      }))
    ) {
      return res.status(402).json({
        error: 'Payment required before enrollment',
      });
    }

    const enrollment = await Enrollment.findOneAndUpdate(
      {
        student: req.user.id,
        course: course.id,
      },
      {
        $setOnInsert: {
          completedLessons: [],
          quizScores: [],
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    res.json(enrollment);
  }
);

// --------------------------------------------------
// 11. STUDENT ENROLLMENTS
// --------------------------------------------------

app.get(
  '/api/me/enrollments',
  auth,
  async (req, res) => {
    const enrollments = await Enrollment.find({
      student: req.user.id,
    }).populate(
      'course',
      'title lessons quizzes instructor pricePaise'
    );

    res.json(enrollments);
  }
);

// --------------------------------------------------
// 12. MARK LESSON COMPLETE
// --------------------------------------------------

app.post(
  '/api/enrollments/:id/lessons/:lessonIndex/complete',
  auth,
  async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid enrollment ID',
      });
    }

    const enrollment = await Enrollment.findOne({
      _id: req.params.id,
      student: req.user.id,
    }).populate('course');

    if (!enrollment) {
      return res.sendStatus(404);
    }

    const index = Number(req.params.lessonIndex);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= enrollment.course.lessons.length
    ) {
      return res.status(400).json({
        error: 'Invalid lesson',
      });
    }

    if (!enrollment.completedLessons.includes(index)) {
      enrollment.completedLessons.push(index);
    }

    if (
      enrollment.completedLessons.length ===
        enrollment.course.lessons.length &&
      enrollment.course.lessons.length
    ) {
      enrollment.completedAt = new Date();
    }

    await enrollment.save();

    res.json(enrollment);
  }
);

// --------------------------------------------------
// 13. QUIZ SUBMISSION
// --------------------------------------------------

app.post(
  '/api/enrollments/:id/quizzes/:quizIndex/submit',
  auth,
  async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid enrollment ID',
      });
    }

    const enrollment = await Enrollment.findOne({
      _id: req.params.id,
      student: req.user.id,
    }).populate('course');

    if (!enrollment) {
      return res.sendStatus(404);
    }

    const quizIndex = Number(req.params.quizIndex);
    const quiz = enrollment.course.quizzes[quizIndex];

    if (!quiz) {
      return res.sendStatus(404);
    }

    const answers = req.body.answers || [];

    if (!Array.isArray(answers)) {
      return res.status(400).json({
        error: 'Answers must be an array',
      });
    }

    let score = 0;
    let maxScore = 0;

    quiz.questions.forEach((question, index) => {
      const points = question.points || 1;

      maxScore += points;

      if (
        Number(answers[index]) === question.correctIndex
      ) {
        score += points;
      }
    });

    enrollment.quizScores.push({
      quizIndex,
      score,
      maxScore,
    });

    await enrollment.save();

    res.json({
      score,
      maxScore,
      percent: maxScore
        ? Math.round((score / maxScore) * 100)
        : 0,
    });
  }
);

// --------------------------------------------------
// 14. CERTIFICATE GENERATION
// --------------------------------------------------

app.get(
  '/api/enrollments/:id/certificate',
  auth,
  async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid enrollment ID',
      });
    }

    const enrollment = await Enrollment.findOne({
      _id: req.params.id,
      student: req.user.id,
    }).populate('course student');

    if (!enrollment) {
      return res.sendStatus(404);
    }

    if (!enrollment.completedAt) {
      return res.status(400).json({
        error: 'Complete every lesson to claim your certificate',
      });
    }

    res.setHeader(
      'Content-Type',
      'application/pdf'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename=certificate.pdf'
    );

    const pdf = new PDFDocument({
      layout: 'landscape',
    });

    pdf.pipe(res);

    pdf
      .fontSize(32)
      .text('Certificate of Completion', {
        align: 'center',
      });

    pdf.moveDown();

    pdf
      .fontSize(18)
      .text('This certifies that', {
        align: 'center',
      });

    pdf.moveDown();

    pdf
      .fontSize(28)
      .text(enrollment.student.name, {
        align: 'center',
      });

    pdf.moveDown();

    pdf
      .fontSize(18)
      .text(
        `has completed ${enrollment.course.title}`,
        {
          align: 'center',
        }
      );

    pdf.moveDown();

    pdf
      .fontSize(12)
      .text(
        `Issued ${new Date(
          enrollment.completedAt
        ).toLocaleDateString()} • LearnLive`,
        {
          align: 'center',
        }
      );

    pdf.end();
  }
);

// --------------------------------------------------
// 15. INSTRUCTOR ANALYTICS
// --------------------------------------------------

app.get(
  '/api/instructor/analytics',
  auth,
  roles('instructor', 'admin'),
  async (req, res) => {
    const own =
      req.user.role === 'admin'
        ? {}
        : { instructor: req.user.id };

    const courses = await Course.find(own)
      .select('_id title pricePaise');

    const ids = courses.map((course) => course._id);

    const paid = await Payment.aggregate([
      {
        $match: {
          course: { $in: ids },
          status: 'paid',
        },
      },
      {
        $group: {
          _id: '$course',
          gross: { $sum: '$amount' },
          sales: { $sum: 1 },
        },
      },
    ]);

    const enrollments = await Enrollment.countDocuments({
      course: { $in: ids },
    });

    res.json({
      courses: courses.length,
      enrollments,
      revenuePaise: paid.reduce(
        (sum, payment) => sum + payment.gross,
        0
      ),
      sales: paid.reduce(
        (sum, payment) => sum + payment.sales,
        0
      ),
      byCourse: paid,
    });
  }
);

// --------------------------------------------------
// 16. RAZORPAY ORDER CREATION
// --------------------------------------------------

app.post(
  '/api/payments/order',
  auth,
  roles('student'),
  async (req, res) => {
    if (
      !process.env.RAZORPAY_KEY_ID ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      return res.status(503).json({
        error: 'Configure Razorpay test credentials',
      });
    }

    const course = await Course.findOne({
      _id: req.body.courseId,
      published: true,
    });

    if (!course) {
      return res.sendStatus(404);
    }

    if (!course.pricePaise) {
      return res.status(400).json({
        error: 'This course is free; enroll directly',
      });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      amount: course.pricePaise,
      currency: 'INR',
      receipt: crypto.randomUUID(),
      notes: {
        courseId: course.id,
        studentId: req.user.id,
      },
    });

    await Payment.create({
      student: req.user.id,
      course: course.id,
      providerOrderId: order.id,
      amount: order.amount,
    });

    res.json({
      order,
      keyId: process.env.RAZORPAY_KEY_ID,
      courseName: course.title,
    });
  }
);

// --------------------------------------------------
// 17. RAZORPAY PAYMENT VERIFICATION
// --------------------------------------------------

app.post(
  '/api/payments/verify',
  auth,
  roles('student'),
  async (req, res) => {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      typeof razorpay_signature !== 'string' ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      return res.status(400).json({
        error: 'Missing payment verification fields',
      });
    }

    const expected = crypto
      .createHmac(
        'sha256',
        process.env.RAZORPAY_KEY_SECRET
      )
      .update(
        `${razorpay_order_id}|${razorpay_payment_id}`
      )
      .digest('hex');

    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(
      razorpay_signature,
      'hex'
    );

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
      )
    ) {
      return res.status(400).json({
        error: 'Payment signature invalid',
      });
    }

    const payment = await Payment.findOne({
      providerOrderId: razorpay_order_id,
      student: req.user.id,
    });

    if (!payment) {
      return res.sendStatus(404);
    }

    payment.status = 'paid';
    payment.paymentId = razorpay_payment_id;

    await payment.save();

    const enrollment = await Enrollment.findOneAndUpdate(
      {
        student: req.user.id,
        course: payment.course,
      },
      {
        $setOnInsert: {
          completedLessons: [],
          quizScores: [],
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    res.json({
      ok: true,
      enrollment,
    });
  }
);

// --------------------------------------------------
// 18. LIVEKIT TOKEN
// --------------------------------------------------

app.post(
  '/api/live/token',
  auth,
  async (req, res) => {
    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET
    ) {
      return res.status(503).json({
        error: 'LiveKit credentials not configured',
      });
    }

    const room = String(req.body.room || '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 80);

    if (!room) {
      return res.status(400).json({
        error: 'Room required',
      });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: req.user.id,
        name: req.user.name,
        ttl: '1h',
      }
    );

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });

    res.json({
      token: await token.toJwt(),
      url: process.env.LIVEKIT_URL,
    });
  }
);

// --------------------------------------------------
// 19. GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    error:
      err.status && err.status < 500
        ? err.message
        : 'Unexpected server error',
  });
});

// --------------------------------------------------
// 20. START SERVER
// --------------------------------------------------

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(
    `LearnLive API listening on port ${port}`
  );
});
