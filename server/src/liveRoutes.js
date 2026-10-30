import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Course, Enrollment, LiveClass, LiveAttendance } from './models.js';
import { auth, roles } from './middleware.js';

const router = Router();
// Express 4 does not catch rejected promises from async handlers: forward them to the error middleware
// so a database hiccup returns a 500 instead of crashing the server.
for (const m of ['get', 'post', 'patch', 'delete']) {
  const orig = router[m].bind(router);
  router[m] = (path, ...handlers) => orig(path, ...handlers.map(h => (typeof h === 'function' && h.length < 4 ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h)));
}
router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

const fail = (res, status, error) => res.status(status).json({ error });
const validId = id => mongoose.isValidObjectId(id);
const isStaff = user => user.role === 'instructor' || user.role === 'admin';
const canManage = (cls, user) => user.role === 'admin' || String(cls.instructor) === user.id;
const livekitConfigured = () => !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
const httpUrl = () => process.env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const roomService = () => new RoomServiceClient(httpUrl(), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const HEARTBEAT_GRACE_MS = 90 * 1000;       // a session with no heartbeat for this long is considered closed

const view = (c, extra = {}) => ({
  id: c.id,
  course: c.course && c.course._id ? { id: c.course.id, title: c.course.title } : { id: String(c.course) },
  instructor: c.instructor && c.instructor._id ? { id: c.instructor.id, name: c.instructor.name } : { id: String(c.instructor) },
  title: c.title,
  description: c.description,
  startsAt: c.startsAt,
  durationMin: c.durationMin,
  status: c.status,
  startedAt: c.startedAt || null,
  endedAt: c.endedAt || null,
  ...extra
});

function parseSchedule(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length < 3 || body.title.trim().length > 180) return { error: 'Title must be 3–180 characters' };
    out.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 4000) return { error: 'Description must be at most 4,000 characters' };
    out.description = body.description;
  }
  if (!partial || body.startsAt !== undefined) {
    const d = new Date(body.startsAt);
    if (Number.isNaN(d.getTime())) return { error: 'Choose a valid start date and time' };
    out.startsAt = d;
  }
  if (!partial || body.durationMin !== undefined) {
    const n = Number(body.durationMin ?? 60);
    if (!Number.isInteger(n) || n < 5 || n > 480) return { error: 'Duration must be 5–480 minutes' };
    out.durationMin = n;
  }
  return { value: out };
}

// Close any attendance sessions that stopped sending heartbeats and recompute totals.
function settle(att, now = new Date(), force = false) {
  let total = 0;
  for (const s of att.sessions) {
    if (!s.leftAt && (force || now - s.lastSeenAt > HEARTBEAT_GRACE_MS)) s.leftAt = force ? now : s.lastSeenAt;
    const end = s.leftAt || s.lastSeenAt || now;
    total += Math.max(0, Math.round((end - s.joinedAt) / 1000));
  }
  att.totalSeconds = total;
}

// ---- List ---------------------------------------------------------------
// Instructors: their classes. Students: classes of courses they are enrolled in.
router.get('/classes', async (req, res) => {
  const now = new Date();
  const recent = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  if (isStaff(req.user)) {
    const filter = req.user.role === 'admin' ? {} : { instructor: req.user.id };
    const rows = await LiveClass.find({ ...filter, $or: [{ status: { $in: ['scheduled', 'live'] } }, { startsAt: { $gte: recent } }] })
      .sort({ startsAt: 1 }).populate('course', 'title').populate('instructor', 'name').limit(200);
    const counts = await LiveAttendance.aggregate([{ $match: { liveClass: { $in: rows.map(r => r._id) }, role: 'student' } }, { $group: { _id: '$liveClass', n: { $sum: 1 } } }]);
    const byId = new Map(counts.map(c => [String(c._id), c.n]));
    return res.json({ classes: rows.map(r => view(r, { attendeeCount: byId.get(r.id) || 0 })) });
  }
  const enrolled = await Enrollment.find({ student: req.user.id }).select('course');
  const courseIds = enrolled.map(e => e.course);
  const rows = await LiveClass.find({ course: { $in: courseIds }, $or: [{ status: { $in: ['scheduled', 'live'] } }, { startsAt: { $gte: recent }, status: 'ended' }] })
    .sort({ startsAt: 1 }).populate('course', 'title').populate('instructor', 'name').limit(200);
  const mine = await LiveAttendance.find({ user: req.user.id, liveClass: { $in: rows.map(r => r._id) } });
  const att = new Map(mine.map(a => [String(a.liveClass), a]));
  res.json({ classes: rows.map(r => { const a = att.get(r.id); return view(r, { attended: !!a, attendedSeconds: a ? a.totalSeconds : 0 }); }) });
});

