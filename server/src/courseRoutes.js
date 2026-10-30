import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Course, VideoAsset } from './models.js';
import { auth, roles } from './middleware.js';

const router=Router();
const s3=new S3Client({region:process.env.AWS_REGION,credentials:process.env.AWS_ACCESS_KEY_ID?{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}:undefined});
const validId=id=>mongoose.isValidObjectId(id);
const ownerOrAdmin=(course,user)=>user.role==='admin'||String(course.instructor)===user.id;
const fail=(res,status,error)=>res.status(status).json({error});
const safeCourse=course=>course.toObject();
router.use(auth);
router.get('/mine', roles('instructor', 'admin'), async (req, res) => {
  // Owner is derived only from the authenticated identity. Never accept an
  // instructor/owner ID from client query parameters for this endpoint.
  const filter = req.user.role === 'admin'
    ? {}
    : { instructor: req.user.id };

  const courses = await Course.find(filter)
    .sort({ updatedAt: -1 })
    .populate('instructor', 'name email'); // Authorized course managers may view answer keys in their private studio.

  res.set('Cache-Control', 'private, no-store');
  return res.json({ courses });
});
router.post('/',roles('instructor','admin'),async(req,res)=>{const {title,description='',category='',pricePaise=0}=req.body||{};if(typeof title!=='string'||title.trim().length<3||title.trim().length>180)return fail(res,400,'Course title must be 3–180 characters');if(typeof description!=='string'||description.length>10000)return fail(res,400,'Description must be at most 10,000 characters');if(typeof category!=='string'||category.length>100)return fail(res,400,'Category must be at most 100 characters');if(!Number.isSafeInteger(pricePaise)||pricePaise<0)return fail(res,400,'pricePaise must be a non-negative integer');const course=await Course.create({title:title.trim(),description,category,pricePaise,instructor:req.user.id,published:false,lessons:[]});res.status(201).json({course});});
router.get('/:id',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id))return fail(res,400,'Invalid course ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');res.json({course});});
router.patch('/:id',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id))return fail(res,400,'Invalid course ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');const allowed=['title','description','category','pricePaise'];for(const k of allowed)if(Object.hasOwn(req.body||{},k)){const v=req.body[k];if(k==='title'&&(typeof v!=='string'||v.trim().length<3||v.trim().length>180))return fail(res,400,'Invalid title');if(k==='description'&&(typeof v!=='string'||v.length>10000))return fail(res,400,'Invalid description');if(k==='category'&&(typeof v!=='string'||v.length>100))return fail(res,400,'Invalid category');if(k==='pricePaise'&&(!Number.isSafeInteger(v)||v<0))return fail(res,400,'Invalid pricePaise');course[k]=k==='title'?v.trim():v;}await course.save();res.json({course});});

// Instructor-managed quizzes. Student/public course responses must continue stripping correctIndex.
function validateQuizPayload(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const questions = body?.questions;
  if (title.length < 2 || title.length > 180) return { error: 'Quiz title must be 2–180 characters' };
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 30) return { error: 'Add 1–30 questions' };
  const normalized = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const prompt = typeof q?.prompt === 'string' ? q.prompt.trim() : '';
    if (prompt.length < 3 || prompt.length > 2000) return { error: `Question ${i + 1}: prompt must be 3–2,000 characters` };
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(x => typeof x !== 'string' || !x.trim() || x.trim().length > 500)) return { error: `Question ${i + 1}: provide exactly 4 non-empty options (max 500 characters each)` };
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) return { error: `Question ${i + 1}: select the correct option` };
    const points = q.points === undefined ? 1 : q.points;
    if (!Number.isInteger(points) || points < 1 || points > 100) return { error: `Question ${i + 1}: points must be 1–100` };
    normalized.push({ prompt, options: q.options.map(x => x.trim()), correctIndex: q.correctIndex, points });
  }
  return { value: { title, questions: normalized } };
}
router.post('/:id/quizzes', roles('instructor','admin'), async (req,res) => {
  if (!validId(req.params.id)) return fail(res,400,'Invalid course ID');
  const course=await Course.findById(req.params.id);
  if(!course)return fail(res,404,'Course not found');
  if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');
  const parsed=validateQuizPayload(req.body||{}); if(parsed.error)return fail(res,400,parsed.error);
  course.quizzes.push(parsed.value); await course.save();
  res.status(201).json({course,quiz:course.quizzes.at(-1)});
});
router.patch('/:id/quizzes/:quizId', roles('instructor','admin'), async (req,res) => {
  if (!validId(req.params.id)||!validId(req.params.quizId)) return fail(res,400,'Invalid course or quiz ID');
  const course=await Course.findById(req.params.id);
  if(!course)return fail(res,404,'Course not found');
  if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');
  const quiz=course.quizzes.id(req.params.quizId); if(!quiz)return fail(res,404,'Quiz not found');
  const parsed=validateQuizPayload(req.body||{}); if(parsed.error)return fail(res,400,parsed.error);
  quiz.title=parsed.value.title; quiz.questions=parsed.value.questions; await course.save();
  res.json({course,quiz});
});
router.delete('/:id/quizzes/:quizId', roles('instructor','admin'), async (req,res) => {
  if (!validId(req.params.id)||!validId(req.params.quizId)) return fail(res,400,'Invalid course or quiz ID');
  const course=await Course.findById(req.params.id);
  if(!course)return fail(res,404,'Course not found');
  if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');
  const quiz=course.quizzes.id(req.params.quizId); if(!quiz)return fail(res,404,'Quiz not found');
  course.quizzes.pull({_id:quiz._id}); await course.save(); res.json({ok:true});
});

