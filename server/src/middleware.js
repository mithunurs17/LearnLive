import jwt from 'jsonwebtoken';
import {User} from './models.js';
export async function auth(req,res,next){
 try{
  const header=req.headers.authorization||'';
  if(!/^Bearer\s+\S+$/i.test(header))return res.status(401).json({error:'Authentication required'});
  const claims=jwt.verify(header.replace(/^Bearer\s+/i,''),process.env.JWT_SECRET,{issuer:'learnlive-api',audience:'learnlive-client'});
  const user=await User.findById(claims.sub).select('+tokenVersion');
  if(!user||user.status!=='active'||user.tokenVersion!==claims.ver)return res.status(401).json({error:'Session expired or account unavailable. Sign in again.'});
  req.user={id:user.id,role:user.role,name:user.name,email:user.email};next();
 }catch{return res.status(401).json({error:'Invalid or expired session'});}
}
export const roles=(...allowed)=>(req,res,next)=>allowed.includes(req.user?.role)?next():res.status(403).json({error:'Insufficient permissions'});