// ---- Schedule -----------------------------------------------------------
router.post('/classes', roles('instructor', 'admin'), async (req, res) => {
  const { courseId } = req.body || {};
  if (!validId(courseId)) return fail(res, 400, 'Choose a course');
  const course = await Course.findById(courseId);
  if (!course) return fail(res, 404, 'Course not found');
  if (req.user.role !== 'admin' && String(course.instructor) !== req.user.id) return fail(res, 403, 'You do not manage this course');
  const parsed = parseSchedule(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  if (parsed.value.startsAt.getTime() < Date.now() - 5 * 60 * 1000) return fail(res, 400, 'Start time must be in the future');
  const cls = await LiveClass.create({
    ...parsed.value, course: course._id, instructor: course.instructor,
    roomName: `class-${crypto.randomBytes(12).toString('hex')}`
  });
  await cls.populate([{ path: 'course', select: 'title' }, { path: 'instructor', select: 'name' }]);
  res.status(201).json({ class: view(cls) });
});

async function loadManaged(req, res) {
  if (!validId(req.params.id)) { fail(res, 400, 'Invalid class ID'); return null; }
  const cls = await LiveClass.findById(req.params.id);
  if (!cls) { fail(res, 404, 'Class not found'); return null; }
  if (!canManage(cls, req.user)) { fail(res, 403, 'You do not manage this class'); return null; }
  return cls;
}

router.patch('/classes/:id', roles('instructor', 'admin'), async (req, res) => {
  const cls = await loadManaged(req, res); if (!cls) return;
  if (cls.status !== 'scheduled') return fail(res, 409, 'Only scheduled classes can be edited');
  const parsed = parseSchedule(req.body || {}, { partial: true });
  if (parsed.error) return fail(res, 400, parsed.error);
  Object.assign(cls, parsed.value); await cls.save();
  res.json({ class: view(cls) });
});

router.post('/classes/:id/cancel', roles('instructor', 'admin'), async (req, res) => {
  const cls = await loadManaged(req, res); if (!cls) return;
  if (cls.status !== 'scheduled') return fail(res, 409, 'Only scheduled classes can be cancelled');
  cls.status = 'cancelled'; await cls.save(); res.json({ class: view(cls) });
});

// ---- Go live / end ------------------------------------------------------
router.post('/classes/:id/start', roles('instructor', 'admin'), async (req, res) => {
  if (!livekitConfigured()) return fail(res, 503, 'Live video is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the server.');
  const cls = await loadManaged(req, res); if (!cls) return;
  if (cls.status === 'ended' || cls.status === 'cancelled') return fail(res, 409, `This class is ${cls.status}`);
  if (cls.status === 'scheduled') { cls.status = 'live'; cls.startedAt = new Date(); await cls.save(); }
  res.json({ class: view(cls) });
});

router.post('/classes/:id/end', roles('instructor', 'admin'), async (req, res) => {
  const cls = await loadManaged(req, res); if (!cls) return;
  if (cls.status !== 'live') return fail(res, 409, 'This class is not live');
  cls.status = 'ended'; cls.endedAt = new Date(); await cls.save();
  const now = new Date();
  const rows = await LiveAttendance.find({ liveClass: cls._id });
  for (const a of rows) { settle(a, now, true); await a.save(); }
  if (livekitConfigured()) { try { await roomService().deleteRoom(cls.roomName); } catch (e) { /* room may already be empty */ } }
  res.json({ class: view(cls) });
});

// ---- Join (token) -------------------------------------------------------
router.post('/classes/:id/token', async (req, res) => {
  if (!livekitConfigured()) return fail(res, 503, 'Live video is not configured. Ask the administrator to set the LiveKit credentials.');
  if (!validId(req.params.id)) return fail(res, 400, 'Invalid class ID');
  const cls = await LiveClass.findById(req.params.id);
  if (!cls) return fail(res, 404, 'Class not found');
  const host = isStaff(req.user) && canManage(cls, req.user);
  if (!host) {
    if (req.user.role !== 'student') return fail(res, 403, 'Only the class instructor can join as host');
    if (!await Enrollment.exists({ student: req.user.id, course: cls.course })) return fail(res, 403, 'Enroll in this course to join its live classes');
  }
  if (cls.status === 'cancelled') return fail(res, 409, 'This class was cancelled');
  if (cls.status === 'ended') return fail(res, 409, 'This class has ended');
  if (cls.status !== 'live') return fail(res, 409, 'The instructor has not started this class yet. Please wait.');

  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: req.user.id, name: req.user.name, ttl: '4h',
    metadata: JSON.stringify({ role: req.user.role, host })
  });
  at.addGrant({
    roomJoin: true, room: cls.roomName,
    canPublish: true, canSubscribe: true, canPublishData: true,   // data channel carries chat
    roomAdmin: host, roomRecord: false
  });
  const now = new Date();
  let att = await LiveAttendance.findOne({ liveClass: cls._id, user: req.user.id });
  if (!att) att = new LiveAttendance({ liveClass: cls._id, user: req.user.id, role: req.user.role, firstJoinedAt: now, lastSeenAt: now, sessions: [] });
  settle(att, now);
  att.sessions.push({ joinedAt: now, lastSeenAt: now });
  att.lastSeenAt = now;
  await att.save();
  const session = att.sessions.at(-1);
  res.json({ token: await at.toJwt(), url: process.env.LIVEKIT_URL, host, sessionId: String(session._id), class: view(cls) });
});

