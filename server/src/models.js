import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// ==========================================
// USER MODEL - PHASE 1 AUTHENTICATION
// ==========================================

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    },

    passwordHash: {
      type: String,
      required: true,
      select: false
    },

    role: {
      type: String,
      enum: ['student', 'instructor', 'admin'],
      default: 'student',
      required: true
    },

    status: {
      type: String,
      enum: ['active', 'disabled'],
      default: 'active',
      required: true
    },

    tokenVersion: {
      type: Number,
      default: 0,
      select: false,
      min: 0
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// userSchema.index({ email: 1 }, { unique: true });

export const User = model('User', userSchema);


// ==========================================
// LESSON SCHEMA
// ==========================================

const lessonSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 180
    },

    description: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: ''
    },

    // Legacy / externally hosted video URL.
    // Do not use this field to expose private S3 object keys.
    videoUrl: {
      type: String,
      maxlength: 2048,
      default: undefined
    },

    // References the managed video asset.
    videoAssetId: {
      type: Schema.Types.ObjectId,
      ref: 'VideoAsset',
      default: undefined
    },

    videoStatus: {
      type: String,
      enum: [
        'missing',
        'uploading',
        'processing',
        'ready',
        'failed'
      ],
      default: 'missing'
    },

    durationSec: {
      type: Number,
      min: 0,
      default: undefined,
      validate: {
        validator: Number.isFinite,
        message: 'Duration must be a finite number'
      }
    },

    order: {
      type: Number,
      min: 0,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Lesson order must be an integer'
      }
    }
  },
  {
    timestamps: true
  }
);


// ==========================================
// COURSE MODEL
// ==========================================

const courseSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 180
    },

    description: {
      type: String,
      maxlength: 10000,
      default: ''
    },

    category: {
      type: String,
      trim: true,
      maxlength: 100,
      default: ''
    },

    pricePaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Course price must be a safe integer in paise'
      }
    },

    instructor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    published: {
      type: Boolean,
      default: false,
      index: true
    },

    lessons: {
      type: [lessonSchema],
      default: []
    },

    quizzes: [
      {
        title: {
          type: String,
          trim: true,
          maxlength: 180
        },

        questions: [
          {
            prompt: {
              type: String,
              trim: true,
              maxlength: 4000
            },

            options: {
              type: [String],
              default: []
            },

            correctIndex: {
              type: Number,
              min: 0
            },

            points: {
              type: Number,
              default: 1,
              min: 1,
              validate: {
                validator: Number.isSafeInteger,
                message: 'Points must be an integer'
              }
            }
          }
        ]
      }
    ]
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Useful for public course catalog queries.
courseSchema.index({ published: 1, createdAt: -1 });

// Useful for instructor course listing.
courseSchema.index({ instructor: 1, updatedAt: -1 });

export const Course = model('Course', courseSchema);


// ==========================================
// VIDEO ASSET MODEL - PHASE 2
// ==========================================

const videoAssetSchema = new Schema(
  {
    course: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true
    },

    lesson: {
      type: Schema.Types.ObjectId,
      required: true
    },

    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    // Private source object key.
    // Never return this as a public playback URL.
    key: {
      type: String,
      required: true,
      unique: true
    },

    originalName: {
      type: String,
      required: true,
      maxlength: 255
    },

    contentType: {
      type: String,
      required: true,
      enum: [
        'video/mp4',
        'video/quicktime',
        'video/webm'
      ]
    },

    expectedBytes: {
      type: Number,
      required: true,
      min: 1,
      max: 2147483648,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Expected file size must be a safe integer'
      }
    },

    status: {
      type: String,
      enum: [
        'awaiting-upload',
        'queued',
        'processing',
        'ready',
        'failed'
      ],
      default: 'awaiting-upload',
      index: true
    },

    // Background processing job identifier.
    jobId: {
      type: String,
      default: undefined
    },

    // HLS playback URL after successful processing.
    playbackUrl: {
      type: String,
      maxlength: 2048,
      default: undefined
    },

    // Optional output object prefix.
    outputKey: {
      type: String,
      default: undefined
    },

    error: {
      type: String,
      maxlength: 1000,
      default: undefined
    },

    // Actual source object size verified by server.
    actualBytes: {
      type: Number,
      min: 1,
      default: undefined
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Worker/admin monitoring queries.
videoAssetSchema.index({ status: 1, updatedAt: -1 });

// Course-level asset lookup.
videoAssetSchema.index({ course: 1, lesson: 1, createdAt: -1 });

export const VideoAsset = model('VideoAsset', videoAssetSchema);


// ==========================================
// ENROLLMENT MODEL
// ==========================================

const enrollmentSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    course: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true
    },

    completedLessons: {
      type: [Number],
      default: []
    },

    quizScores: [
      {
        quizIndex: Number,
        score: Number,
        maxScore: Number
      }
    ],

    completedAt: {
      type: Date,
      default: undefined
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Prevent duplicate enrollment.
enrollmentSchema.index(
  { student: 1, course: 1 },
  { unique: true }
);

export const Enrollment = model('Enrollment', enrollmentSchema);


// ==========================================
// PAYMENT MODEL
// ==========================================

const paymentSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    course: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true
    },

    providerOrderId: {
      type: String,
      required: true,
      unique: true
    },

    paymentId: {
      type: String,
      default: undefined
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Payment amount must be an integer'
      }
    },

    status: {
      type: String,
      enum: ['created', 'paid', 'failed', 'refunded'],
      default: 'created'
    },

    // ---- Razorpay checkout / earnings / refunds (added) ----
    // Course owner at purchase time. Older payments may not have it (earnings fall back to course.instructor).
    instructor: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    currency: { type: String, default: 'INR' },
    method: { type: String, default: undefined },
    paidAt: { type: Date, default: undefined },
    failureReason: { type: String, maxlength: 500, default: undefined },

    // Revenue split snapshot, frozen when the order is created so later fee changes never rewrite history.
    platformFeePercent: { type: Number, min: 0, max: 100, default: undefined },
    platformFeePaise: { type: Number, min: 0, default: undefined },
    instructorSharePaise: { type: Number, min: 0, default: undefined },

    // Refund ledger. Totals are denormalised from `refunds` (failed refunds excluded) so reports stay cheap.
    refunds: [
      {
        refundId: { type: String, required: true },
        amountPaise: { type: Number, required: true, min: 0 },
        status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
        reason: { type: String, maxlength: 500, default: '' },
        source: { type: String, enum: ['app', 'razorpay'], default: 'app' },
        requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: undefined },
        createdAt: { type: Date, default: Date.now },
        processedAt: { type: Date, default: undefined }
      }
    ],
    refundedPaise: { type: Number, default: 0, min: 0 },
    instructorShareReversedPaise: { type: Number, default: 0, min: 0 },

    // Short-lived mutex so two concurrent refund requests cannot both hit Razorpay.
    refundLockedAt: { type: Date, default: undefined }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

