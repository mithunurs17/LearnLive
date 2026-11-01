import React,{useEffect,useLayoutEffect,useRef,useState}from'react';import{Link,Navigate,useNavigate,useLocation}from'react-router-dom';import Live from './pages/Live';import Analytics from './pages/Analytics';import Studio from './pages/Studio';import StudentLearning from './components/StudentLearning';import Verify from './pages/Verify';import{useDispatch,useSelector}from'react-redux';import{api,checkoutCourse}from'./api';import PaymentHistory from'./components/PaymentHistory';import{setUser,logout}from'./store';
export default function App(){const user=useSelector(s=>s.auth.user);const dispatch=useDispatch();const nav=useNavigate();const location=useLocation();const[courses,setCourses]=useState([]);const[err,setErr]=useState('');const[refreshing,setRefreshing]=useState(false);const[enrolledCourseIds,setEnrolledCourseIds]=useState(new Set());const[enrollTick,setEnrollTick]=useState(0);const[authMode,setAuthMode]=useState('login');const[showPassword,setShowPassword]=useState(false);const[form,setForm]=useState({name:'',email:'',password:'',role:'student'});const[title,setTitle]=useState('');const[desc,setDesc]=useState('');const[price,setPrice]=useState('0');const[lessonTitle,setLessonTitle]=useState('');const[lessonUrl,setLessonUrl]=useState('');
async function load(){try{setCourses((await api.get('/courses')).data)}catch(e){toast(e.response?.data?.error||e.message,'error')}}
useEffect(()=>{load();if(localStorage.getItem('ll-token'))api.get('/auth/me').then(r=>dispatch(setUser(r.data.user))).catch(()=>dispatch(logout()))},[]);
useEffect(()=>{if(!user||user.role!=='student'){setEnrolledCourseIds(new Set());return;}let live=true;api.get('/me/enrollments').then(r=>{if(live)setEnrolledCourseIds(new Set((r.data||[]).map(e=>String(e.course?._id||e.course))))}).catch(()=>{});return()=>{live=false}},[user?.id,user?.role,enrollTick]);
useEffect(()=>{const bump=()=>setEnrollTick(t=>t+1);window.addEventListener('learnlive:enrollments-updated',bump);return()=>window.removeEventListener('learnlive:enrollments-updated',bump)},[]);
useEffect(()=>{if(!location.hash)return;const id=decodeURIComponent(location.hash.slice(1));const t=setTimeout(()=>document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'}),60);return()=>clearTimeout(t)},[location.pathname,location.hash]);
async function signOut(){try{await api.post('/auth/logout')}catch{}dispatch(logout());toast('Signed out.','success')}
async function authenticate(e,mode){e.preventDefault();try{const r=await api.post(`/auth/${mode==='login'?'login':'register'}`,form);localStorage.setItem('ll-token',r.data.token);dispatch(setUser(r.data.user));toast(mode==='login'?'Signed in successfully.':'Account created successfully.','success');setForm({name:'',email:'',password:'',role:'student'});setShowPassword(false);nav('/')}catch(e){toast(e.response?.data?.error||e.message,'error')}}
async function createCourse(e){e.preventDefault();try{await api.post('/courses',{title,description:desc,pricePaise:Number(price),published:true,lessons:lessonTitle?[{title:lessonTitle,videoUrl:lessonUrl,order:0}]:[]});setTitle('');setDesc('');setLessonTitle('');setLessonUrl('');load();toast('Course published.','success')}catch(e){toast(e.response?.data?.error||e.message,'error')}}
const isAuthPage=location.pathname==='/login'||location.pathname==='/signup';
if(isAuthPage&&user)return <Navigate to="/" replace/>;
if(isAuthPage){const mode=location.pathname==='/login'?'login':'signup';return <><ToastHost/><AuthPage mode={mode} form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} onSubmit={e=>authenticate(e,mode==='login'?'login':'register')}/></>}
const solidNav=<SiteNav solid user={user} onLogout={signOut}/>;
if(location.pathname.startsWith('/verify/'))return <><ToastHost/>{solidNav}<Verify certId={decodeURIComponent(location.pathname.split('/')[2]||'')}/></>;
if(location.pathname==='/live')return <><ToastHost/>{solidNav}<Live/></>;
const isTeacher=['instructor','admin'].includes(user?.role);const denied=<main className="shell"><p className="notice">This area is for instructor accounts.</p></main>;
if(location.pathname==='/analytics')return <><ToastHost/>{solidNav}{isTeacher?<Analytics/>:denied}</>;
if(location.pathname==='/studio')return <><ToastHost/>{solidNav}{isTeacher?<Studio/>:denied}</>;
return <div className="home"><ToastHost/><Hero user={user} onLogout={signOut}/><div className="shell"><main>{user?.role==='admin'&&<section className="panel"><h2>Account administration</h2><AdminUsers/></section>}
{user&&<section id="space" className="panel"><h2>{user.role==='student'?'Your learning space':'Instructor dashboard'}</h2>{user.role==='student'&&<StudentLearning key={user.id+':'+enrollTick}/>}{user.role==='student'&&<PaymentHistory/>}<div className="tiles"><Link to="/live" className="tile"><b>◉ Live classes</b><span>{user.role==='student'?'Join a hosted session':'Host a live session'}</span></Link>{isTeacher&&<Link to="/studio" className="tile"><b>＋ Instructor studio</b><span>Create and publish a course</span></Link>}{isTeacher&&<Link to="/analytics" className="tile"><b>↗ Earnings & analytics</b><span>Enrollment and paid sales overview</span></Link>}</div></section>}
<section id="catalog"><div className="sectionHead"><div><span className="eyebrow">THE CATALOG</span><h2>Find your next skill.</h2></div><div className="catalogTools"><span>{courses.length} courses</span><button className="small" disabled={refreshing} onClick={async()=>{setRefreshing(true);await load();setRefreshing(false);toast('Course list updated.','success')}}>{refreshing?'Refreshing…':'↻ Refresh'}</button></div></div><div className="courseGrid">{courses.map(c=><article className="course" key={c._id}><div className="courseArt"><span>{(c.category||'LEARN').toUpperCase()}</span><b>0{String(c.title).length%9+1}</b></div><div className="courseBody"><small>{c.instructor?.name||'LearnLive instructor'}</small><h3>{c.title}</h3><p>{c.description||'Build practical skills with guided lessons.'}</p><div className="courseFoot"><b>{c.pricePaise?`₹${(c.pricePaise/100).toFixed(0)}`:'Free'}</b>{(!user||user.role==='student')&&<button disabled={enrolledCourseIds.has(String(c._id))} onClick={async()=>{if(!user){nav('/login');return}if(enrolledCourseIds.has(String(c._id))){toast('You are already enrolled in this course.','info');return}try{if(c.pricePaise){await checkoutCourse(c,user);setEnrolledCourseIds(prev=>new Set([...prev,String(c._id)]));toast('Payment successful! Find this course in your learning space.','success');window.dispatchEvent(new CustomEvent('learnlive:enrollments-updated'))}else{await api.post(`/courses/${c._id}/enroll`);setEnrolledCourseIds(prev=>new Set([...prev,String(c._id)]));toast('Enrolled successfully! Find this course in your learning space.','success');window.dispatchEvent(new CustomEvent('learnlive:enrollments-updated'))}}catch(e){if(e.cancelled){toast('Payment cancelled. You have not been charged.','info');return}if(e.pending){toast(e.message,'info');return}if(e.response?.status===409){setEnrolledCourseIds(prev=>new Set([...prev,String(c._id)]));toast('You are already enrolled in this course.','info')}else toast(e.response?.data?.error||e.message,'error')}}}>{enrolledCourseIds.has(String(c._id))?'✓ Enrolled':c.pricePaise?'Enroll / Pay ↗':'Enroll ↗'}</button>}</div></div></article>)}</div>{!courses.length&&<div className="empty">Your course library starts here. Instructor accounts can publish the first course.</div>}</section></main><footer><b>LearnLive</b><span>Built for your next chapter.</span></footer></div></div>}
function AdminUsers(){const [users,setUsers]=useState([]),[msg,setMsg]=useState('');async function refresh(){try{const r=await api.get('/auth/admin/users?limit=50');setUsers(r.data.users)}catch(e){setMsg(e.response?.data?.error||e.message)}}useEffect(()=>{refresh()},[]);async function update(id,change){try{await api.patch(`/auth/admin/users/${id}`,change);setMsg('Account updated. Their previous sessions have been revoked.');refresh()}catch(e){setMsg(e.response?.data?.error||e.message)}}return <div className="adminUsers">{msg&&<p className="notice">{msg}</p>}{users.map(u=><div className="adminRow" key={u.id}><div><b>{u.name}</b><p>{u.email}</p><small>{u.role} · {u.status}</small></div><div className="lessonActions"><select aria-label={"Role for "+u.email} value={u.role} onChange={e=>update(u.id,{role:e.target.value})}><option value="student">Student</option><option value="instructor">Instructor</option><option value="admin">Admin</option></select><button className="small" onClick={()=>update(u.id,{status:u.status==='active'?'disabled':'active'})}>{u.status==='active'?'Disable':'Enable'}</button></div></div>)}</div>}


let toastCounter=0;
function toast(message,type='info'){
  window.dispatchEvent(new CustomEvent('learnlive:toast',{detail:{id:++toastCounter,message:String(message||''),type}}));
}
function ToastHost(){
 const [items,setItems]=useState([]);
 useEffect(()=>{const onToast=e=>{const item=e.detail;setItems(prev=>[...prev.filter(x=>x.id!==item.id),item].slice(-4));window.setTimeout(()=>setItems(prev=>prev.filter(x=>x.id!==item.id)),4600)};window.addEventListener('learnlive:toast',onToast);return()=>window.removeEventListener('learnlive:toast',onToast)},[]);
 return <div className="toastViewport" aria-live="polite" aria-atomic="false">{items.map(item=><div key={item.id} className={`toastItem toast-${item.type}`} role={item.type==='error'?'alert':'status'}><span className="toastIcon">{item.type==='error'?'!':item.type==='success'?'✓':'i'}</span><p>{item.message}</p><button type="button" aria-label="Dismiss notification" onClick={()=>setItems(prev=>prev.filter(x=>x.id!==item.id))}>×</button></div>)}</div>
}


/* ================= Synthora-style shell components ================= */
const GLOW_VIDEO='https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/6ad9485f-ab40-444b-bd3c-40dcb9bd0e2f.mp4';
const reducedMotion=()=>typeof window!=='undefined'&&!!window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Mark(){return <svg viewBox="0 0 40 40" aria-hidden="true"><defs><mask id="llMark"><rect width="40" height="40" fill="#fff"/><path d="M20 8c.9 6.6 5.4 11.1 12 12-6.6.9-11.1 5.4-12 12-.9-6.6-5.4-11.1-12-12 6.6-.9 11.1-5.4 12-12z" fill="#000"/></mask></defs><circle cx="20" cy="20" r="20" fill="#fff" mask="url(#llMark)"/></svg>}
function UserIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>}
function PlayIcon(){return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 001.5.86l10.5-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z"/></svg>}
function SunIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.6" fill="#FAD53E"/><g stroke="#FAD53E" strokeWidth="2" strokeLinecap="round"><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3L7 7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7"/></g></svg>}

/* one Web Animations sequence for everything marked data-a (skipped for reduced motion) */
function useEntrance(ref){
  useLayoutEffect(()=>{
    const root=ref.current;if(!root||reducedMotion())return;
    const ease='cubic-bezier(.2,.8,.15,1)';const anims=[];
    root.querySelectorAll('[data-a]').forEach(el=>{
      const kind=el.dataset.a,delay=Number(el.dataset.d||0)*1000;let frames,dur=1000;
      if(kind==='fade'){frames=[{opacity:0},{opacity:1}];dur=800}
      else if(kind==='badge'){frames=[{opacity:0,clipPath:'inset(0 50% 0 50% round 999px)'},{opacity:1,clipPath:'inset(0 0% 0 0% round 999px)'}];dur=900}
      else if(kind==='line'){frames=[{transform:'translateY(110%)'},{transform:'none'}];dur=1000}
      else{frames=[{opacity:0,transform:'translateY(18px)'},{opacity:1,transform:'none'}]}
      anims.push(el.animate(frames,{duration:dur,delay,easing:ease,fill:'backwards'}));
    });
    return()=>anims.forEach(a=>a.cancel());
  },[]);
}

/* muted 4s loop laid over the glow plate; last second crossfades into the first */
function GlowVideo(){
  const wrap=useRef(null),a=useRef(null),b=useRef(null);
  useEffect(()=>{
    const A=a.current,B=b.current,W=wrap.current;if(!A||!B||!W)return;
    A.muted=true;B.muted=true;
    let cur=A,nxt=B,raf=0;
    A.addEventListener('loadeddata',()=>W.classList.add('on'),{once:true});
    A.play().catch(()=>{});
    const tick=()=>{
      const d=cur.duration;
      if(d&&isFinite(d)){
        const left=d-cur.currentTime;
        if(left<=1){
          if(nxt.paused){nxt.currentTime=0;nxt.style.zIndex='2';cur.style.zIndex='1';nxt.play().catch(()=>{})}
          nxt.style.opacity=String(Math.min(1,Math.max(0,1-left)));
          if(left<=.04||cur.ended){cur.pause();cur.style.opacity='0';nxt.style.opacity='1';const t=cur;cur=nxt;nxt=t}
        }
      }
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(raf);
  },[]);
  return <div className="gvWrap" ref={wrap}><video ref={a} className="gv" src={GLOW_VIDEO} muted playsInline preload="auto" style={{opacity:1,zIndex:1}}/><video ref={b} className="gv" src={GLOW_VIDEO} muted playsInline preload="auto" style={{opacity:0,zIndex:2}}/></div>
}
function Glow(){return <div className="glow" aria-hidden="true">{!reducedMotion()&&<GlowVideo/>}</div>}

function SiteNav({user,onLogout,solid}){
  const[open,setOpen]=useState(false);
  const teacher=['instructor','admin'].includes(user?.role);
  const links=[['Start','/'],['Courses','/#catalog'],['Live classes','/live']];
  if(user&&!teacher)links.push(['My space','/#space']);
  if(teacher)links.push(['Studio','/studio'],['Analytics','/analytics']);
  const close=()=>setOpen(false);
  return <nav className={'sxNav'+(solid?' sxNav--solid':'')}>
    <Link to="/" className="sxBrand" data-a="fade" onClick={close}><Mark/>LearnLive</Link>
    <div className="sxLinks" data-a="fade" data-d="0.1">{links.map(([t,h])=><Link key={t} to={h}>{t}</Link>)}</div>
    <div className="sxRight" data-a="fade" data-d="0.2">
      {user?<><span className="sxUser">{user.name}</span><button type="button" className="sxOut" onClick={onLogout}>Sign out</button></>:<Link to="/login" className="sxLogin"><UserIcon/>Log in</Link>}
      <button type="button" className="sxBurger" aria-label="Menu" aria-expanded={open} onClick={()=>setOpen(o=>!o)}><i/><i/></button>
    </div>
    {open&&<div className="sxMenu">{links.map(([t,h])=><Link key={t} to={h} onClick={close}>{t}</Link>)}{user?<button type="button" onClick={()=>{close();onLogout()}}>Sign out ({user.name})</button>:<><Link to="/login" onClick={close}>Log in</Link><Link to="/signup" onClick={close}>Sign up</Link></>}</div>}
  </nav>
}

function Hero({user,onLogout}){
  const ref=useRef(null);useEntrance(ref);
  return <section className="sx" id="top" ref={ref}>
    <SiteNav user={user} onLogout={onLogout}/>
    <Glow/>
    <div className="sxMain">
      <div className="sxBadge" data-a="badge" data-d="0.15"><b>New</b><span>Live classes are here</span><SunIcon/></div>
      <h1 className="sxH1"><span className="sxLine"><span data-a="line" data-d="0.45">Empowering careers with</span></span><span className="sxLine"><span data-a="line" data-d="0.58">practical live learning</span></span></h1>
      <p className="sxSub" data-a="rise" data-d="0.95">Expert-led courses, live classes, quizzes and certificates — all in one place,{' '}<br/>built for your next chapter.</p>
      <div className="sxBtns">
        {user?<Link to="/live" className="btnStart" data-a="rise" data-d="1.15">Live Classes</Link>:<Link to="/signup" className="btnStart" data-a="rise" data-d="1.15">Start Free</Link>}
        <a href="#catalog" className="btnDemo" data-a="rise" data-d="1.28"><PlayIcon/>Browse Courses</a>
      </div>
    </div>
  </section>
}

function AuthPage({mode,form,setForm,showPassword,setShowPassword,onSubmit}){
  const ref=useRef(null);useEntrance(ref);
  const login=mode==='login';
  return <section className="sx sx--auth" ref={ref}>
    <SiteNav user={null}/>
    <Glow/>
    <div className="authCard" data-a="rise" data-d="0.3">
      <h1>{login?'Welcome back':'Create your account'}</h1>
      <p className="authLead">{login?'Log in to continue your courses and live classes.':'Join LearnLive and start learning today.'}</p>
      <form onSubmit={onSubmit} className="formGrid accountForm">
        {!login&&<input placeholder="Full name" required autoComplete="name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>}
        <input type="email" placeholder="Email" required autoComplete="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/>
        <div className="passwordField"><input type={showPassword?"text":"password"} autoComplete={login?"current-password":"new-password"} minLength={login?undefined:12} placeholder={login?"Password":"Password (12+ chars, upper/lowercase + number)"} required value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><button className="passwordToggle" type="button" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?"Hide password":"Show password"} aria-pressed={showPassword} title={showPassword?"Hide password":"Show password"}><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{showPassword?<><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0112 5c5.5 0 9 7 9 7a15.8 15.8 0 01-3.1 3.8"/><path d="M6.2 6.2C3.9 7.8 3 12 3 12s3.5 7 9 7c1 0 1.9-.2 2.8-.6"/></>:<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>}</svg></button></div>
        {!login&&<p className="muted">New accounts start as students. Instructors are assigned by an administrator.</p>}
        <button className="primary">{login?'Log in':'Sign up'}</button>
      </form>
      <p className="authSwitch">{login?<>New here? <Link to="/signup">Create an account</Link></>:<>Already registered? <Link to="/login">Log in</Link></>}</p>
    </div>
  </section>
}
