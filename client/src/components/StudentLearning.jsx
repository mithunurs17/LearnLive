import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

export default function StudentLearning(){
  const [items,setItems]=useState([]),[selectedId,setSelectedId]=useState(''),[lessonIndex,setLessonIndex]=useState(0);
  const [quizIndex,setQuizIndex]=useState(0),[answers,setAnswers]=useState({}),[result,setResult]=useState(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const videoRef=useRef(null);
  const [cs,setCs]=useState(null);
  async function refresh(preferred){
    setLoading(true);setError('');
    try{const r=await api.get('/learning/enrollments');const rows=r.data.enrollments||[];setItems(rows);const next=preferred||selectedId;setSelectedId(rows.some(x=>x.id===next)?next:(rows[0]?.id||''));}
    catch(e){setError(e.response?.data?.error||'Could not load your learning dashboard.');}
    finally{setLoading(false);}
  }
  useEffect(()=>{refresh('')},[]);
  const enrollment=items.find(x=>x.id===selectedId)||null;
  const course=enrollment?.course;
  const lessons=course?.lessons||[];
  const lesson=lessons[lessonIndex]||null;
  const quizzes=course?.quizzes||[];
  const quiz=quizzes[quizIndex]||null;
  const progress=lessons.length?Math.min(100,Math.round((enrollment.completedLessons.length/lessons.length)*100)):0;
  const attempts=useMemo(()=>enrollment?.quizScores||[],[enrollment]);
  useEffect(()=>{
    const video=videoRef.current;const source=lesson?.videoUrl;if(!video||!source||!source.toLowerCase().includes('.m3u8'))return;
    let hls;let disposed=false;
    if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=source;return ()=>{video.removeAttribute('src');video.load();};}
    import('hls.js').then(({default:Hls})=>{if(disposed)return;if(Hls.isSupported()){hls=new Hls({enableWorker:true});hls.loadSource(source);hls.attachMedia(video);}else{setError('HLS playback is not supported in this browser. Try a current Chrome, Edge, Firefox or Safari version.');}}).catch(()=>setError('Unable to initialize HLS playback.'));
    return ()=>{disposed=true;hls?.destroy();};
  },[lesson?.videoUrl,lesson?._id]);
  function selectCourse(id){setSelectedId(id);setLessonIndex(0);setQuizIndex(0);setAnswers({});setResult(null);setMessage('');}
  async function completeLesson(){if(!enrollment)return;setBusy(true);setMessage('');setError('');try{await api.post(`/learning/enrollments/${enrollment.id}/lessons/${lessonIndex}/complete`);setMessage('Lesson progress saved.');await refresh(enrollment.id);}catch(e){setError(e.response?.data?.error||'Could not save progress.');}finally{setBusy(false)}}
  async function submitQuiz(e){e.preventDefault();if(!enrollment||!quiz)return;setBusy(true);setError('');setMessage('');setResult(null);try{const payload=quiz.questions.map((_,i)=>answers[i]===undefined?null:Number(answers[i]));const r=await api.post(`/learning/enrollments/${enrollment.id}/quizzes/${quizIndex}/submit`,{answers:payload});setResult(r.data);setMessage(`Attempt ${r.data.attemptNumber} recorded.`);await refresh(enrollment.id);}catch(e){setError(e.response?.data?.error||'Quiz submission failed.');}finally{setBusy(false)}}
  useEffect(()=>{if(!selectedId){setCs(null);return;}let live=true;api.get(`/enrollments/${selectedId}/certificate/status`).then(r=>{if(live)setCs(r.data)}).catch(()=>{if(live)setCs(null)});return()=>{live=false};},[selectedId,items]);
  async function certificate(){try{const r=await api.get(`/enrollments/${enrollment.id}/certificate`,{responseType:'blob'});const url=URL.createObjectURL(r.data);const a=document.createElement('a');a.href=url;a.download='LearnLive-Certificate.pdf';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){let msg='Certificate could not be downloaded.';try{const t=await e.response?.data?.text?.();if(t)msg=JSON.parse(t).error||msg}catch{}setError(msg)}}
  if(loading)return <section className="panel learningPanel"><p className="muted">Loading your learning space…</p></section>;
  return <section className="learningPanel">
    <div className="learningHeader"><div><span className="eyebrow">YOUR CLASSROOM</span><h2>Pick up where you left off.</h2><p className="muted">Lessons, quizzes and progress in one learning space.</p></div><button className="small" onClick={()=>refresh(enrollment?.id)}>Refresh</button></div>
    {error&&<p className="learningAlert error" role="alert">{error}</p>}{message&&<p className="learningAlert" role="status">{message}</p>}
    {!items.length?<div className="learningEmpty"><h3>Your classroom is waiting.</h3><p>Enroll in a course from the catalog to start learning.</p></div>:<>
      <div className="learningCoursePicker" role="tablist" aria-label="Enrolled courses">{items.map(item=><button role="tab" aria-selected={selectedId===item.id} className={`learningCourseTab ${selectedId===item.id?'active':''}`} key={item.id} onClick={()=>selectCourse(item.id)}><b>{item.course.title}</b><span>{item.completedLessons.length}/{item.course.lessons.length} lessons</span></button>)}</div>
      {course&&<>
        <div className="learningCourseMeta"><div><span className="eyebrow">COURSE</span><h3>{course.title}</h3><p>{course.description}</p><small>Instructor · {course.instructor?.name||'LearnLive instructor'}</small></div><div className="learningProgressCard"><strong>{progress}%</strong><span>Course progress</span><div className="progress"><i style={{width:`${progress}%`}}/></div><small>{enrollment.completedLessons.length} of {lessons.length} lessons completed</small></div></div>
        <div className="learningWorkspace"><aside className="learningSidebar"><div className="learningSectionTitle"><h3>Course lessons</h3><span>{lessons.length}</span></div>{lessons.map((l,i)=><button key={l._id||i} className={`learningLessonItem ${lessonIndex===i?'active':''}`} onClick={()=>{setLessonIndex(i);setResult(null);setMessage('');}}><span className="lessonNumber">{enrollment.completedLessons.includes(i)?'✓':String(i+1).padStart(2,'0')}</span><span><b>{l.title||`Lesson ${i+1}`}</b><small>{l.durationSec?`${Math.ceil(l.durationSec/60)} min`:'Video lesson'}</small></span></button>)}{!lessons.length&&<p className="muted">No lessons have been added yet.</p>}
          <div className="learningSectionTitle quizSectionTitle"><h3>Quizzes</h3><span>{quizzes.length}</span></div>{quizzes.map((q,i)=>{const n=attempts.filter(a=>a.quizIndex===i).length;return <button key={i} className={`learningQuizItem ${quizIndex===i?'active':''}`} onClick={()=>{setQuizIndex(i);setAnswers({});setResult(null);setMessage('');}}><span>✳</span><span><b>{q.title||`Quiz ${i+1}`}</b><small>{q.questions.length} questions · {n} attempt{n===1?'':'s'}</small></span></button>})}{!quizzes.length&&<p className="muted quizEmpty">No quizzes in this course.</p>}</aside>
          <div className="learningContent">
            {lesson&&<article className="lessonViewer"><div className="lessonViewTop"><span className="eyebrow">LESSON {lessonIndex+1} OF {lessons.length}</span>{enrollment.completedLessons.includes(lessonIndex)&&<span className="learningCompleteTag">✓ Completed</span>}</div><h3>{lesson.title}</h3>{lesson.description&&<p className="lessonDescription">{lesson.description}</p>}{lesson.videoUrl?<video ref={videoRef} className="learningVideo" controls playsInline preload="metadata" src={lesson.videoUrl.toLowerCase().includes('.m3u8')?undefined:lesson.videoUrl} aria-label={lesson.title}/>:(<div className="learningNoVideo"><span>▻</span><b>Video is not available yet</b><small>The instructor may still be preparing this lesson.</small></div>)}<div className="lessonViewerFooter"><span className="muted">Take your time. Mark this lesson complete when you're done.</span><button className="primary" disabled={busy||enrollment.completedLessons.includes(lessonIndex)} onClick={completeLesson}>{enrollment.completedLessons.includes(lessonIndex)?'✓ Completed':busy?'Saving…':'Mark lesson complete'}</button></div><div className="lessonNavigation"><button className="small" disabled={lessonIndex===0} onClick={()=>setLessonIndex(v=>Math.max(0,v-1))}>← Previous lesson</button><button className="small" disabled={lessonIndex>=lessons.length-1} onClick={()=>setLessonIndex(v=>Math.min(lessons.length-1,v+1))}>Next lesson →</button></div></article>}
            {quiz&&<article className="quizViewer"><div className="lessonViewTop"><span className="eyebrow">KNOWLEDGE CHECK · QUIZ {quizIndex+1}</span><span className="learningCompleteTag">{quiz.questions.length} questions</span></div><h3>{quiz.title}</h3><p className="muted">Choose one answer for each question. Your score is calculated securely.</p><form onSubmit={submitQuiz} className="learningQuizForm">{quiz.questions.map((q,i)=><fieldset className="learningQuestion" key={i}><legend><b>{i+1}. {q.prompt}</b><span>{q.points} pt{q.points===1?'':'s'}</span></legend><div className="learningOptions">{q.options.map((option,j)=><label key={j} className={`learningOption ${answers[i]===j?'chosen':''}`}><input type="radio" name={`q-${quizIndex}-${i}`} value={j} checked={answers[i]===j} disabled={!!result} onChange={()=>setAnswers(old=>({...old,[i]:j}))}/><span>{option}</span></label>)}</div>{result&&<div className={`questionFeedback ${result.review[i]?.correct?'correct':'incorrect'}`}>{result.review[i]?.correct?'Correct answer.':`Review: correct option — ${q.options[result.review[i]?.correctIndex]}`}</div>}</fieldset>)}{!result?<button className="primary" disabled={busy||Object.keys(answers).length!==quiz.questions.length}>{busy?'Submitting…':'Submit quiz'}</button>:<div className="quizResult"><div><span className="eyebrow">YOUR RESULT</span><strong>{result.percent}%</strong><p>{result.score} / {result.maxScore} points · {result.passed?'Passed':'Keep practicing'}</p><small>Attempt {result.attemptNumber}</small></div><button className="primary" onClick={()=>{setAnswers({});setResult(null);setMessage('');}}>Try again</button></div>}</form><div className="quizHistory"><b>Previous attempts</b>{attempts.filter(a=>a.quizIndex===quizIndex).length?attempts.filter(a=>a.quizIndex===quizIndex).map((a,i)=><span key={i}>Attempt {i+1}: {Math.round(a.score/Math.max(1,a.maxScore)*100)}% · {a.score}/{a.maxScore}</span>):<small>No attempts yet.</small>}</div></article>}
            {!lesson&&!quiz&&<div className="learningEmpty"><h3>You're ready to learn.</h3><p>This course doesn't have lesson content yet.</p></div>}
          </div>
        </div>
        <div className={`learningCertificate ${cs?.eligible?'ready':''}`}><div>{cs?.eligible?<><b>Course completed 🎉</b><p>All lessons and quizzes are done. Your certificate is ready{cs.certificate?` · ID ${cs.certificate.certificateId}`:''}.</p></>:<><b>Certificate of Completion</b><p>Finish these to unlock your certificate:</p><ul className="certMissing">{(cs?.missing||['Checking your progress…']).map((m,i)=><li key={i}>{m}</li>)}</ul></>}</div><button className="primary" disabled={!cs?.eligible} onClick={certificate}>Download certificate</button></div>
      </>}
    </>}
  </section>;
}
