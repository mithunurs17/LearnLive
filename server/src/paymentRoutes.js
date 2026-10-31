import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import { Certificate, Course, Enrollment, Payment, WebhookEvent } from './models.js';
import { auth, roles } from './middleware.js';

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const validId = v => mongoose.isValidObjectId(v);
const oid = v => new mongoose.Types.ObjectId(String(v));

const envNumber = (name, fallback, { min = 0, max = Infinity } = {}) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const feePercent = () => envNumber('PLATFORM_FEE_PERCENT', 20, { min: 0, max: 100 });
const refundWindowDays = () => envNumber('REFUND_WINDOW_DAYS', 7, { min: 0 });
const refundMaxProgress = () => envNumber('REFUND_MAX_PROGRESS_PERCENT', 20, { min: 0, max: 100 });

const splitAmount = (amountPaise, pct = feePercent()) => {
  const platformFeePaise = Math.floor((amountPaise * pct) / 100);
  return { platformFeePercent: pct, platformFeePaise, instructorSharePaise: amountPaise - platformFeePaise };
};
// Payments created before this feature have no stored split: derive it the same way.
const shareOf = p => (Number.isFinite(p.instructorSharePaise) ? p.instructorSharePaise : splitAmount(p.amount).instructorSharePaise);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

let rzClient = null;
function razorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  rzClient ||= new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return rzClient;
}
const rzMessage = e => e?.error?.description || e?.message || 'Razorpay request failed';

/* ------------------------------------------------------------------ *
 *  Fulfilment (shared by /verify and the webhook — idempotent)
 * ------------------------------------------------------------------ */
async function ensureEnrollment(payment) {
  try {
    return await Enrollment.findOneAndUpdate(
      { student: payment.student, course: payment.course },
      { $setOnInsert: { completedLessons: [], quizScores: [] } },
      { upsert: true, new: true }
    );
  } catch (e) {
    if (e?.code === 11000) return Enrollment.findOne({ student: payment.student, course: payment.course });
    throw e;
  }
}

/**
 * Marks the order paid exactly once and makes sure the student is enrolled.
 * Safe to call any number of times, from either the browser callback or the webhook.
 * `amount` (when known from Razorpay) must match what we stored, otherwise we refuse to fulfil.
 */
export async function fulfilPayment({ orderId, paymentId, amount, method }) {
  const filter = { providerOrderId: orderId, status: { $in: ['created', 'failed'] } };
  if (Number.isFinite(amount)) filter.amount = amount;
  const updated = await Payment.findOneAndUpdate(
    filter,
    { $set: { status: 'paid', paymentId, paidAt: new Date(), method }, $unset: { failureReason: 1 } },
    { new: true }
  );
  const payment = updated || (await Payment.findOne({ providerOrderId: orderId }));
  if (!payment) return { payment: null, reason: 'unknown-order' };
  if (!updated && Number.isFinite(amount) && payment.amount !== amount) {
    console.error(`[payments] amount mismatch for ${orderId}: expected ${payment.amount}, got ${amount}`);
    return { payment, reason: 'amount-mismatch' };
  }
  if (payment.status !== 'paid') return { payment, reason: payment.status };
  // The browser callback does not carry the method; the webhook (or the lookup in /verify) fills it in.
  if (method && !payment.method) await Payment.updateOne({ _id: payment._id, method: { $exists: false } }, { $set: { method } });
  const enrollment = await ensureEnrollment(payment);
  return { payment, enrollment, reason: updated ? 'fulfilled' : 'already-fulfilled' };
}

/* ------------------------------------------------------------------ *
 *  Refund ledger
 * ------------------------------------------------------------------ */
async function revokeAccess(payment) {
  await Certificate.updateMany(
    { student: payment.student, course: payment.course, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } }
  );
  await Enrollment.deleteOne({ student: payment.student, course: payment.course });
}

/** Re-derives refund totals + status from the refund list, and revokes access once fully refunded. */
async function settleRefundTotals(paymentObjectId) {
  const p = await Payment.findById(paymentObjectId);
  if (!p) return null;
  const refunded = (p.refunds || []).filter(r => r.status !== 'failed').reduce((s, r) => s + r.amountPaise, 0);
  const share = shareOf(p);
  const reversed = refunded >= p.amount ? share : Math.round((refunded * share) / p.amount);
  const status = p.status === 'paid' || p.status === 'refunded' ? (refunded >= p.amount ? 'refunded' : 'paid') : p.status;
  const wasRefunded = p.status === 'refunded';
  await Payment.updateOne({ _id: p._id }, { $set: { refundedPaise: refunded, instructorShareReversedPaise: reversed, status } });
  if (status === 'refunded' && !wasRefunded) await revokeAccess(p);
  return Payment.findById(p._id);
}