paymentSchema.index({ paymentId: 1 }, { sparse: true });
paymentSchema.index({ instructor: 1, status: 1, createdAt: -1 });
paymentSchema.index({ student: 1, createdAt: -1 });

export const Payment = model('Payment', paymentSchema);

// ==========================================
// RAZORPAY WEBHOOK EVENTS (idempotency log; auto-expires after 30 days)
// ==========================================
const webhookEventSchema = new Schema(
  {
    _id: { type: String, required: true },
    event: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
  },
  { versionKey: false }
);
export const WebhookEvent = model('WebhookEvent', webhookEventSchema, 'learnlive_webhook_events');


// ==========================================
// BOOTSTRAP MARKER - PHASE 1
// ==========================================

const bootstrapMarkerSchema = new Schema(
  {
    _id: {
      type: String,
      required: true
    },

    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

export const BootstrapMarker = model(
  'BootstrapMarker',
  bootstrapMarkerSchema,
  'auth_bootstrap_markers'
);

// ==========================================
// LIVE CLASSES + ATTENDANCE
// ==========================================
const liveClassSchema = new Schema(
  {
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    instructor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 180 },
    description: { type: String, default: '', maxlength: 4000 },
    startsAt: { type: Date, required: true, index: true },
    durationMin: { type: Number, required: true, min: 5, max: 480, default: 60 },
    status: { type: String, enum: ['scheduled', 'live', 'ended', 'cancelled'], default: 'scheduled', index: true },
    roomName: { type: String, required: true, unique: true },
    startedAt: Date,
    endedAt: Date
  },
  { timestamps: true, versionKey: false }
);
export const LiveClass = model('LiveClass', liveClassSchema, 'learnlive_classes');

const liveAttendanceSchema = new Schema(
  {
    liveClass: { type: Schema.Types.ObjectId, ref: 'LiveClass', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['student', 'instructor', 'admin'], required: true },
    firstJoinedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    totalSeconds: { type: Number, default: 0 },
    // Each connection is a session; lastSeenAt is refreshed by heartbeats so a crashed tab still counts.
    sessions: [{ joinedAt: Date, leftAt: Date, lastSeenAt: Date }]
  },
  { timestamps: true, versionKey: false }
);
liveAttendanceSchema.index({ liveClass: 1, user: 1 }, { unique: true });
// Dedicated collection name: an older `liveattendances` collection may carry a stale unique index (session+student).
export const LiveAttendance = model('LiveAttendance', liveAttendanceSchema, 'learnlive_class_attendance');

// ==========================================
// CERTIFICATES (issued once per completed enrollment; publicly verifiable by certificateId)
// ==========================================
const certificateSchema = new Schema(
  {
    certificateId: { type: String, required: true, unique: true },
    enrollment: { type: Schema.Types.ObjectId, ref: 'Enrollment', required: true, unique: true },
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    // Snapshot so the certificate stays correct if names/titles are edited later.
    studentName: { type: String, required: true },
    courseTitle: { type: String, required: true },
    instructorName: { type: String, default: '' },
    lessonsTotal: { type: Number, required: true },
    quizAverage: { type: Number, default: null },
    issuedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: undefined }
  },
  { timestamps: true, versionKey: false }
);
export const Certificate = model('Certificate', certificateSchema, 'learnlive_certificates');
