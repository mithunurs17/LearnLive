import { Router } from 'express';
import mongoose from 'mongoose';
import { auth, roles } from './middleware.js';
import { Course, Enrollment } from './models.js';

const router = Router();
router.use(auth, roles('student'));
const validId = value => mongoose.isValidObjectId(value);
const fail = (res, status, error) => res.status(status).json({ error });
const safeQuiz = (quiz, index) => ({
  index,
  title: quiz.title || `Quiz ${index + 1}`,
  questions: (quiz.questions || []).map((q, questionIndex) => ({
    index: questionIndex,
    prompt: q.prompt,
    options: q.options,
    points: q.points || 1
  }))
});

// Student dashboard. Correct answers are never included in this response.
router.get('/enrollments', async (req, res) => {
  const enrollments = await Enrollment.find({ student: req.user.id })
    .sort({ updatedAt: -1 })
    .populate({ path: 'course', populate: { path: 'instructor', select: 'name' } });
  const result = enrollments.filter(e => e.course).map(e => {
    const course = e.course.toObject();
    course.quizzes = (course.quizzes || []).map((quiz, i) => safeQuiz(quiz, i));
    return {
      id: e.id,
      completedLessons: e.completedLessons || [],
      quizScores: e.quizScores || [],
      completedAt: e.completedAt || null,
      enrolledAt: e.createdAt,
      course
    };
  });
  res.json({ enrollments: result });
});

// Mark one enrolled lesson complete using its current ordered index.
router.post('/enrollments/:enrollmentId/lessons/:lessonIndex/complete', async (req, res) => {
  const { enrollmentId, lessonIndex } = req.params;
  if (!validId(enrollmentId)) return fail(res, 400, 'Invalid enrollment ID');
  const enrollment = await Enrollment.findOne({ _id: enrollmentId, student: req.user.id }).populate('course');
  if (!enrollment || !enrollment.course) return fail(res, 404, 'Enrollment not found');
  const index = Number(lessonIndex);
  if (!Number.isInteger(index) || index < 0 || index >= enrollment.course.lessons.length) return fail(res, 400, 'Invalid lesson');
  if (!enrollment.completedLessons.includes(index)) enrollment.completedLessons.push(index);
  if (enrollment.completedLessons.length >= enrollment.course.lessons.length && enrollment.course.lessons.length) {
    enrollment.completedAt = enrollment.completedAt || new Date();
  }
  await enrollment.save();
  res.json({ completedLessons: enrollment.completedLessons, completedAt: enrollment.completedAt || null });
});

// Submit quiz answers. Grading is performed server-side; clients cannot supply scores.
router.post('/enrollments/:enrollmentId/quizzes/:quizIndex/submit', async (req, res) => {
  const { enrollmentId, quizIndex } = req.params;
  if (!validId(enrollmentId)) return fail(res, 400, 'Invalid enrollment ID');
  const enrollment = await Enrollment.findOne({ _id: enrollmentId, student: req.user.id }).populate('course');
  if (!enrollment || !enrollment.course) return fail(res, 404, 'Enrollment not found');
  const qi = Number(quizIndex);
  if (!Number.isInteger(qi) || qi < 0 || qi >= enrollment.course.quizzes.length) return fail(res, 404, 'Quiz not found');
  const quiz = enrollment.course.quizzes[qi];
  const questions = quiz.questions || [];
  if (!questions.length || questions.length > 100) return fail(res, 400, 'This quiz is not available');
  const answers = req.body?.answers;
  if (!Array.isArray(answers) || answers.length !== questions.length) return fail(res, 400, 'Submit one answer for every question');
  let score = 0, maxScore = 0;
  const review = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const chosen = answers[i];
    const pts = Number.isSafeInteger(q.points) && q.points > 0 ? q.points : 1;
    maxScore += pts;
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= (q.options || []).length) return fail(res, 400, `Invalid answer for question ${i + 1}`);
    const correct = chosen === q.correctIndex;
    if (correct) score += pts;
    review.push({ questionIndex: i, chosenIndex: chosen, correctIndex: q.correctIndex, correct, pointsEarned: correct ? pts : 0, pointsPossible: pts });
  }
  if (!Number.isSafeInteger(maxScore) || maxScore <= 0) return fail(res, 400, 'Quiz scoring configuration is invalid');
  const attempt = { quizIndex: qi, score, maxScore, submittedAt: new Date() };
  enrollment.quizScores.push(attempt);
  await enrollment.save();
  const attemptNumber = enrollment.quizScores.filter(s => s.quizIndex === qi).length;
  res.json({ score, maxScore, percent: Math.round(score / maxScore * 100), passed: score / maxScore >= 0.6, attemptNumber, review });
});

export default router;
