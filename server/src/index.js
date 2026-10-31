import 'dotenv/config';
import express from 'express';import cors from 'cors';import helmet from 'helmet';import rateLimit from 'express-rate-limit';import mongoose from 'mongoose';import bcrypt from 'bcryptjs';import crypto from 'node:crypto';import Razorpay from 'razorpay';import PDFDocument from 'pdfkit';import {AccessToken} from 'livekit-server-sdk';import {Queue} from 'bullmq';import IORedis from 'ioredis';import {User,Course,Enrollment,Payment,LiveClass,LiveAttendance} from './models.js';import {auth,roles} from './middleware.js';import authRoutes from './authRoutes.js';import courseRoutes from './courseRoutes.js';import studentRoutes from './studentRoutes.js';import liveRoutes from './liveRoutes.js';import certificateRoutes from './certificateRoutes.js';import paymentRoutes,{earningsRouter,webhookHandler} from './paymentRoutes.js';
const app=express();app.set('trust proxy',1);app.use(helmet());app.use(cors({origin:process.env.CLIENT_ORIGIN?.split(',')||'http://localhost:5173'}));
// Razorpay webhook needs the exact raw bytes for signature verification, so it is mounted before express.json().
app.post('/api/payments/webhook',express.raw({type:'*/*',limit:'1mb'}),webhookHandler);
app.use(express.json({limit:'1mb'}));app.use('/api',rateLimit({windowMs:60000,limit:120}));
if(!process.env.MONGODB_URI||!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32)throw new Error('MONGODB_URI and a JWT_SECRET of at least 32 characters are required');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.allSettled([LiveClass.syncIndexes(),LiveAttendance.syncIndexes()]);
process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e));
const redis=new IORedis(process.env.REDIS_URL||'redis://127.0.0.1:6379',{maxRetriesPerRequest:null});const videoQueue=new Queue('video-processing',{connection:redis});app.locals.videoQueue=videoQueue;
// Convenience: run the transcoder inside the API process (no separate `npm run worker` needed).
if(process.env.EMBED_VIDEO_WORKER==='true')await import('./workers/videoWorker.js');

const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});
app.get('/api/health',(_,res)=>res.json({ok:true,service:'LearnLive API'}));
app.use('/api/auth',authRoutes);app.use('/api/instructor/courses',courseRoutes);app.use('/api/learning',studentRoutes);app.use('/api/live',liveRoutes);app.use('/api',certificateRoutes);app.use('/api/payments',paymentRoutes);app.use('/api/instructor',earningsRouter);
app.get('/api/courses',async(req,res)=>res.json(await Course.find({published:true}).populate('instructor','name').select('-quizzes.questions.correctIndex')));
app.get('/api/courses/:id',async(req,res)=>{const c=await Course.findById(req.params.id).populate('instructor','name').select('-quizzes.questions.correctIndex');if(!c)return res.status(404).json({error:'Course not found'});if(!c.published)return res.status(404).json({error:'Course not found'});res.json(c)});
app.post('/api/courses/:id/enroll',auth,roles('student'),async(req,res)=>{
 const course=await Course.findOne({_id:req.params.id,published:true});if(!course)return res.sendStatus(404);
 const existing=await Enrollment.findOne({student:req.user.id,course:course.id});
 if(existing)return res.status(409).json({error:'You are already enrolled in this course.'});
 if(course.pricePaise>0&&!await Payment.findOne({student:req.user.id,course:course.id,status:'paid'}))return res.status(402).json({error:'Payment required before enrollment'});
 try{const enrollment=await Enrollment.create({student:req.user.id,course:course.id,completedLessons:[],quizScores:[]});return res.status(201).json(enrollment);}
 catch(e){if(e?.code===11000)return res.status(409).json({error:'You are already enrolled in this course.'});throw e;}
});
app.get('/api/me/enrollments',auth,roles('student'),async(req,res)=>{const rows=await Enrollment.find({student:req.user.id}).populate('course','title lessons quizzes instructor pricePaise');const safe=rows.map(row=>{const item=row.toObject();if(item.course?.quizzes)item.course.quizzes=item.course.quizzes.map(q=>({...q,questions:q.questions.map(question=>{const copy={...question};delete copy.correctIndex;return copy;})}));return item;});res.set('Cache-Control','private, no-store');res.json(safe)});
app.post('/api/enrollments/:id/lessons/:lessonIndex/complete',auth,roles('student'),async(req,res)=>{const e=await Enrollment.findOne({_id:req.params.id,student:req.user.id}).populate('course');if(!e)return res.sendStatus(404);const i=Number(req.params.lessonIndex);if(!Number.isInteger(i)||i<0||i>=e.course.lessons.length)return res.status(400).json({error:'Invalid lesson'});if(!e.completedLessons.includes(i))e.completedLessons.push(i);if(e.completedLessons.length===e.course.lessons.length&&e.course.lessons.length)e.completedAt=new Date();await e.save();res.json({completedLessons:e.completedLessons,completedAt:e.completedAt||null})});
app.post('/api/enrollments/:id/quizzes/:quizIndex/submit',auth,roles('student'),async(req,res)=>{
 const e=await Enrollment.findOne({_id:req.params.id,student:req.user.id}).populate('course');if(!e)return res.sendStatus(404);
 const qi=Number(req.params.quizIndex),q=e.course.quizzes[qi];if(!Number.isInteger(qi)||!q)return res.sendStatus(404);
 const answers=req.body?.answers;if(!Array.isArray(answers)||answers.length!==q.questions.length)return res.status(400).json({error:'Submit one answer for every question'});
 if(answers.some((answer,i)=>typeof answer!=='number'||!Number.isInteger(answer)||answer<0||answer>=q.questions[i].options.length))return res.status(400).json({error:'Choose an answer for every question'});
 let score=0,maxScore=0;const review=[];q.questions.forEach((question,i)=>{const pts=question.points||1;maxScore+=pts;const correct=Number(answers[i])===question.correctIndex;if(correct)score+=pts;review.push({correct,correctIndex:question.correctIndex,points:pts});});
 e.quizScores.push({quizIndex:qi,score,maxScore});await e.save();res.json({score,maxScore,percent:maxScore?Math.round(score/maxScore*100):0,passed:maxScore?score/maxScore>=.6:false,attemptNumber:e.quizScores.filter(a=>a.quizIndex===qi).length,review});
});
// Certificates (completion validation, PDF, public verification) live in certificateRoutes.js
app.get('/api/instructor/analytics',auth,roles('instructor','admin'),async(req,res)=>{const own=req.user.role==='admin'?{}:{instructor:req.user.id};const courses=await Course.find(own).select('_id title pricePaise');const ids=courses.map(c=>c._id);const paid=await Payment.aggregate([{$match:{course:{$in:ids},status:'paid'}},{$group:{_id:'$course',gross:{$sum:'$amount'},sales:{$sum:1}}}]);const enrollments=await Enrollment.countDocuments({course:{$in:ids}});res.json({courses:courses.length,enrollments,revenuePaise:paid.reduce((s,p)=>s+p.gross,0),sales:paid.reduce((s,p)=>s+p.sales,0),byCourse:paid})});
// Payments (checkout, verify, webhook, refunds) and instructor earnings live in paymentRoutes.js
// Legacy open /live/token removed: joining is now authorized per scheduled class in liveRoutes.js
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Unexpected server error'})});
const port=process.env.PORT||4000;app.listen(port,()=>console.log(`LearnLive API listening on ${port}`));
