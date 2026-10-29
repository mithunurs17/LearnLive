import mongoose from 'mongoose';
const {Schema,model}=mongoose;
const userSchema=new Schema({
 name:{type:String,required:true,trim:true,minlength:2,maxlength:80},
 email:{type:String,required:true,unique:true,lowercase:true,trim:true,maxlength:254,match:/^[^\s@]+@[^\s@]+\.[^\s@]+$/},
 passwordHash:{type:String,required:true,select:false},
 role:{type:String,enum:['student','instructor','admin'],default:'student',required:true},
 status:{type:String,enum:['active','disabled'],default:'active',required:true},
 tokenVersion:{type:Number,default:0,select:false},
 createdAt:{type:Date,default:Date.now}
},{timestamps:true,versionKey:false});
userSchema.index({email:1},{unique:true});
export const User=model('User',userSchema);
export const Course=model('Course',new Schema({title:{type:String,required:true,trim:true,minlength:3,maxlength:180},description:{type:String,maxlength:10000},category:{type:String,maxlength:100},pricePaise:{type:Number,default:0,min:0,validate:Number.isSafeInteger},instructor:{type:Schema.Types.ObjectId,ref:'User',required:true},published:{type:Boolean,default:false},lessons:[{title:{type:String,trim:true,maxlength:180},description:{type:String,maxlength:4000},videoUrl:{type:String,maxlength:2048},durationSec:{type:Number,min:0},order:{type:Number,min:0}}],quizzes:[{title:String,questions:[{prompt:String,options:[String],correctIndex:{type:Number,min:0},points:{type:Number,default:1,min:1}}]}],createdAt:{type:Date,default:Date.now}}));
export const Enrollment=model('Enrollment',new Schema({student:{type:Schema.Types.ObjectId,ref:'User',required:true},course:{type:Schema.Types.ObjectId,ref:'Course',required:true},completedLessons:[Number],quizScores:[{quizIndex:Number,score:Number,maxScore:Number}],completedAt:Date,createdAt:{type:Date,default:Date.now}},{timestamps:true}));
Enrollment.schema.index({student:1,course:1},{unique:true});
export const Payment=model('Payment',new Schema({student:{type:Schema.Types.ObjectId,ref:'User'},course:{type:Schema.Types.ObjectId,ref:'Course'},providerOrderId:{type:String,unique:true},paymentId:String,amount:Number,status:{type:String,enum:['created','paid','failed'],default:'created'},createdAt:{type:Date,default:Date.now}}));
