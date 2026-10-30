import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { LiveKitRoom, VideoConference, PreJoin } from '@livekit/components-react';
import '@livekit/components-styles';
import { api } from '../api';

const mediaOk = () => typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
const errText = e => e?.response?.data?.error || e?.message || 'Something went wrong';
const fmtDate = d => new Date(d).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtDuration = secs => { const m = Math.round(secs / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
function relative(startsAt, now) {
  const diff = new Date(startsAt) - now;
  if (diff <= 0) return 'Starting now';
  const m = Math.round(diff / 60000);
  if (m < 60) return `Starts in ${m} min`;
  if (m < 60 * 24) return `Starts in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `Starts in ${Math.floor(m / 1440)} day${m >= 2880 ? 's' : ''}`;
}
const toLocalInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

export default function Live() {
  const user = useSelector(s => s.auth.user);
  const isStaff = ['instructor', 'admin'].includes(user?.role);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const [joining, setJoining] = useState(null);   // class chosen for pre-join screen
  const [session, setSession] = useState(null);   // token + class once connected

  const load = useCallback(async () => {
    try { const r = await api.get('/live/classes'); setClasses(r.data.classes || []); setError(''); }
    catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!user) { setLoading(false); return; }
    load();
    const poll = setInterval(load, 15000), tick = setInterval(() => setNow(Date.now()), 30000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [user?.id, load]);

  if (!user) return <main className="shell livePage"><p className="notice">Please sign in to see your live classes.</p></main>;

  if (session) return <LiveRoom session={session} user={user} onExit={msg => { setSession(null); setJoining(null); if (msg) setNotice(msg); load(); }} />;

  if (joining) return <PreJoinScreen cls={joining} user={user} onCancel={() => setJoining(null)} onJoined={setSession} />;

  return <main className="shell livePage">
    <div className="studioHeading"><div><span className="eyebrow">LIVE CLASSES</span><h1>{isStaff ? 'Live class studio' : 'Live classes'}</h1>
      <p className="muted">{isStaff ? 'Schedule sessions for your courses, host them with video, audio and chat, and track attendance.' : 'Join scheduled sessions for the courses you are enrolled in.'}</p></div>
      <button className="small" onClick={load}>Refresh</button></div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="studioError" role="alert">{error}</p>}
    {isStaff && <Scheduler onSaved={m => { setNotice(m); load(); }} onError={setError} editing={null} />}
    <ClassList classes={classes} loading={loading} isStaff={isStaff} now={now}
      onJoin={setJoining} reload={load} setNotice={setNotice} setError={setError} />
  </main>;
}

/* ---------------- Scheduling (instructor) ---------------- */
function Scheduler({ onSaved, onError, editing, onDone }) {
  const [courses, setCourses] = useState([]);
  const blank = { courseId: '', title: '', description: '', startsAt: '', durationMin: 60 };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/instructor/courses/mine').then(r => setCourses(r.data.courses || [])).catch(e => onError(errText(e))); }, []);
  useEffect(() => {
    if (editing) setForm({ courseId: editing.course.id, title: editing.title, description: editing.description || '', startsAt: toLocalInput(editing.startsAt), durationMin: editing.durationMin });
    else setForm(blank);
  }, [editing?.id]);
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      const body = { title: form.title, description: form.description, startsAt: new Date(form.startsAt).toISOString(), durationMin: Number(form.durationMin) };
      if (editing) { await api.patch(`/live/classes/${editing.id}`, body); onSaved('Class rescheduled.'); onDone?.(); }
      else { await api.post('/live/classes', { ...body, courseId: form.courseId }); setForm({ ...blank, courseId: form.courseId }); onSaved('Class scheduled. Enrolled students will see it in their Live classes list.'); }
    } catch (ex) { onError(errText(ex)); } finally { setBusy(false); }
  }
  return <section className="panel liveScheduler">
    <h2>{editing ? 'Reschedule class' : 'Schedule a live class'}</h2>
    <form className="studioForm" onSubmit={submit}>
      {!editing && <label>Course<select required value={form.courseId} onChange={e => setForm({ ...form, courseId: e.target.value })}>
        <option value="">Select a course…</option>{courses.map(c => <option key={c._id} value={c._id}>{c.title}</option>)}</select></label>}
      <input required minLength="3" maxLength="180" placeholder="Class title (e.g. Week 3 · Q&A and doubt clearing)" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
      <textarea maxLength="4000" placeholder="Agenda or notes for students (optional)" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
      <div className="liveFormRow">
        <label>Date &amp; time<input type="datetime-local" required min={toLocalInput(new Date())} value={form.startsAt} onChange={e => setForm({ ...form, startsAt: e.target.value })} /></label>
        <label>Duration (minutes)<input type="number" required min="5" max="480" step="5" value={form.durationMin} onChange={e => setForm({ ...form, durationMin: e.target.value })} /></label>
      </div>
      <div className="liveActions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Schedule class'}</button>{editing && <button type="button" className="small" onClick={onDone}>Cancel</button>}</div>
    </form></section>;
}

/* ---------------- Class list ---------------- */
function ClassList({ classes, loading, isStaff, now, onJoin, reload, setNotice, setError }) {
  const [attendanceFor, setAttendanceFor] = useState('');
  const [editing, setEditing] = useState(null);
  const live = classes.filter(c => c.status === 'live');
  const upcoming = classes.filter(c => c.status === 'scheduled');
  const past = classes.filter(c => ['ended', 'cancelled'].includes(c.status)).reverse();

  async function act(path, okMsg, after) {
    try { const r = await api.post(path); if (okMsg) setNotice(okMsg); await reload(); return r.data; }
    catch (e) { setError(errText(e)); }
  }
  async function goLive(c) { const r = await act(`/live/classes/${c.id}/start`); if (r) onJoin(r.class); }

  const Card = ({ c }) => <article className={`liveCard ${c.status}`} key={c.id}>
    <div className="liveCardMain">
      <div className="liveCardTop"><span className={`liveBadge ${c.status}`}>{c.status === 'live' ? '● LIVE NOW' : c.status}</span><small className="muted">{c.course.title}{!isStaff && c.instructor?.name ? ` · ${c.instructor.name}` : ''}</small></div>
      <h3>{c.title}</h3>
      {c.description && <p className="muted">{c.description}</p>}
      <p className="liveMeta">{fmtDate(c.startsAt)} · {c.durationMin} min{c.status === 'scheduled' && <b> · {relative(c.startsAt, now)}</b>}
        {isStaff && c.status !== 'cancelled' && <span> · {c.attendeeCount} student{c.attendeeCount === 1 ? '' : 's'} joined</span>}
        {!isStaff && c.status === 'ended' && <span> · {c.attended ? `You attended ${fmtDuration(c.attendedSeconds)}` : 'You did not attend'}</span>}</p>
    </div>
    <div className="liveCardActions">
      {isStaff ? <>
        {c.status === 'scheduled' && <button className="primary" onClick={() => goLive(c)}>Go live</button>}
        {c.status === 'live' && <button className="primary" onClick={() => onJoin(c)}>Rejoin as host</button>}
        {c.status === 'scheduled' && <><button className="small" onClick={() => setEditing(c)}>Reschedule</button>
          <button className="small danger" onClick={() => { if (confirm('Cancel this class?')) act(`/live/classes/${c.id}/cancel`, 'Class cancelled.'); }}>Cancel</button></>}
        {c.status !== 'cancelled' && <button className="small" onClick={() => setAttendanceFor(attendanceFor === c.id ? '' : c.id)}>{attendanceFor === c.id ? 'Hide attendance' : 'Attendance'}</button>}
      </> : <>
        {c.status === 'live' && <button className="primary" onClick={() => onJoin(c)}>Join class</button>}
        {c.status === 'scheduled' && <button className="small" disabled>Waiting for instructor</button>}
      </>}
    </div>
    {isStaff && attendanceFor === c.id && <Attendance id={c.id} />}
  </article>;

  const Section = ({ title, items, empty }) => <section className="liveSection"><h2>{title} <small>({items.length})</small></h2>
    {items.length ? <div className="liveGrid">{items.map(c => <Card key={c.id} c={c} />)}</div> : <p className="muted">{empty}</p>}</section>;

  if (loading) return <p className="muted">Loading classes…</p>;
  return <>
    {editing && <Scheduler editing={editing} onDone={() => setEditing(null)} onSaved={m => { setNotice(m); setEditing(null); reload(); }} onError={setError} />}
    {live.length > 0 && <Section title="Live now" items={live} />}
    <Section title="Upcoming" items={upcoming} empty={isStaff ? 'Nothing scheduled yet. Use the form above to schedule your first class.' : 'No upcoming classes. Your instructors will schedule sessions for your enrolled courses.'} />
    {past.length > 0 && <Section title="Past classes" items={past} />}
  </>;
}

function Attendance({ id }) {
  const [data, setData] = useState(null), [err, setErr] = useState('');
  useEffect(() => { let on = true; const get = () => api.get(`/live/classes/${id}/attendance`).then(r => on && setData(r.data)).catch(e => on && setErr(errText(e))); get(); const t = setInterval(get, 20000); return () => { on = false; clearInterval(t); }; }, [id]);
  if (err) return <p className="studioError">{err}</p>;
  if (!data) return <p className="muted">Loading attendance…</p>;
  return <div className="attendance">
    <p><b>{data.present}</b> of <b>{data.enrolled}</b> enrolled students attended.</p>
    <table><thead><tr><th>Student</th><th>Status</th><th>First joined</th><th>Time in class</th><th>Joins</th></tr></thead>
      <tbody>{data.attendance.map(a => <tr key={a.userId}><td><b>{a.name}</b><br /><small className="muted">{a.email}</small></td>
        <td><span className={`liveBadge ${a.online ? 'live' : a.present ? 'ended' : 'scheduled'}`}>{a.online ? 'In class' : a.present ? 'Attended' : 'Absent'}</span></td>
        <td>{a.firstJoinedAt ? fmtDate(a.firstJoinedAt) : '—'}</td><td>{a.present ? fmtDuration(a.totalSeconds) : '—'}</td><td>{a.joins}</td></tr>)}
        {!data.attendance.length && <tr><td colSpan="5" className="muted">No students are enrolled in this course yet.</td></tr>}</tbody></table>
  </div>;
}

/* ---------------- Device check + join ---------------- */
function PreJoinScreen({ cls, user, onCancel, onJoined }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(choices) {
    setBusy(true); setError('');
    try { const r = await api.post(`/live/classes/${cls.id}/token`); onJoined({ ...r.data, choices }); }
    catch (e) { setError(errText(e)); setBusy(false); }
  }
  return <main className="shell livePage">
    <div className="studioHeading"><div><span className="eyebrow">{cls.course.title}</span><h1>{cls.title}</h1><p className="muted">Check your camera and microphone before joining.</p></div><button className="small" onClick={onCancel}>← Back</button></div>
    {error && <p className="studioError" role="alert">{error}</p>}
    {!mediaOk() ? <div className="panel mediaBlocked"><h2>Camera and microphone are blocked by your browser</h2>
      <p>Browsers only allow camera and microphone on a secure address. You opened this site over an insecure connection (<code>{window.location.origin}</code>).</p>
      <ul><li>Open the site as <b>http://localhost:5173</b> on the same computer, or</li><li>use <b>https://</b> (run the client with <code>VITE_HTTPS=true npm run dev</code>, or deploy behind HTTPS).</li></ul>
      <p className="muted">You can still join to watch, listen and use the chat.</p>
      <button className="primary" disabled={busy} onClick={() => submit({ audioEnabled: false, videoEnabled: false, noMedia: true })}>{busy ? 'Joining…' : 'Join without camera & microphone'}</button></div>
    : <div className="preJoinWrap" data-lk-theme="default"><PreJoin defaults={{ username: user.name, videoEnabled: false, audioEnabled: true }} joinLabel={busy ? 'Joining…' : 'Join class'}
      onSubmit={submit} onError={e => setError(e.message || 'Could not access camera or microphone. Allow permissions in your browser and use HTTPS or localhost.')} persistUserChoices /></div>}
  </main>;
}

/* ---------------- In-class room ---------------- */
function LiveRoom({ session, user, onExit }) {
  const { token, url, host, sessionId, choices } = session;
  const cls = session.class;
  const [state, setState] = useState('connecting');
  const [mediaWarning, setMediaWarning] = useState('');
  const exited = useRef(false);
  const base = api.defaults.baseURL;

  const leave = useCallback(async (msg) => {
    if (exited.current) return; exited.current = true;
    try { await api.post(`/live/classes/${cls.id}/heartbeat`, { sessionId, leaving: true }); } catch { /* ignore */ }
    onExit(msg);
  }, [cls.id, sessionId]);

  useEffect(() => {
    const beat = async () => {
      try { const r = await api.post(`/live/classes/${cls.id}/heartbeat`, { sessionId }); if (r.data.status === 'ended') leave('The class has ended. Thanks for joining!'); }
      catch { /* transient */ }
    };
    const t = setInterval(beat, 30000);
    const onUnload = () => { try { fetch(`${base}/live/classes/${cls.id}/heartbeat`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('ll-token')}` }, body: JSON.stringify({ sessionId, leaving: true }) }); } catch { /* ignore */ } };
    window.addEventListener('pagehide', onUnload);
    return () => { clearInterval(t); window.removeEventListener('pagehide', onUnload); };
  }, [cls.id, sessionId]);

  async function endForAll() {
    if (!confirm(`End “${cls.title}” for EVERYONE?\n\nAll students will be disconnected and the class cannot be restarted. Use “Leave” if you only want to step out.`)) return;
    try { await api.post(`/live/classes/${cls.id}/end`); await leave('Class ended. Attendance has been saved.'); } catch (e) { alert(errText(e)); }
  }

  return <main className="liveRoomPage">
    <div className="liveRoomBar"><div><span className={`liveBadge ${state === 'connected' ? 'live' : 'scheduled'}`}>{state === 'connected' ? '● LIVE' : state === 'error' ? 'Connection problem' : 'Connecting…'}</span><b>{cls.title}</b><small className="muted"> · {cls.course.title}</small></div>
      <div className="liveActions"><button className="small" onClick={() => leave(host ? 'You left the room. The class is still live: rejoin any time.' : 'You left the class.')}>{host ? 'Leave (class stays live)' : 'Leave'}</button>{host && <button className="small danger" onClick={endForAll}>End class for everyone…</button>}</div></div>
    {mediaWarning && <p className="studioError" role="alert" style={{margin:0,borderRadius:0}}>{mediaWarning} <button className="small" onClick={() => setMediaWarning('')}>Dismiss</button></p>}
    <div className="liveRoomStage" data-lk-theme="default">
      <LiveKitRoom token={token} serverUrl={url} connect
        audio={choices?.noMedia || choices?.audioEnabled === false ? false : { deviceId: choices?.audioDeviceId || undefined }}
        video={choices?.noMedia || !choices?.videoEnabled ? false : { deviceId: choices?.videoDeviceId || undefined }}
        onMediaDeviceFailure={f => setMediaWarning('Your camera or microphone could not be used. Check browser permissions (the lock icon in the address bar) and that no other app is using the device. You can still watch and chat.')}
        onConnected={() => setState('connected')}
        onError={() => setState('error')}
        onDisconnected={() => leave('You left the class.')}>
        <VideoConference />
      </LiveKitRoom>
    </div>
  </main>;
}
