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
const worker=new Worker('video-processing',async job=>{
 const {key,assetId,courseId,lessonId,userId}=job.data;const dir=path.join(os.tmpdir(),`learnlive-${job.id}`);await mkdir(dir,{recursive:true});const input=path.join(dir,'source.bin'),out=path.join(dir,'hls');await mkdir(out);
 try{
  const asset=await VideoAsset.findById(assetId);if(!asset||String(asset.owner)!==String(userId)||asset.key!==key)throw Error('Upload metadata could not be verified');
  asset.status='processing';asset.error=undefined;await asset.save();
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));await pipeline(obj.Body,createWriteStream(input));
  await new Promise((resolve,reject)=>{const args=['-y','-i',input,'-preset','veryfast','-codec:v','libx264','-codec:a','aac','-hls_time','6','-hls_playlist_type','vod','-hls_segment_filename',path.join(out,'segment_%03d.ts'),path.join(out,'index.m3u8')];const proc=spawn('ffmpeg',args);let log='';proc.stderr.on('data',d=>log=(log+d.toString()).slice(-5000));proc.on('error',reject);proc.on('close',code=>code===0?resolve():reject(Error(`ffmpeg exited ${code}: ${log.slice(-2500)}`)));});
  const names=await readdir(out);if(!names.includes('index.m3u8')||!names.some(n=>n.endsWith('.ts')))throw Error('Transcode did not produce a valid HLS playlist and segments');
  for(const name of names){const file=path.join(out,name);await s3.send(new PutObjectCommand({Bucket:bucket,Key:`hls/${userId}/${job.id}/${name}`,Body:createReadStream(file),ContentLength:(await stat(file)).size,ContentType:name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t',CacheControl:'public,max-age=31536000,immutable'}));}
  if(!process.env.CLOUDFRONT_DOMAIN)throw Error('CLOUDFRONT_DOMAIN is required for browser playback');
  const playbackUrl=`https://${process.env.CLOUDFRONT_DOMAIN}/hls/${userId}/${job.id}/index.m3u8`;
  const course=await Course.findById(courseId);if(!course)throw Error('Course no longer exists');const lesson=course.lessons.id(lessonId);if(!lesson||String(lesson.videoAssetId)!==String(assetId))throw Error('Lesson video changed while processing');
  lesson.videoUrl=playbackUrl;lesson.videoStatus='ready';await course.save();asset.status='ready';asset.playbackUrl=playbackUrl;await asset.save();return{playbackUrl,assetId};
 }catch(error){const finalAttempt=(job.attemptsMade+1)>=(job.opts.attempts||1);await VideoAsset.findByIdAndUpdate(assetId,{$set:{status:finalAttempt?'failed':'queued',error:finalAttempt?String(error.message||'Processing failed').slice(0,1000):undefined}}).catch(()=>{});if(finalAttempt)await Course.updateOne({_id:courseId,'lessons._id':lessonId,'lessons.videoAssetId':assetId},{$set:{'lessons.$.videoStatus':'failed'}}).catch(()=>{});throw error;
 }finally{await rm(dir,{recursive:true,force:true});}
},{connection,concurrency:Number(process.env.VIDEO_WORKER_CONCURRENCY)||2});
worker.on('completed',j=>console.log('Video transcode complete',j.id));worker.on('failed',(j,e)=>console.error('Video transcode failed',j?.id,e.message));
const stop=async()=>{await worker.close();await connection.quit();await mongoose.disconnect();process.exit(0)};process.on('SIGINT',stop);process.on('SIGTERM',stop);
