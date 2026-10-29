
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';

import { User, BootstrapMarker } from './models.js';
import { auth, roles } from './middleware.js';

const router = Router();

const limit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts. Try again later.'
  }
});

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  status: user.status,
  createdAt: user.createdAt
});

const tokenFor = (user) =>
  jwt.sign(
    {
      sub: user.id,
      ver: user.tokenVersion || 0
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '8h',
      issuer: 'learnlive-api',
      audience: 'learnlive-client'
    }
  );

const validEmail = (email) =>
  typeof email === 'string' &&
  email.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const validPassword = (password) =>
  typeof password === 'string' &&
  password.length >= 12 &&
  password.length <= 128 &&
  /[a-z]/.test(password) &&
  /[A-Z]/.test(password) &&
  /\d/.test(password);

// Helper for consistent unexpected error responses
const handleError = (res, message) =>
  res.status(500).json({ error: message });

/* =====================================================
   REGISTER
   Public registration always creates a student account
===================================================== */
router.post('/register', limit, async (req, res) => {
  try {
    const name =
      typeof req.body.name === 'string'
        ? req.body.name.trim()
        : '';

    const email =
      typeof req.body.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';

    const password = req.body.password;

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: 'Name must contain 2–80 characters'
      });
    }

    if (!validEmail(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address'
      });
    }

    if (!validPassword(password)) {
      return res.status(400).json({
        error:
          'Password must be 12–128 characters and include uppercase, lowercase, and a number'
      });
    }

    const userExists = await User.exists({ email });

    if (userExists) {
      return res.status(409).json({
        error: 'Email already registered'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      name,
      email,
      passwordHash,
      role: 'student',
      status: 'active'
    });

    return res.status(201).json({
      token: tokenFor(user),
      user: publicUser(user)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Email already registered'
      });
    }

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Registration data failed validation'
      });
    }

    console.error('Registration error:', error);
    return handleError(res, 'Could not register account');
  }
});

/* =====================================================
   LOGIN
===================================================== */
router.post('/login', limit, async (req, res) => {
  try {
    const email =
      typeof req.body.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';

    const password =
      typeof req.body.password === 'string'
        ? req.body.password
        : '';

    const user = await User.findOne({ email })
      .select('+passwordHash +tokenVersion');

    if (
      !user ||
      user.status !== 'active' ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    return res.json({
      token: tokenFor(user),
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Login error:', error);
    return handleError(res, 'Could not sign in');
  }
});

/* =====================================================
   CURRENT LOGGED-IN USER
===================================================== */
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(401).json({
        error: 'Session unavailable'
      });
    }

    return res.json({
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Get current user error:', error);
    return handleError(res, 'Could not fetch current user');
  }
});

/* =====================================================
   LOGOUT
===================================================== */
router.post('/logout', auth, async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user.id },
      { $inc: { tokenVersion: 1 } }
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error('Logout error:', error);
    return handleError(res, 'Could not log out');
  }
});

/* =====================================================
   INITIAL ADMIN BOOTSTRAP
===================================================== */
router.post('/bootstrap-admin', limit, async (req, res) => {
  let claimedMarker = false;

  try {
    const key = process.env.BOOTSTRAP_ADMIN_KEY;

    if (!key) {
      return res.status(404).json({
        error: 'Admin bootstrap is not enabled'
      });
    }

    const given =
      typeof req.body.bootstrapKey === 'string'
        ? req.body.bootstrapKey
        : '';

    const expectedBuffer = Buffer.from(key);
    const givenBuffer = Buffer.from(given);

    if (
      expectedBuffer.length !== givenBuffer.length ||
      !timingSafeEqual(expectedBuffer, givenBuffer)
    ) {
      return res.status(403).json({
        error: 'Forbidden'
      });
    }

    const name =
      typeof req.body.name === 'string'
        ? req.body.name.trim()
        : '';

    const email =
      typeof req.body.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';

    const password = req.body.password;

    if (
      name.length < 2 ||
      name.length > 80 ||
      !validEmail(email) ||
      !validPassword(password)
    ) {
      return res.status(400).json({
        error: 'Provide valid name, email and strong password'
      });
    }

    if (await User.exists({ role: 'admin' })) {
      return res.status(409).json({
        error: 'An administrator already exists'
      });
    }

    // Claim the one-time bootstrap slot.
    try {
      await BootstrapMarker.create({
        _id: 'initial-admin'
      });
      claimedMarker = true;
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          error: 'Admin bootstrap has already been claimed'
        });
      }
      throw error;
    }

    // Check again after claiming.
    if (await User.exists({ role: 'admin' })) {
      await BootstrapMarker.deleteOne({
        _id: 'initial-admin'
      });
      claimedMarker = false;

      return res.status(409).json({
        error: 'An administrator already exists'
      });
    }

    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'admin',
      status: 'active'
    });

    return res.status(201).json({
      token: tokenFor(user),
      user: publicUser(user)
    });
  } catch (error) {
    if (claimedMarker) {
      await BootstrapMarker.deleteOne({
        _id: 'initial-admin'
      }).catch(() => {});
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Email already registered'
      });
    }

    console.error('Admin bootstrap error:', error);
    return handleError(res, 'Bootstrap failed');
  }
});

