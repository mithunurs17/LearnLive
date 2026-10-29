import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import Hls from 'hls.js';
import Live from './pages/Live';
import Analytics from './pages/Analytics';
import Studio from './pages/Studio';
import { api } from './api';
import { setUser, logout } from './store';

let toastSequence = 0;
function showToast(message, type) {
  const text = String(message || '').trim();
  if (!text) return;
  const inferred = type || (/success|enrolled|signed in|signed out/i.test(text) ? 'success' : /checkout closed|cancelled|canceled/i.test(text) ? 'info' : 'error');
  window.dispatchEvent(new CustomEvent('learnlive:toast', { detail: { id: ++toastSequence, message: text, type: inferred } }));
}

export default function App() {
  const user = useSelector(s => s.auth.user);
  const dispatch = useDispatch();
  const location = useLocation();
  const [courses, setCourses] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [authMode, setAuthMode] = useState('login');
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'student' });
  const [enrollmentRefresh, setEnrollmentRefresh] = useState(0);

  useEffect(() => {
    const onToast = event => {
      const toast = event.detail;
      setToasts(current => [...current.filter(t => t.id !== toast.id), toast].slice(-4));
      window.setTimeout(() => setToasts(current => current.filter(t => t.id !== toast.id)), 4800);
    };
    window.addEventListener('learnlive:toast', onToast);
    return () => window.removeEventListener('learnlive:toast', onToast);
  }, []);

  // Public catalog endpoint returns published courses only. Refetch after
  // auth state changes, tab focus, and when the user presses Refresh.
  const loadCourses = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await api.get('/courses');
      if (!Array.isArray(response.data)) throw new Error('Unexpected course catalog response.');
      setCourses(response.data);
    } catch (e) {
      setCatalogError(e.response?.data?.error || e.message || 'Could not load courses.');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  // Restore the session on mount. Catalog is refreshed independently below.
  useEffect(() => {
    if (!localStorage.getItem('ll-token')) return;
    let active = true;
    api.get('/auth/me')
      .then(r => { if (active) dispatch(setUser(r.data.user)); })
      .catch(() => { if (active) dispatch(logout()); });
    return () => { active = false; };
  }, [dispatch]);

  // Refresh when sign-in/sign-out changes and whenever the app regains focus.
  useEffect(() => { loadCourses(); }, [loadCourses, user?.id, user?.role]);
  useEffect(() => {
    const onFocus = () => loadCourses();
    const onVisible = () => { if (document.visibilityState === 'visible') loadCourses(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadCourses]);

  async function authenticate(e) {
    e.preventDefault();
    try {
      const r = await api.post(`/auth/${authMode === 'login' ? 'login' : 'register'}`, form);
      localStorage.setItem('ll-token', r.data.token);
      dispatch(setUser(r.data.user));
      await loadCourses();
      showToast('Signed in successfully.', 'success');
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Authentication failed.', 'error');
    }
  }

  async function signOut() {
    try { await api.post('/auth/logout'); } catch { /* Local sign-out still proceeds. */ }
    dispatch(logout());
    showToast('Signed out.', 'success');
  }

  async function enroll(course) {
    if (!user) {
      document.querySelector('#account')?.scrollIntoView({ behavior: 'smooth' });
      showToast('Sign in or create a student account to enroll.', 'info');
      return;
    }
    if (user.role !== 'student') {
      showToast('Student accounts can enroll in courses.', 'info');
      return;
    }
    try {
      // Free courses can be enrolled directly.
      if (Number(course.pricePaise || 0) <= 0) {
        await api.post(`/courses/${course._id}/enroll`);
        setEnrollmentRefresh(v => v + 1);
        showToast(`Enrolled in “${course.title}”. Find it in Your learning space.`, 'success');
        return;
      }

      // Load Razorpay Checkout only when a student buys a paid course.
      if (!window.Razorpay) {
        await new Promise((resolve, reject) => {
          const existing = document.querySelector('script[data-razorpay-checkout]');
          if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            if (window.Razorpay) resolve();
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          script.async = true;
          script.dataset.razorpayCheckout = 'true';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Could not load Razorpay Checkout. Check your internet connection or content blockers.'));
          document.body.appendChild(script);
        });
      }
      if (!window.Razorpay) throw new Error('Razorpay Checkout did not initialize. Please retry.');

      const orderResponse = await api.post('/payments/order', { courseId: course._id });
      const { order, keyId, courseName } = orderResponse.data || {};
      if (!order?.id || !keyId) throw new Error('Payment order response is incomplete.');

      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        const checkout = new window.Razorpay({
          key: keyId,
          amount: order.amount,
          currency: order.currency || 'INR',
          name: 'LearnLive',
          description: courseName || course.title,
          order_id: order.id,
          prefill: { name: user.name || '', email: user.email || '' },
          theme: { color: '#6d28d9' },
          handler: async payment => {
            try {
              await api.post('/payments/verify', {
                razorpay_order_id: payment.razorpay_order_id,
                razorpay_payment_id: payment.razorpay_payment_id,
                razorpay_signature: payment.razorpay_signature
              });
              finish(resolve);
            } catch (verifyError) {
              finish(reject, new Error(verifyError.response?.data?.error || 'Payment verification failed. Contact support if money was deducted.'));
            }
          },
          modal: { ondismiss: () => finish(reject, new Error('Checkout closed before payment was completed.')) }
        });
        checkout.on('payment.failed', response => {
          finish(reject, new Error(response.error?.description || 'Payment failed. Please retry.'));
        });
        checkout.open();
      });

      setEnrollmentRefresh(v => v + 1);
      showToast(`Payment successful. You are enrolled in “${course.title}”. Find it in Your learning space.`, 'success');
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Enrollment failed.', 'error');
    }
  }

  if (location.pathname === '/live') return <><header className="shell"><Link to="/" className="brand">◈ LearnLive</Link><Link to="/">Home</Link></header><Live /></>;
  if (location.pathname === '/analytics') return <><header className="shell"><Link to="/" className="brand">◈ LearnLive</Link><Link to="/">Home</Link></header><Analytics /></>;
  if (location.pathname === '/studio') return <><header className="shell"><Link to="/" className="brand">◈ LearnLive</Link><Link to="/">Home</Link></header><Studio /></>;

  return <div className="shell">
    <header>
      <Link to="/" className="brand">◈ LearnLive</Link>
      <nav>
        <a href="#catalog">Explore</a>
        {user && <span>{user.name} · {user.role}</span>}
        {user ? <button className="ghost" onClick={signOut}>Sign out</button> : <a href="#account">Sign in</a>}
      </nav>
    </header>

    <main>
      <section className="hero">
        <div><span className="eyebrow">LEARN. BUILD. LEVEL UP.</span><h1>Skills that move<br /><em>you forward.</em></h1><p>Expert-led courses, live learning, quizzes, and certificates — all in one place.</p><a className="primary" href="#catalog">Browse courses ↗</a></div>
        <div className="heroCard"><div className="orb">✳</div><p>YOUR NEXT CHAPTER</p><h3>Curiosity → Capability</h3><div className="progress"><i /></div><small>Make learning a daily habit.</small></div>
      </section>


      {!user && <section id="account" className="panel">
        <h2>{authMode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
        <form onSubmit={authenticate} className="formGrid">
          {authMode === 'register' && <input placeholder="Full name" required minLength={2} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />}
          <input type="email" placeholder="Email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          <div className="passwordField" style={{ position: 'relative', width: '100%' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
              minLength={authMode === 'register' ? 12 : undefined}
              placeholder={authMode === 'register' ? 'Password (12+ chars, upper/lowercase + number)' : 'Password'}
              required
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              style={{ width: '100%', paddingRight: 48, boxSizing: 'border-box' }}
            />
            <button
              className="passwordToggle"
              type="button"
              onClick={() => setShowPassword(value => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
              style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 6 }}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {showPassword ? <>
                  <path d="M3 3l18 18" />
                  <path d="M10.6 10.6a2 2 0 002.8 2.8" />
                  <path d="M9.9 5.2A10.8 10.8 0 0112 5c5.5 0 9 7 9 7a15.8 15.8 0 01-3.1 3.8" />
                  <path d="M6.2 6.2C3.9 7.8 3 12 3 12s3.5 7 9 7c1 0 1.9-.2 2.8-.6" />
                </> : <>
                  <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                </>}
              </svg>
            </button>
          </div>
          {authMode === 'register' && <p className="muted">New accounts start as students. Instructors are assigned by an administrator.</p>}
          <button className="primary">{authMode === 'login' ? 'Sign in' : 'Register'}</button>
        </form>
        <button className="textBtn" onClick={() => { setShowPassword(false); setAuthMode(authMode === 'login' ? 'register' : 'login'); }}>{authMode === 'login' ? 'New here? Create an account' : 'Already registered? Sign in'}</button>
      </section>}

      {user?.role === 'admin' && <section className="panel"><h2>Account administration</h2><AdminUsers /></section>}

      {user?.role === 'student' && <section className="panel">
        <h2>Your learning space</h2>
        <Enrollments refreshToken={enrollmentRefresh} />
        <div className="tiles">
          <Link to="/live" className="tile"><b>◉ Live classes</b><span>Join a hosted session</span></Link>
        </div>
      </section>}

      {user && ['instructor', 'admin'].includes(user.role) && <section className="panel">
        <h2>{user.role === 'admin' ? 'Platform workspace' : 'Instructor workspace'}</h2>
        <p className="muted">Manage teaching, live sessions, learner enrollments and payment activity.</p>
        <div className="tiles">
          <Link to="/studio" className="tile"><b>＋ Instructor studio</b><span>Create and manage courses and lessons</span></Link>
          <Link to="/live" className="tile"><b>◉ Live classes</b><span>Schedule or manage hosted sessions</span></Link>
          <Link to="/analytics" className="tile"><b>↗ Enrollment & payment tracking</b><span>View enrollment and paid sales overview</span></Link>
        </div>
      </section>}

      <section id="catalog">
        <div className="sectionHead">
          <div><span className="eyebrow">THE CATALOG</span><h2>Find your next skill.</h2></div>
          <div className="catalogTools"><span>{catalogLoading ? 'Loading…' : `${courses.length} courses`}</span><button className="small" onClick={loadCourses} disabled={catalogLoading}>{catalogLoading ? 'Refreshing…' : 'Refresh catalog'}</button></div>
        </div>
        {catalogError && <div className="notice" role="alert">{catalogError} <button className="small" onClick={loadCourses}>Try again</button></div>}
        {catalogLoading && !courses.length && <div className="empty">Loading published courses…</div>}
        {!catalogLoading && !catalogError && courses.length === 0 && <div className="empty">No published courses are currently available. If your instructor just published one, refresh the catalog and verify that the frontend and instructor are using the same backend and database.</div>}
        <div className="courseGrid">
          {courses.map(c => <article className="course" key={c._id}>
            <div className="courseArt"><span>{(c.category || 'LEARN').toUpperCase()}</span><b>0{String(c.title || '').length % 9 + 1}</b></div>
            <div className="courseBody">
              <small>{c.instructor?.name || 'LearnLive instructor'}</small><h3>{c.title}</h3><p>{c.description || 'Build practical skills with guided lessons.'}</p>
              <div className="courseFoot"><b>{c.pricePaise ? `₹${(c.pricePaise / 100).toFixed(0)}` : 'Free'}</b>{user?.role === 'instructor' || user?.role === 'admin' ? <span className="muted">Student catalog preview</span> : <button onClick={() => enroll(c)}>{user?.role === 'student' ? 'Enroll ↗' : 'Sign in to enroll ↗'}</button>}</div>
            </div>
          </article>)}
        </div>
      </section>
    </main>
    <footer><b>◈ LearnLive</b><span>Built for your next chapter.</span></footer>
    <div className="toastViewport" aria-live="polite" aria-relevant="additions text" aria-label="Notifications">
      {toasts.map(toast => (
        <div className={`appToast appToast--${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} key={toast.id}>
          <span className="appToastIcon" aria-hidden="true">{toast.type === 'success' ? '✓' : toast.type === 'info' ? 'i' : '!'}</span>
          <p>{toast.message}</p>
          <button type="button" className="appToastClose" aria-label="Dismiss notification" onClick={() => setToasts(current => current.filter(t => t.id !== toast.id))}>×</button>
          <span className="appToastTimer" aria-hidden="true" />
        </div>
      ))}
    </div>
  </div>;
}

function HlsVideo({ src, title }) {
  const videoRef = React.useRef(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let hls;
    setProblem('');
    // Safari can play HLS natively. Most Chromium browsers need hls.js.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setProblem('Video playback failed. Verify the CloudFront URL, HLS files, and CORS configuration.');
      });
    } else {
      setProblem('This browser does not support HLS playback.');
    }
    return () => { if (hls) hls.destroy(); video.removeAttribute('src'); video.load(); };
  }, [src]);
  return <div className="lessonPlayer">
    <video ref={videoRef} className="lessonVideo" controls playsInline preload="metadata" aria-label={title || 'Course video'} />
    {problem && <small className="notice" role="alert">{problem}</small>}
  </div>;
}

function Enrollments({ refreshToken }) {
  const [items, setItems] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { const r = await api.get('/me/enrollments'); setItems(r.data); }
    catch (e) { setError(e.response?.data?.error || e.message || 'Unable to load enrollments.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh, refreshToken]);

  async function complete(enrollmentId, index) {
    try {
      await api.post(`/enrollments/${enrollmentId}/lessons/${index}/complete`);
      setMessage('Lesson progress saved.'); await refresh();
    } catch (e) { setMessage(e.response?.data?.error || e.message || 'Could not save progress.'); }
  }
  async function certificate(enrollmentId) {
    try {
      const r = await api.get(`/enrollments/${enrollmentId}/certificate`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data); const a = document.createElement('a');
      a.href = url; a.download = 'LearnLive-Certificate.pdf'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setMessage(e.response?.data?.error || e.message || 'Certificate download failed.'); }
  }

  return <div className="enrollments">
    {loading && !items.length && <p className="muted">Loading your courses…</p>}
    {error && <p className="notice" role="alert">{error} <button className="small" onClick={refresh}>Retry</button></p>}
    {items.map(e => <article className="enroll" key={e._id}>
      <div><b>{e.course?.title || 'Course'}</b><p>{e.completedLessons?.length || 0}/{e.course?.lessons?.length || 0} lessons completed</p><div className="progress"><i style={{ width: `${e.course?.lessons?.length ? (e.completedLessons.length / e.course.lessons.length) * 100 : 0}%` }} /></div></div>
      <div className="lessonActions">
        {e.course?.lessons?.map((lesson, i) => <div className="enrolledLesson" key={lesson._id || i}>
          {lesson.videoUrl && lesson.videoStatus === 'ready' ? <HlsVideo src={lesson.videoUrl} title={lesson.title || `Lesson ${i + 1}`} /> : <p className="muted">{lesson.videoStatus === 'processing' ? 'Video is still processing.' : 'Lesson video is not available yet.'}</p>}
          <button className="small" onClick={() => complete(e._id, i)} disabled={e.completedLessons?.includes(i)}>{e.completedLessons?.includes(i) ? '✓ Completed' : `Mark complete · ${lesson.title || `Lesson ${i + 1}`}`}</button>
        </div>)}
        {e.completedAt && <button className="small" onClick={() => certificate(e._id)}>Download certificate</button>}
      </div>
    </article>)}
    {message && <small role="status">{message}</small>}
    {!loading && !items.length && !error && <p className="muted">Enroll in a course to see your progress here.</p>}
  </div>;
}

function AdminUsers() {
  const [users, setUsers] = useState([]); const [msg, setMsg] = useState('');
  async function refresh() {
    try { const r = await api.get('/auth/admin/users?limit=50'); setUsers(r.data.users || []); }
    catch (e) { setMsg(e.response?.data?.error || e.message); }
  }
  useEffect(() => { refresh(); }, []);
  async function update(id, change) {
    try { await api.patch(`/auth/admin/users/${id}`, change); setMsg('Account updated. Their previous sessions have been revoked.'); await refresh(); }
    catch (e) { setMsg(e.response?.data?.error || e.message); }
  }
  return <div className="adminUsers">
    {msg && <p className="notice" role="status">{msg}</p>}
    {users.map(u => <div className="adminRow" key={u.id}>
      <div><b>{u.name}</b><p>{u.email}</p><small>{u.role} · {u.status}</small></div>
      <div className="lessonActions">
        <select aria-label={`Role for ${u.email}`} value={u.role} onChange={e => update(u.id, { role: e.target.value })}>
          <option value="student">Student</option><option value="instructor">Instructor</option><option value="admin">Admin</option>
        </select>
        <button className="small" onClick={() => update(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })}>{u.status === 'active' ? 'Disable' : 'Enable'}</button>
      </div>
    </div>)}
  </div>;
}
