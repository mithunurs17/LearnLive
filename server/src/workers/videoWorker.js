import 'dotenv/config';
import {Worker} from 'bullmq';import IORedis from 'ioredis';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {spawn} from 'node:child_process';import {createWriteStream,createReadStream} from 'node:fs';import {mkdir,rm,readdir,stat} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {pipeline} from 'node:stream/promises';
import mongoose from 'mongoose';import {Course,VideoAsset} from '../models.js';
if(!process.env.MONGODB_URI||!process.env.S3_BUCKET)throw new Error('MONGODB_URI and S3_BUCKET are required for video worker');
await mongoose.connect(process.env.MONGODB_URI);
const connection=new IORedis(process.env.REDIS_URL||'redis://127.0.0.1:6379',{maxRetriesPerRequest:null});
const s3=new S3Client({region:process.env.AWS_REGION,credentials:process.env.AWS_ACCESS_KEY_ID?{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}:undefined});
const bucket=process.env.S3_BUCKET;
await new Promise((resolve,reject)=>{const p=spawn('ffmpeg',['-version']);p.on('error',()=>reject(Error('ffmpeg is not installed or not on PATH; the video worker cannot transcode. Install ffmpeg and restart.')));p.on('close',resolve)});
if(!process.env.CLOUDFRONT_DOMAIN)throw new Error('CLOUDFRONT_DOMAIN is required (playback URL base); set it before starting the video worker');
console.log('Video worker ready: waiting for jobs on queue video-processing');
const worker=new Worker('video-processing',async job=>{
 const {key,assetId,courseId,lessonId,userId}=job.data;const dir=path.join(os.tmpdir(),`learnlive-${job.id}`);await mkdir(dir,{recursive:true});const input=path.join(dir,'source.bin'),out=path.join(dir,'hls');await mkdir(out);
 try{
  const asset=await VideoAsset.findById(assetId);if(!asset||String(asset.owner)!==String(userId)||asset.key!==key)throw Error('Upload metadata could not be verified');
  asset.status='processing';asset.error=undefined;await asset.save();
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));await pipeline(obj.Body,createWriteStream(input));await job.updateProgress(3);
  // Probe first: H.264 (+AAC) sources are repackaged to HLS without re-encoding (seconds, not minutes).
  const probe=await new Promise(resolve=>{let o='';const p=spawn('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name','-of','csv=p=0',input]);p.stdout.on('data',d=>o+=d);p.on('error',()=>resolve(''));p.on('close',()=>resolve(o))});
  const lines=probe.split('\n').map(x=>x.trim()).filter(Boolean);const vcodec=lines.find(l=>l.endsWith(',video')||l.includes('video'));const acodecs=lines.filter(l=>l.includes('audio'));
  const canCopy=/h264/.test(vcodec||'')&&acodecs.every(l=>/aac/.test(l));
  const common=['-hls_time','6','-hls_playlist_type','vod','-hls_flags','independent_segments','-hls_segment_filename',path.join(out,'segment_%03d.ts'),path.join(out,'index.m3u8')];
  const args=canCopy?['-y','-i',input,'-map','0:v:0','-map','0:a:0?','-c','copy',...common]:['-y','-i',input,'-map','0:v:0','-map','0:a:0?','-vf',"scale=-2:'min(720,ih)'",'-c:v','libx264','-preset','veryfast','-crf','25','-pix_fmt','yuv420p','-threads','0','-c:a','aac','-b:a','128k','-g','48','-sc_threshold','0',...common];
  console.log(`Job ${job.id}: ${canCopy?'remuxing (no re-encode)':'transcoding to 720p'}`);await job.updateProgress(5);
  await new Promise((resolve,reject)=>{const proc=spawn('ffmpeg',args);let log='';let duration=0;const timer=setTimeout(()=>{proc.kill('SIGKILL');reject(Error('ffmpeg timed out after 30 minutes'))},30*60*1000);proc.stderr.on('data',d=>{const t=d.toString();log=(log+t).slice(-5000);const dm=t.match(/Duration:\s*(\d+):(\d+):(\d+)/);if(dm)duration=+dm[1]*3600+ +dm[2]*60+ +dm[3];const tm=[...t.matchAll(/time=(\d+):(\d+):(\d+)/g)].pop();if(tm&&duration){const pct=Math.min(90,5+Math.round((+tm[1]*3600+ +tm[2]*60+ +tm[3])/duration*85));job.updateProgress(pct).catch(()=>{})}});proc.on('error',e=>{clearTimeout(timer);reject(e)});proc.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`ffmpeg exited ${code}: ${log.slice(-2500)}`))});});
  const names=await readdir(out);if(!names.includes('index.m3u8')||!names.some(n=>n.endsWith('.ts')))throw Error('Transcode did not produce a valid HLS playlist and segments');
  await job.updateProgress(92);
  const put=async name=>{const file=path.join(out,name);await s3.send(new PutObjectCommand({Bucket:bucket,Key:`hls/${userId}/${job.id}/${name}`,Body:createReadStream(file),ContentLength:(await stat(file)).size,ContentType:name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t',CacheControl:'public,max-age=31536000,immutable'}))};
  const queueNames=names.filter(n=>n!=='index.m3u8');await Promise.all(Array.from({length:6},async()=>{while(queueNames.length)await put(queueNames.shift())}));await put('index.m3u8');
  if(!process.env.CLOUDFRONT_DOMAIN)throw Error('CLOUDFRONT_DOMAIN is required for browser playback');
  const playbackUrl=`https://${process.env.CLOUDFRONT_DOMAIN}/hls/${userId}/${job.id}/index.m3u8`;
  const course=await Course.findById(courseId);if(!course)throw Error('Course no longer exists');const lesson=course.lessons.id(lessonId);if(!lesson||String(lesson.videoAssetId)!==String(assetId))throw Error('Lesson video changed while processing');
  lesson.videoUrl=playbackUrl;lesson.videoStatus='ready';await course.save();asset.status='ready';asset.playbackUrl=playbackUrl;await asset.save();return{playbackUrl,assetId};
 }catch(error){const finalAttempt=(job.attemptsMade+1)>=(job.opts.attempts||1);await VideoAsset.findByIdAndUpdate(assetId,{$set:{status:finalAttempt?'failed':'queued',error:String(error.message||'Processing failed').slice(0,1000)}}).catch(()=>{});if(finalAttempt)await Course.updateOne({_id:courseId,'lessons._id':lessonId,'lessons.videoAssetId':assetId},{$set:{'lessons.$.videoStatus':'failed'}}).catch(()=>{});throw error;
 }finally{await rm(dir,{recursive:true,force:true});}
},{connection,concurrency:Number(process.env.VIDEO_WORKER_CONCURRENCY)||1,lockDuration:120000,stalledInterval:60000});
worker.on('completed',j=>console.log('Video transcode complete',j.id));worker.on('failed',(j,e)=>console.error('Video transcode failed',j?.id,e.message));
const stop=async()=>{await worker.close();await connection.quit();await mongoose.disconnect();process.exit(0)};process.on('SIGINT',stop);process.on('SIGTERM',stop);
