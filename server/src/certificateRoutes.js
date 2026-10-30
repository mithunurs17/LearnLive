import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import { Certificate, Enrollment } from './models.js';
import { auth, roles } from './middleware.js';
import { renderCertificate } from './certificate.js';

const router = Router();
const PASS_RATIO = 0.6;   // same pass mark the quiz grader uses
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
// Express 4 won't catch async rejections by itself.
for (const m of ['get', 'post']) {
  const orig = router[m].bind(router);
  router[m] = (p, ...hs) => orig(p, ...hs.map(h => (typeof h === 'function' && h.length < 4 ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h)));
}

const publicBase = () => (process.env.PUBLIC_CLIENT_URL || process.env.CLIENT_ORIGIN?.split(',')[0] || 'http://localhost:5173').replace(/\/+$/, '');
const verifyUrl = id => `${publicBase()}/verify/${id}`;
const newCertificateId = () => 'LL-' + crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 10);

/** Single source of truth for "has this student really finished this course?" */
export function evaluateCompletion(enrollment, course) {
  const total = course.lessons?.length || 0;
  const done = new Set((enrollment.completedLessons || []).filter(i => Number.isInteger(i) && i >= 0 && i < total));
  const quizzes = (course.quizzes || []).map((q, i) => {
    const attempts = (enrollment.quizScores || []).filter(s => s.quizIndex === i && s.maxScore > 0);
    const best = attempts.length ? Math.max(...attempts.map(a => a.score / a.maxScore)) : null;
    return { index: i, title: q.title || `Quiz ${i + 1}`, attempts: attempts.length, bestPercent: best == null ? null : Math.round(best * 100), passed: best != null && best >= PASS_RATIO };
  });
  const missing = [];
  if (!total) missing.push('This course has no lessons yet.');
  else if (done.size < total) missing.push(`Complete all lessons (${done.size}/${total} done).`);
  const unpassed = quizzes.filter(q => !q.passed);
  if (unpassed.length) missing.push(`Pass ${unpassed.length === 1 ? 'the quiz' : 'all quizzes'} with at least ${Math.round(PASS_RATIO * 100)}%: ${unpassed.map(q => q.title).join(', ')}.`);
  const avg = quizzes.length ? quizzes.reduce((s, q) => s + q.bestPercent, 0) / quizzes.length : null;
  return { eligible: missing.length === 0, lessons: { done: done.size, total }, quizzes, quizAverage: avg, missing };
}

async function loadOwn(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Enrollment.findOne({ _id: req.params.id, student: req.user.id }).populate({ path: 'course', populate: { path: 'instructor', select: 'name' } });
}

// Eligibility + issued certificate (for the dashboard).
router.get('/enrollments/:id/certificate/status', auth, roles('student'), async (req, res) => {
  const e = await loadOwn(req);
  if (!e || !e.course) return fail(res, 404, 'Enrollment not found');
  const status = evaluateCompletion(e, e.course);
  const cert = await Certificate.findOne({ enrollment: e._id, revokedAt: { $exists: false } }).select('certificateId issuedAt');
  res.set('Cache-Control', 'private, no-store');
  res.json({ ...status, certificate: cert ? { certificateId: cert.certificateId, issuedAt: cert.issuedAt } : null });
});

// Download (issues the certificate the first time, only after server-side completion validation).
router.get('/enrollments/:id/certificate', auth, roles('student'), async (req, res) => {
  const e = await loadOwn(req);
  if (!e || !e.course) return fail(res, 404, 'Enrollment not found');
  const status = evaluateCompletion(e, e.course);
  if (!status.eligible) return fail(res, 400, 'Course not completed yet. ' + status.missing.join(' '), { missing: status.missing });

  let cert = await Certificate.findOne({ enrollment: e._id });
  if (cert?.revokedAt) return fail(res, 403, 'This certificate has been revoked. Contact support.');
  if (!cert) {
    for (let attempt = 0; attempt < 4 && !cert; attempt++) {
      try {
        cert = await Certificate.create({
          certificateId: newCertificateId(), enrollment: e._id, student: req.user.id, course: e.course._id,
          studentName: req.user.name, courseTitle: e.course.title, instructorName: e.course.instructor?.name || '',
          lessonsTotal: status.lessons.total, quizAverage: status.quizAverage
        });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        cert = await Certificate.findOne({ enrollment: e._id });   // concurrent request already issued it
      }
    }
    if (!e.completedAt) { e.completedAt = new Date(); await e.save(); }
  }

  let qr = null;
  try { const QRCode = (await import('qrcode')).default; qr = await QRCode.toBuffer(verifyUrl(cert.certificateId), { margin: 0, width: 240 }); }
  catch { /* qrcode not installed: the certificate still carries the ID and URL */ }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="LearnLive-Certificate-${cert.certificateId}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate of Completion – ${cert.courseTitle}`, Author: 'LearnLive', Subject: cert.certificateId } });
  pdf.pipe(res);
  renderCertificate(pdf, {
    studentName: cert.studentName, courseTitle: cert.courseTitle, instructorName: cert.instructorName,
    awardedOn: cert.issuedAt, certificateId: cert.certificateId, verifyUrl: verifyUrl(cert.certificateId),
    qr, lessonsTotal: cert.lessonsTotal, quizAverage: cert.quizAverage
  });
  pdf.end();
});

// Public verification (no login). Returns only non-sensitive facts.
router.get('/certificates/verify/:certId', async (req, res) => {
  const id = String(req.params.certId || '').toUpperCase();
  res.set('Cache-Control', 'no-store');
  if (!/^LL-[0-9A-F]{10}$/.test(id)) return res.status(404).json({ valid: false, error: 'Certificate not found' });
  const cert = await Certificate.findOne({ certificateId: id });
  if (!cert) return res.status(404).json({ valid: false, error: 'Certificate not found' });
  if (cert.revokedAt) return res.json({ valid: false, revoked: true, certificateId: id, error: 'This certificate has been revoked' });
  res.json({ valid: true, certificateId: id, studentName: cert.studentName, courseTitle: cert.courseTitle, instructorName: cert.instructorName, issuedAt: cert.issuedAt });
});

export default router;