router.post('/:id/lessons',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id))return fail(res,400,'Invalid course ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');const {title,description=''}=req.body||{};if(typeof title!=='string'||title.trim().length<2||title.trim().length>180)return fail(res,400,'Lesson title must be 2–180 characters');if(typeof description!=='string'||description.length>4000)return fail(res,400,'Invalid lesson description');course.lessons.push({title:title.trim(),description,order:course.lessons.length,videoStatus:'missing'});await course.save();res.status(201).json({course,lesson:course.lessons.at(-1)});});
router.patch('/:id/lessons/:lessonId',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id)||!validId(req.params.lessonId))return fail(res,400,'Invalid ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');const lesson=course.lessons.id(req.params.lessonId);if(!lesson)return fail(res,404,'Lesson not found');const {title,description,order}=req.body||{};if(title!==undefined){if(typeof title!=='string'||title.trim().length<2||title.trim().length>180)return fail(res,400,'Invalid lesson title');lesson.title=title.trim();}if(description!==undefined){if(typeof description!=='string'||description.length>4000)return fail(res,400,'Invalid description');lesson.description=description;}if(order!==undefined){if(!Number.isInteger(order)||order<0||order>=course.lessons.length)return fail(res,400,'Invalid lesson order');const list=course.lessons.filter(x=>String(x._id)!==String(lesson._id));list.splice(order,0,lesson);list.forEach((x,i)=>x.order=i);course.lessons=list;}await course.save();res.json({course});});
router.delete('/:id/lessons/:lessonId',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id)||!validId(req.params.lessonId))return fail(res,400,'Invalid ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');const lesson=course.lessons.id(req.params.lessonId);if(!lesson)return fail(res,404,'Lesson not found');course.lessons.pull({_id:lesson._id});course.lessons.forEach((x,i)=>x.order=i);await course.save();res.json({course});});
router.post('/:id/publish',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id))return fail(res,400,'Invalid course ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');if(course.title.trim().length<3||!course.lessons.length)return fail(res,400,'Add a course title and at least one lesson before publishing');const notReady=course.lessons.filter(l=>l.videoStatus!=='ready'||!l.videoUrl);if(notReady.length)return fail(res,400,`${notReady.length} lesson video(s) are not ready yet`);course.published=true;await course.save();res.json({course});});
router.post('/:id/unpublish',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.id))return fail(res,400,'Invalid course ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');course.published=false;await course.save();res.json({course});});
router.post('/:id/lessons/:lessonId/upload-intent',roles('instructor','admin'),async(req,res)=>{if(!process.env.S3_BUCKET)return fail(res,503,'Video storage is not configured');if(!validId(req.params.id)||!validId(req.params.lessonId))return fail(res,400,'Invalid ID');const course=await Course.findById(req.params.id);if(!course)return fail(res,404,'Course not found');if(!ownerOrAdmin(course,req.user))return fail(res,403,'You do not manage this course');const lesson=course.lessons.id(req.params.lessonId);if(!lesson)return fail(res,404,'Lesson not found');const {filename,contentType,size}=req.body||{};const allowed=new Set(['video/mp4','video/quicktime','video/webm']);if(typeof filename!=='string'||filename.length>255||!allowed.has(contentType)||!Number.isSafeInteger(size)||size<1||size>2*1024*1024*1024)return fail(res,400,'Choose MP4, MOV, or WebM video up to 2 GB');const assetId=new mongoose.Types.ObjectId();const key=`sources/${req.user.id}/${course.id}/${assetId}/${crypto.randomUUID()}`;const asset=await VideoAsset.create({_id:assetId,course:course._id,lesson:lesson._id,owner:req.user.id,key,originalName:filename.replace(/[\\/\0]/g,'_').slice(0,255),contentType,expectedBytes:size,status:'awaiting-upload'});lesson.videoAssetId=asset._id;lesson.videoStatus='uploading';lesson.videoUrl=undefined;await course.save();try{const uploadUrl=await getSignedUrl(s3,new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,ContentType:contentType,ContentLength:size}),{expiresIn:600});res.status(201).json({assetId:asset.id,uploadUrl,headers:{'Content-Type':contentType},expiresIn:600,maxBytes:2*1024*1024*1024});}catch(e){await VideoAsset.findByIdAndDelete(asset._id);lesson.videoStatus='missing';await course.save();throw e;}});
router.post('/assets/:assetId/upload-complete',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.assetId))return fail(res,400,'Invalid asset ID');const asset=await VideoAsset.findById(req.params.assetId);if(!asset)return fail(res,404,'Upload record not found');if(req.user.role!=='admin'&&String(asset.owner)!==req.user.id)return fail(res,403,'Not your upload');if(asset.status!=='awaiting-upload')return fail(res,409,'This upload has already been submitted');const head=await s3.send(new HeadObjectCommand({Bucket:process.env.S3_BUCKET,Key:asset.key}));if(head.ContentLength!==asset.expectedBytes||head.ContentType!==asset.contentType)return fail(res,400,'Uploaded file size/type does not match upload request');asset.status='queued';await asset.save();const course=await Course.findById(asset.course);if(!course)return fail(res,404,'Course not found');const lesson=course.lessons.id(asset.lesson);if(!lesson||String(lesson.videoAssetId)!==asset.id)return fail(res,409,'This video no longer belongs to the lesson');lesson.videoStatus='processing';await course.save();const {videoQueue}=req.app.locals;let job;try{job=await videoQueue.add('transcode',{key:asset.key,userId:asset.owner.toString(),assetId:asset.id,courseId:asset.course.toString(),lessonId:asset.lesson.toString()},{attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:100,removeOnFail:200});}catch(e){asset.status='failed';asset.error='Could not reach the video queue (Redis). '+String(e.message||'').slice(0,300);await asset.save();lesson.videoStatus='failed';await course.save();return fail(res,503,'Video queue is unavailable. Check that Redis is running and retry.');}asset.jobId=String(job.id);await asset.save();let workers=null;try{workers=(await videoQueue.getWorkers()).length}catch{}res.status(202).json({assetId:asset.id,jobId:job.id,status:'queued',workersOnline:workers,warning:workers===0?'No video worker is running, so this upload will stay queued. Start it with `npm run worker` (or set EMBED_VIDEO_WORKER=true).':undefined});});
router.get('/assets/:assetId',roles('instructor','admin'),async(req,res)=>{if(!validId(req.params.assetId))return fail(res,400,'Invalid asset ID');const a=await VideoAsset.findById(req.params.assetId);if(!a)return fail(res,404,'Asset not found');if(req.user.role!=='admin'&&String(a.owner)!==req.user.id)return fail(res,403,'Not your asset');let workers=null,progress=null;if(['queued','processing'].includes(a.status)){try{const q=req.app.locals.videoQueue;workers=(await q.getWorkers()).length;const j=a.jobId?await q.getJob(a.jobId):null;progress=typeof j?.progress==='number'?j.progress:null}catch{}}res.json({asset:{id:a.id,status:a.status,error:a.error||null,jobId:a.jobId,workersOnline:workers,progress}});});
export default router;