/* =====================================================
   GET ALL USERS (ADMIN ONLY)

   GET /api/auth/admin/users
===================================================== */
router.get(
  '/admin/users',
  auth,
  roles('admin'),
  async (req, res) => {
    try {
      const page = Math.max(
        1,
        Math.min(10000, Number(req.query.page) || 1)
      );

      const limitN = Math.max(
        1,
        Math.min(100, Number(req.query.limit) || 25)
      );

      const filter = {};

      if (
        ['student', 'instructor', 'admin'].includes(
          req.query.role
        )
      ) {
        filter.role = req.query.role;
      }

      if (
        ['active', 'disabled'].includes(
          req.query.status
        )
      ) {
        filter.status = req.query.status;
      }

      const [users, total] = await Promise.all([
        User.find(filter)
          .select('name email role status createdAt')
          .sort({ createdAt: -1 })
          .skip((page - 1) * limitN)
          .limit(limitN)
          .lean(),

        User.countDocuments(filter)
      ]);

      return res.json({
        users: users.map((user) => ({
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt
        })),
        page,
        limit: limitN,
        total,
        totalPages: Math.ceil(total / limitN)
      });
    } catch (error) {
      console.error('Fetch users error:', error);
      return handleError(res, 'Could not fetch users');
    }
  }
);

/* =====================================================
   GET SINGLE USER (ADMIN ONLY)

   GET /api/auth/admin/users/:id
===================================================== */
router.get(
  '/admin/users/:id',
  auth,
  roles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          error: 'Invalid user ID'
        });
      }

      const user = await User.findById(id)
        .select('name email role status createdAt')
        .lean();

      if (!user) {
        return res.status(404).json({
          error: 'User not found'
        });
      }

      return res.status(200).json({
        user: {
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt
        }
      });
    } catch (error) {
      console.error('Fetch single user error:', error);
      return handleError(res, 'Could not fetch user');
    }
  }
);

/* =====================================================
   UPDATE USER ROLE / STATUS (ADMIN ONLY)

   PATCH /api/auth/admin/users/:id
===================================================== */
router.patch(
  '/admin/users/:id',
  auth,
  roles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role, status } = req.body;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          error: 'Invalid user ID'
        });
      }

      if (
        role !== undefined &&
        !['student', 'instructor', 'admin'].includes(role)
      ) {
        return res.status(400).json({
          error: 'Invalid role'
        });
      }

      if (
        status !== undefined &&
        !['active', 'disabled'].includes(status)
      ) {
        return res.status(400).json({
          error: 'Invalid account status'
        });
      }

      if (role === undefined && status === undefined) {
        return res.status(400).json({
          error: 'No changes supplied'
        });
      }

      const user = await User.findById(id)
        .select('+tokenVersion');

      if (!user) {
        return res.status(404).json({
          error: 'User not found'
        });
      }

      const isSelf = user.id === req.user.id;

      if (
        isSelf &&
        (
          status === 'disabled' ||
          (role !== undefined && role !== 'admin')
        )
      ) {
        return res.status(400).json({
          error: 'You cannot disable or demote your own admin account'
        });
      }

      if (role !== undefined) {
        user.role = role;
      }

      if (status !== undefined) {
        user.status = status;
      }

      // Revoke all existing sessions after account changes.
      user.tokenVersion = (user.tokenVersion || 0) + 1;

      await user.save();

      return res.json({
        message: 'User updated successfully',
        user: publicUser(user)
      });
    } catch (error) {
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          error: 'Invalid user data'
        });
      }

      console.error('Update user error:', error);
      return handleError(res, 'Could not update account');
    }
  }
);

export default router;