/** Upserts one Razorpay refund entity into the payment's ledger (no duplicates, terminal states stick). */
export async function applyRefund(rzRefund, meta = {}) {
  const base = await Payment.findOne({ paymentId: rzRefund.payment_id }).select('_id');
  if (!base) return null;
  const status = rzRefund.status === 'processed' ? 'processed' : rzRefund.status === 'failed' ? 'failed' : 'pending';
  const set = { 'refunds.$.status': status, 'refunds.$.amountPaise': rzRefund.amount };
  if (status === 'processed') set['refunds.$.processedAt'] = new Date();
  const updated = await Payment.updateOne(
    { _id: base._id, refunds: { $elemMatch: { refundId: rzRefund.id, status: status === 'processed' ? { $ne: 'processed' } : 'pending' } } },
    { $set: set }
  );
  if (!updated.matchedCount) {
    await Payment.updateOne(
      { _id: base._id, 'refunds.refundId': { $ne: rzRefund.id } },
      {
        $push: {
          refunds: {
            refundId: rzRefund.id,
            amountPaise: rzRefund.amount,
            status,
            reason: String(meta.reason || rzRefund.notes?.reason || '').slice(0, 500),
            source: meta.requestedBy ? 'app' : 'razorpay',
            requestedBy: meta.requestedBy ? oid(meta.requestedBy) : undefined,
            createdAt: rzRefund.created_at ? new Date(rzRefund.created_at * 1000) : new Date(),
            processedAt: status === 'processed' ? new Date() : undefined
          }
        }
      }
    );
  }
  return settleRefundTotals(base._id);
}

async function refundEligibility(p, { enrollment, course, hasCertificate }) {
  if (p.status !== 'paid' || !p.paymentId) return { eligible: false, reason: 'This payment cannot be refunded.' };
  if (p.refundedPaise > 0) return { eligible: false, reason: 'This payment has already been refunded.' };
  const days = refundWindowDays();
  const until = new Date((p.paidAt || p.updatedAt).getTime() + days * 86400000);
  if (Date.now() > until.getTime()) return { eligible: false, reason: `The ${days}-day refund window has ended.` };
  if (hasCertificate) return { eligible: false, reason: 'A certificate has already been issued for this course.' };
  const total = course?.lessons?.length || 0;
  const done = enrollment?.completedLessons?.length || 0;
  const progress = total ? Math.round((done / total) * 100) : 0;
  if (progress > refundMaxProgress()) return { eligible: false, reason: `More than ${refundMaxProgress()}% of the course has been completed.` };
  return { eligible: true, until };
}

/* ------------------------------------------------------------------ *
 *  Webhook (mounted in index.js BEFORE express.json so the raw body is intact)
 * ------------------------------------------------------------------ */
async function processWebhookEvent(event) {
  const payload = event.payload || {};
  switch (event.event) {
    case 'payment.captured':
    case 'order.paid': {
      const pay = payload.payment?.entity;
      if (!pay?.order_id || !pay?.id) return;
      await fulfilPayment({ orderId: pay.order_id, paymentId: pay.id, amount: pay.amount, method: pay.method });
      return;
    }
    case 'payment.failed': {
      const pay = payload.payment?.entity;
      if (!pay?.order_id) return;
      // Only an unpaid order can fail; a later retry on the same order can still succeed and will override this.
      await Payment.updateOne(
        { providerOrderId: pay.order_id, status: 'created' },
        { $set: { status: 'failed', failureReason: String(pay.error_description || pay.error_reason || 'Payment failed').slice(0, 500) } }
      );
      return;
    }
    case 'refund.created':
    case 'refund.processed':
    case 'refund.failed': {
      const refund = payload.refund?.entity;
      if (!refund?.id || !refund?.payment_id) return;
      const synced = await applyRefund(refund);
      if (!synced) console.warn(`[webhook] refund ${refund.id} is for an unknown payment ${refund.payment_id}; ignored`);
      return;
    }
    default:
      return; // events we do not subscribe to are acknowledged and ignored
  }
}