// Heartbeat (every ~30s) and leave keep attendance accurate.
router.post('/classes/:id/heartbeat', async (req, res) => {
  const { sessionId, leaving } = req.body || {};
  if (!validId(req.params.id) || !validId(sessionId)) return fail(res, 400, 'Invalid request');
  const att = await LiveAttendance.findOne({ liveClass: req.params.id, user: req.user.id });
  const s = att?.sessions.id(sessionId);
  if (!s) return fail(res, 404, 'Session not found');
  const now = new Date();
  if (!s.leftAt) { s.lastSeenAt = now; if (leaving) s.leftAt = now; }
  att.lastSeenAt = now; settle(att, now); await att.save();
  const cls = await LiveClass.findById(req.params.id).select('status');
  res.json({ ok: true, status: cls?.status || 'ended' });
});

// ---- Attendance report --------------------------------------------------
router.get('/classes/:id/attendance', roles('instructor', 'admin'), async (req, res) => {
  const cls = await loadManaged(req, res); if (!cls) return;
  const rows = await LiveAttendance.find({ liveClass: cls._id }).populate('user', 'name email');
  const enrolled = await Enrollment.find({ course: cls.course }).populate('student', 'name email');
  const now = new Date();
  const present = new Map();
  for (const a of rows) { settle(a, now, cls.status !== 'live'); present.set(String(a.user?._id), a); }
  const list = enrolled.filter(e => e.student).map(e => {
    const a = present.get(String(e.student._id));
    return {
      userId: e.student.id, name: e.student.name, email: e.student.email, present: !!a,
      firstJoinedAt: a?.firstJoinedAt || null, totalSeconds: a?.totalSeconds || 0, joins: a?.sessions.length || 0,
      online: !!a?.sessions.some(s => !s.leftAt)
    };
  }).sort((x, y) => Number(y.present) - Number(x.present) || x.name.localeCompare(y.name));
  res.json({ class: view(cls), enrolled: list.length, present: list.filter(x => x.present).length, attendance: list });
});

export default router;
