import {Router} from 'express';
import bcrypt from 'bcryptjs';import jwt from 'jsonwebtoken';import rateLimit from 'express-rate-limit';import {timingSafeEqual} from 'node:crypto';
import {User} from './models.js';import {auth,roles} from './middleware.js';
const router=Router(),limit=rateLimit({windowMs:900000,limit:12,standardHeaders:true,legacyHeaders:false,message:{error:'Too many authentication attempts. Try again later.'}});
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,status:u.status,createdAt:u.createdAt});
const tokenFor=u=>jwt.sign({sub:u.id,ver:u.tokenVersion||0},process.env.JWT_SECRET,{expiresIn:'8h',issuer:'learnlive-api',audience:'learnlive-client'});
const validEmail=s=>typeof s==='string'&&s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const validPassword=s=>typeof s==='string'&&s.length>=12&&s.length<=128&&/[a-z]/.test(s)&&/[A-Z]/.test(s)&&/\d/.test(s);
router.post('/register',limit,async(req,res)=>{try{
 const name=typeof req.body.name==='string'?req.body.name.trim():'',email=typeof req.body.email==='string'?req.body.email.trim().toLowerCase():'',password=req.body.password;
 if(name.length<2||name.length>80)return res.status(400).json({error:'Name must contain 2–80 characters'});
 if(!validEmail(email))return res.status(400).json({error:'Enter a valid email address'});
 if(!validPassword(password))return res.status(400).json({error:'Password must be 12–128 characters and include uppercase, lowercase, and a number'});
 if(await User.exists({email}))return res.status(409).json({error:'Email already registered'});
 const user=await User.create({name,email,passwordHash:await bcrypt.hash(password,12),role:'student',status:'active'});
 return res.status(201).json({token:tokenFor(user),user:publicUser(user)});
 }catch(e){if(e.code===11000)return res.status(409).json({error:'Email already registered'});if(e.name==='ValidationError')return res.status(400).json({error:'Registration data failed validation'});console.error(e);return res.status(500).json({error:'Could not register account'});}});
router.post('/login',limit,async(req,res)=>{try{
 const email=typeof req.body.email==='string'?req.body.email.trim().toLowerCase():'',pass=typeof req.body.password==='string'?req.body.password:'';
 const user=await User.findOne({email}).select('+passwordHash +tokenVersion');
 if(!user||user.status!=='active'||!(await bcrypt.compare(pass,user.passwordHash)))return res.status(401).json({error:'Invalid email or password'});
 res.json({token:tokenFor(user),user:publicUser(user)});
 }catch(e){console.error(e);res.status(500).json({error:'Could not sign in'});}});
router.get('/me',auth,async(req,res)=>{const u=await User.findById(req.user.id);if(!u)return res.status(401).json({error:'Session unavailable'});res.json({user:publicUser(u)});});
router.post('/logout',auth,async(req,res)=>{await User.updateOne({_id:req.user.id},{$inc:{tokenVersion:1}});res.json({ok:true});});
router.post('/bootstrap-admin',limit,async(req,res)=>{try{
 const key=process.env.BOOTSTRAP_ADMIN_KEY;if(!key)return res.status(404).json({error:'Not enabled'});
 const given=typeof req.body.bootstrapKey==='string'?req.body.bootstrapKey:'',a=Buffer.from(key),b=Buffer.from(given);
 if(a.length!==b.length||!timingSafeEqual(a,b))return res.status(403).json({error:'Forbidden'});
 if(await User.exists({role:'admin'}))return res.status(409).json({error:'An administrator already exists'});
 const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=req.body.password;
 if(name.length<2||name.length>80||!validEmail(email)||!validPassword(password))return res.status(400).json({error:'Provide valid name, email and strong password'});
 const user=await User.create({name,email,passwordHash:await bcrypt.hash(password,12),role:'admin'});
 res.status(201).json({token:tokenFor(user),user:publicUser(user)});
 }catch(e){if(e.code===11000)return res.status(409).json({error:'Email already registered'});console.error(e);res.status(500).json({error:'Bootstrap failed'});}});
router.get('/admin/users',auth,roles('admin'),async(req,res)=>{const page=Math.max(1,Math.min(10000,Number(req.query.page)||1)),limitN=Math.max(1,Math.min(100,Number(req.query.limit)||25)),filter={};if(['student','instructor','admin'].includes(req.query.role))filter.role=req.query.role;if(['active','disabled'].includes(req.query.status))filter.status=req.query.status;const [users,total]=await Promise.all([User.find(filter).sort({createdAt:-1}).skip((page-1)*limitN).limit(limitN),User.countDocuments(filter)]);res.json({users:users.map(publicUser),page,limit:limitN,total});});
router.patch('/admin/users/:id',auth,roles('admin'),async(req,res)=>{try{const {role,status}=req.body;if(role!==undefined&&!['student','instructor','admin'].includes(role))return res.status(400).json({error:'Invalid role'});if(status!==undefined&&!['active','disabled'].includes(status))return res.status(400).json({error:'Invalid account status'});if(role===undefined&&status===undefined)return res.status(400).json({error:'No changes supplied'});const user=await User.findById(req.params.id);if(!user)return res.sendStatus(404);if(user.id===req.user.id&&(status==='disabled'||(role&&role!=='admin')))return res.status(400).json({error:'You cannot disable or demote your own admin account'});if(role)user.role=role;if(status)user.status=status;user.tokenVersion+=1;await user.save();res.json({user:publicUser(user)});}catch(e){if(e.name==='CastError')return res.status(400).json({error:'Invalid user id'});res.status(500).json({error:'Could not update account'});}});
export default router;
