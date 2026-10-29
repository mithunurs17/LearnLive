
import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/* =========================================
   USER MODEL
========================================= */

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
      select: false
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Unique email index
userSchema.index({ email: 1 }, { unique: true });

export const User =
  mongoose.models.User ||
  model('User', userSchema);


/* =========================================
   COURSE MODEL
========================================= */

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
      maxlength: 10000
    },

    category: {
      type: String,
      maxlength: 100
    },

    pricePaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'pricePaise must be a safe integer'
      }
    },

    instructor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    published: {
      type: Boolean,
      default: false
    },

    lessons: [
      {
        title: {
          type: String,
          trim: true,
          maxlength: 180
        },

        description: {
          type: String,
          maxlength: 4000
        },

        videoUrl: {
          type: String,
          maxlength: 2048
        },

        durationSec: {
          type: Number,
          min: 0
        },

        order: {
          type: Number,
          min: 0
        }
      }
    ],

    quizzes: [
      {
        title: String,

        questions: [
          {
            prompt: String,
            options: [String],

            correctIndex: {
              type: Number,
              min: 0
            },

            points: {
              type: Number,
              default: 1,
              min: 1
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

export const Course =
  mongoose.models.Course ||
  model('Course', courseSchema);


/* =========================================
   ENROLLMENT MODEL
========================================= */

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
      type: Date
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// One enrollment per student per course
enrollmentSchema.index(
  { student: 1, course: 1 },
  { unique: true }
);

export const Enrollment =
  mongoose.models.Enrollment ||
  model('Enrollment', enrollmentSchema);


/* =========================================
   PAYMENT MODEL
========================================= */

const paymentSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },

    course: {
      type: Schema.Types.ObjectId,
      ref: 'Course'
    },

    providerOrderId: {
      type: String,
      unique: true,
      sparse: true
    },

    paymentId: {
      type: String
    },

    amount: {
      type: Number,
      min: 0
    },

    status: {
      type: String,
      enum: ['created', 'paid', 'failed'],
      default: 'created'
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

export const Payment =
  mongoose.models.Payment ||
  model('Payment', paymentSchema);


/* =========================================
   AUTH BOOTSTRAP MARKER
   Required by authRoutes.js
========================================= */

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
    collection: 'auth_bootstrap_markers',
    versionKey: false
  }
);

export const BootstrapMarker =
  mongoose.models.BootstrapMarker ||
  model('BootstrapMarker', bootstrapMarkerSchema);