export async function webhookHandler(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook secret is not configured' });
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !raw.length) return res.status(400).json({ error: 'Empty webhook body' });
  if (!safeEqual(hmacHex(secret, raw), req.get('x-razorpay-signature'))) return res.status(400).json({ error: 'Invalid webhook signature' });

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // Razorpay retries deliveries; the event id makes processing idempotent.
  const eventId = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');
  try {
    await WebhookEvent.create({ _id: eventId, event: String(event.event || '') });
  } catch (e) {
    if (e?.code === 11000) return res.json({ ok: true, duplicate: true });
    console.error('[webhook] could not record event', e);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  try {
    await processWebhookEvent(event);
    return res.json({ ok: true });
  } catch (e) {
    console.error(`[webhook] ${event.event} failed`, e);
    await WebhookEvent.deleteOne({ _id: eventId }).catch(() => {}); // let Razorpay retry
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

/* ------------------------------------------------------------------ *
 *  /api/payments  — checkout, verification, history, refunds
 * ------------------------------------------------------------------ */
const router = Router();
// Express 4 does not forward rejected promises from async handlers.
function wrapAsync(r) {
  for (const m of ['get', 'post']) {
    const orig = r[m].bind(r);
    r[m] = (p, ...hs) => orig(p, ...hs.map(h => (typeof h === 'function' && h.length < 4 ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h)));
  }
}
wrapAsync(router);

router.post('/order', auth, roles('student'), async (req, res) => {
  const rz = razorpay();
  if (!rz) return fail(res, 503, 'Configure Razorpay test credentials');
  if (!validId(req.body?.courseId)) return fail(res, 400, 'Invalid course');
  const course = await Course.findOne({ _id: req.body.courseId, published: true });
  if (!course) return res.sendStatus(404);
  if (await Enrollment.exists({ student: req.user.id, course: course.id })) return fail(res, 409, 'You are already enrolled in this course.');
  if (!course.pricePaise) return fail(res, 400, 'This course is free; enroll directly');

  let order;
  try {
    order = await rz.orders.create({
      amount: course.pricePaise,
      currency: 'INR',
      receipt: crypto.randomUUID(),
      notes: { courseId: course.id, studentId: req.user.id }
    });
  } catch (e) {
    console.error('[payments] order creation failed', e);
    return fail(res, 502, `Could not start checkout: ${rzMessage(e)}`);
  }
  await Payment.create({
    student: req.user.id,
    course: course.id,
    instructor: course.instructor,
    providerOrderId: order.id,
    amount: order.amount,
    currency: order.currency,
    ...splitAmount(order.amount)
  });
  res.json({ order, keyId: process.env.RAZORPAY_KEY_ID, courseName: course.title, configId: process.env.RAZORPAY_CHECKOUT_CONFIG_ID || undefined });
});

router.post('/verify', auth, roles('student'), async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if ([razorpay_order_id, razorpay_payment_id, razorpay_signature].some(v => typeof v !== 'string' || !v)) return fail(res, 400, 'Missing payment details');
  if (!process.env.RAZORPAY_KEY_SECRET) return fail(res, 503, 'Configure Razorpay test credentials');
  const expected = hmacHex(process.env.RAZORPAY_KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`);
  if (!safeEqual(expected, razorpay_signature)) return fail(res, 400, 'Payment signature invalid');

  const own = await Payment.findOne({ providerOrderId: razorpay_order_id, student: req.user.id }).select('_id status');
  if (!own) return res.sendStatus(404);
  if (own.status === 'refunded') return fail(res, 409, 'This payment has been refunded.');

  let method;
  try { method = (await razorpay()?.payments.fetch(razorpay_payment_id))?.method; } catch { /* the webhook will record it */ }
  const result = await fulfilPayment({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, method });
  if (!result.enrollment) return fail(res, 409, 'Payment could not be confirmed yet. If money was deducted, access is granted automatically.');
  res.json({ ok: true, enrollment: result.enrollment });
});

// The student's own purchase history, including whether a self-service refund is still allowed.
router.get('/mine', auth, roles('student'), async (req, res) => {
  const rows = await Payment.find({ student: req.user.id, status: { $in: ['paid', 'refunded'] } })
    .sort({ createdAt: -1 }).limit(100).populate('course', 'title lessons');
  const courseIds = rows.map(p => p.course?._id).filter(Boolean);
  const [enrollments, certs] = await Promise.all([
    Enrollment.find({ student: req.user.id, course: { $in: courseIds } }).select('course completedLessons'),
    Certificate.find({ student: req.user.id, course: { $in: courseIds }, revokedAt: { $exists: false } }).select('course')
  ]);
  const enrollmentBy = new Map(enrollments.map(e => [String(e.course), e]));
  const certified = new Set(certs.map(c => String(c.course)));
  const payments = [];
  for (const p of rows) {
    const elig = await refundEligibility(p, { enrollment: enrollmentBy.get(String(p.course?._id)), course: p.course, hasCertificate: certified.has(String(p.course?._id)) });
    payments.push({
      id: p.id,
      courseId: p.course?._id || null,
      courseTitle: p.course?.title || 'Removed course',
      amountPaise: p.amount,
      refundedPaise: p.refundedPaise || 0,
      status: p.status,
      paidAt: p.paidAt || p.updatedAt,
      refunds: (p.refunds || []).map(r => ({ amountPaise: r.amountPaise, status: r.status, createdAt: r.createdAt })),
      refundEligible: elig.eligible,
      refundNote: elig.eligible ? `Refundable until ${elig.until.toLocaleDateString('en-IN')}` : elig.reason
    });
  }
  res.set('Cache-Control', 'private, no-store');
  res.json({ payments });
});

/**
 * Refund a payment.
 *  - student: own payment, full amount, only while the refund policy allows it
 *  - admin:   any paid payment, full or partial (`amountPaise`)
 */
router.post('/:id/refund', auth, roles('student', 'admin'), async (req, res) => {
  if (!validId(req.params.id)) return fail(res, 400, 'Invalid payment');
  const rz = razorpay();
  if (!rz) return fail(res, 503, 'Configure Razorpay test credentials');

  const isAdmin = req.user.role === 'admin';
  const p = await Payment.findById(req.params.id).populate('course', 'title lessons');
  if (!p || (!isAdmin && String(p.student) !== req.user.id)) return fail(res, 404, 'Payment not found');
  if (p.status !== 'paid' || !p.paymentId) return fail(res, 409, 'Only a successful, not-yet-fully-refunded payment can be refunded.');

  const remaining = p.amount - (p.refundedPaise || 0);
  let amountPaise = remaining;
  if (isAdmin && req.body?.amountPaise !== undefined) {
    amountPaise = Number(req.body.amountPaise);
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 100 || amountPaise > remaining) return fail(res, 400, `Refund amount must be a whole number of paise between 100 and ${remaining}`);
  }
  if (!isAdmin) {
    const [enrollment, cert] = await Promise.all([
      Enrollment.findOne({ student: p.student, course: p.course?._id }).select('completedLessons'),
      Certificate.exists({ student: p.student, course: p.course?._id, revokedAt: { $exists: false } })
    ]);
    const elig = await refundEligibility(p, { enrollment, course: p.course, hasCertificate: !!cert });
    if (!elig.eligible) return fail(res, 403, elig.reason);
  }
  const reason = String(req.body?.reason || (isAdmin ? 'Refund issued by admin' : 'Requested by student')).trim().slice(0, 500);

  // Take the per-payment lock (a stale lock older than 2 minutes is ignored).
  const locked = await Payment.findOneAndUpdate(
    {
      _id: p._id,
      status: 'paid',
      $and: [
        // payments created before this feature have no refundedPaise field yet
        { $or: [{ refundedPaise: { $lte: p.amount - amountPaise } }, { refundedPaise: { $exists: false } }] },
        { $or: [{ refundLockedAt: { $exists: false } }, { refundLockedAt: null }, { refundLockedAt: { $lt: new Date(Date.now() - 120000) } }] }
      ]
    },
    { $set: { refundLockedAt: new Date() } },
    { new: true }
  );
  if (!locked) return fail(res, 409, 'A refund for this payment is already in progress or was just completed.');

  let rzRefund;
  try {
    rzRefund = await rz.payments.refund(p.paymentId, {
      amount: amountPaise,
      speed: 'normal',
      receipt: `rf_${crypto.randomBytes(8).toString('hex')}`,
      notes: { reason, paymentRef: p.id, requestedBy: req.user.id }
    });
  } catch (e) {
    await Payment.updateOne({ _id: p._id }, { $unset: { refundLockedAt: 1 } });
    console.error('[payments] refund failed', e);
    return fail(res, 502, `Refund could not be created: ${rzMessage(e)}`);
  }
  try {
    const updated = await applyRefund(rzRefund, { reason, requestedBy: req.user.id });
    res.status(201).json({
      ok: true,
      refund: { id: rzRefund.id, amountPaise: rzRefund.amount, status: rzRefund.status },
      payment: { id: updated.id, status: updated.status, refundedPaise: updated.refundedPaise }
    });
  } finally {
    await Payment.updateOne({ _id: p._id }, { $unset: { refundLockedAt: 1 } });
  }
});

export default router;

/* ------------------------------------------------------------------ *
 *  /api/instructor/earnings
 * ------------------------------------------------------------------ */
export const earningsRouter = Router();
wrapAsync(earningsRouter);

earningsRouter.get('/earnings', auth, roles('instructor', 'admin'), async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const pct = feePercent();
  const match = { status: { $in: ['paid', 'refunded'] } };
  if (!isAdmin) {
    const owned = await Course.find({ instructor: req.user.id }).distinct('_id');
    match.$or = [{ instructor: oid(req.user.id) }, { instructor: { $exists: false }, course: { $in: owned } }];
  }
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  if ((from && isNaN(from)) || (to && isNaN(to))) return fail(res, 400, 'Invalid date range');
  if (from || to) match.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };

  const rows = await Payment.aggregate([
    { $match: match },
    {
      $addFields: {
        _share: { $ifNull: ['$instructorSharePaise', { $subtract: ['$amount', { $floor: { $divide: [{ $multiply: ['$amount', pct] }, 100] } }] }] },
        _reversed: { $ifNull: ['$instructorShareReversedPaise', 0] },
        _refunded: { $ifNull: ['$refundedPaise', 0] }
      }
    },
    {
      $group: {
        _id: '$course',
        sales: { $sum: 1 },
        grossPaise: { $sum: '$amount' },
        refundedPaise: { $sum: '$_refunded' },
        shareBeforeRefundsPaise: { $sum: '$_share' },
        reversedPaise: { $sum: '$_reversed' },
        refundCount: { $sum: { $cond: [{ $gt: ['$_refunded', 0] }, 1, 0] } }
      }
    }
  ]);
  const titles = new Map((await Course.find({ _id: { $in: rows.map(r => r._id) } }).select('title')).map(c => [String(c._id), c.title]));
  const byCourse = rows
    .map(r => ({
      courseId: r._id,
      title: titles.get(String(r._id)) || 'Removed course',
      sales: r.sales,
      refundCount: r.refundCount,
      grossPaise: r.grossPaise,
      refundedPaise: r.refundedPaise,
      netEarningsPaise: r.shareBeforeRefundsPaise - r.reversedPaise
    }))
    .sort((a, b) => b.netEarningsPaise - a.netEarningsPaise);

  const sum = k => byCourse.reduce((s, r) => s + r[k], 0);
  const grossPaise = sum('grossPaise');
  const refundedPaise = sum('refundedPaise');
  const netEarningsPaise = sum('netEarningsPaise');
  const totals = {
    sales: sum('sales'),
    refundCount: sum('refundCount'),
    grossPaise,
    refundedPaise,
    netRevenuePaise: grossPaise - refundedPaise,
    netEarningsPaise,
    platformSharePaise: grossPaise - refundedPaise - netEarningsPaise
  };

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const recentQuery = Payment.find(match).sort({ createdAt: -1 }).limit(limit).populate('course', 'title');
  if (isAdmin) recentQuery.populate('student', 'name');
  const recent = (await recentQuery).map(p => ({
    id: p.id,
    courseTitle: p.course?.title || 'Removed course',
    studentName: isAdmin ? p.student?.name || '' : undefined,
    amountPaise: p.amount,
    refundedPaise: p.refundedPaise || 0,
    netEarningsPaise: shareOf(p) - (p.instructorShareReversedPaise || 0),
    status: p.status,
    paidAt: p.paidAt || p.createdAt,
    canRefund: isAdmin && p.status === 'paid' && !!p.paymentId
  }));

  res.set('Cache-Control', 'private, no-store');
  res.json({ viewerRole: req.user.role, platformFeePercent: pct, totals, byCourse, recent });
});
