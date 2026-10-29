import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { api } from '../api';

const blank = { title: '', description: '', category: '', priceRupees: '0' };

export default function Studio() {
  const account = useSelector(state => state.auth.user);
  const accountId = String(account?.id || account?._id || '');
  const isAdmin = account?.role === 'admin';

  const [courses, setCourses] = useState([]);
  const [active, setActive] = useState(null);
  const [form, setForm] = useState(blank);
  const [newCourse, setNewCourse] = useState(blank);
  const [newLesson, setNewLesson] = useState({ title: '', description: '' });
  const [uploading, setUploading] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  
  const files = useRef({});

  const announce = (s) => {
    setMessage(s);
    setError('');
  };

  const problem = (e) => {
    setError(e.response?.data?.error || e.message || 'Request failed');
    setMessage('');
  };

  async function refresh(preferred) {
    try {
      if (!accountId || !account?.role) {
        setCourses([]);
        setActive(null);
        return [];
      }
      const r = await api.get('/instructor/courses/mine');
      const received = Array.isArray(r.data?.courses) ? r.data.courses : [];
      
      // Defense in depth: API must scope too. Admin is allowed to manage all.
      const mine = isAdmin ? received : received.filter(c => {
        const owner = typeof c.instructor === 'object' ? (c.instructor?._id || c.instructor?.id) : c.instructor;
        return String(owner || '') === accountId;
      });

      setCourses(mine);
      
      if (!isAdmin && mine.length !== received.length) {
        setError('The server returned courses owned by another instructor. They were hidden. Update/check the deployed instructor course API.');
      }

      const next = mine.find(c => String(c._id) === String(preferred || active?._id)) || mine[0] || null;
      setActive(next);

      if (next) {
        setForm({
          title: next.title,
          description: next.description || '',
          category: next.category || '',
          priceRupees: String((next.pricePaise || 0) / 100)
        });
      } else {
        setForm(blank);
      }
      return mine;
    } catch (e) {
      problem(e);
      throw e;
    }
  }

  useEffect(() => {
    if (accountId && account?.role) {
      refresh().catch(() => {});
    } else {
      setCourses([]);
      setActive(null);
    }
  }, [accountId, account?.role]);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...newCourse,
        pricePaise: Math.round(Number(newCourse.priceRupees) * 100)
      };
      delete payload.priceRupees;
      
      const r = await api.post('/instructor/courses', payload);
      setNewCourse(blank);
      await refresh(r.data.course._id);
      announce('Draft created. Add lessons and upload videos to prepare it for publishing.');
    } catch (e) {
      problem(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveCourse(e) {
    e.preventDefault();
    if (!active) return;
    setBusy(true);
    try {
      await api.patch(`/instructor/courses/${active._id}`, {
        title: form.title,
        description: form.description,
        category: form.category,
        pricePaise: Math.round(Number(form.priceRupees) * 100)
      });
      await refresh(active._id);
      announce('Course details saved.');
    } catch (e) {
      problem(e);
    } finally {
      setBusy(false);
    }
  }

  async function addLesson(e) {
    e.preventDefault();
    if (!active) return;
    setBusy(true);
    try {
      await api.post(`/instructor/courses/${active._id}/lessons`, newLesson);
      setNewLesson({ title: '', description: '' });
      await refresh(active._id);
      announce('Lesson added. Select its video file below.');
    } catch (e) {
      problem(e);
    } finally {
      setBusy(false);
    }
  }

  async function removeLesson(lesson) {
    if (!confirm(`Remove lesson “${lesson.title}”?`)) return;
    try {
      await api.delete(`/instructor/courses/${active._id}/lessons/${lesson._id}`);
      await refresh(active._id);
      announce('Lesson removed.');
    } catch (e) {
      problem(e);
    }
  }

  async function upload(lesson) {
    const file = files.current[lesson._id];
    if (!file) {
      setError('Choose a video file first.');
      return;
    }
    setUploading(lesson._id);
    setError('');
    setMessage('');
    
    try {
      const intent = await api.post(`/instructor/courses/${active._id}/lessons/${lesson._id}/upload-intent`, {
        filename: file.name,
        contentType: file.type,
        size: file.size
      });

      const put = await fetch(intent.data.uploadUrl, {
        method: 'PUT',
        headers: intent.data.headers,
        body: file
      });

      if (!put.ok) throw Error(`Storage upload failed (${put.status}). Check the bucket CORS policy and retry.`);

      const submitted = await api.post(`/instructor/courses/assets/${intent.data.assetId}/upload-complete`);
      announce(`Upload complete. Video processing has started (job ${submitted.data.jobId}). You can refresh the status in a moment.`);
      await refresh(active._id);

      // Poll the server-managed asset status while this screen remains open.
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const status = await api.get(`/instructor/courses/assets/${intent.data.assetId}`);
        if (status.data.asset.status === 'ready') {
          await refresh(active._id);
          announce(`“${lesson.title}” is processed and ready.`);
          break;
        }
        if (status.data.asset.status === 'failed') {
          throw Error(status.data.asset.error || 'Video processing failed. Re-upload the source and retry.');
        }
      }
    } catch (e) {
      problem(e);
      await refresh(active._id);
    } finally {
      setUploading('');
    }
  }

  async function publish() {
    if (!active) return;
    setBusy(true);
    try {
      await api.post(`/instructor/courses/${active._id}/publish`);
      await refresh(active._id);
      announce('Course published and now visible in the public catalog.');
    } catch (e) {
      problem(e);
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!active) return;
    setBusy(true);
    try {
      await api.post(`/instructor/courses/${active._id}/unpublish`);
      await refresh(active._id);
      announce('Course unpublished.');
    } catch (e) {
      problem(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell studioPage">
      <div className="studioHeading">
        <div>
          <span className="eyebrow">INSTRUCTOR WORKSPACE</span>
          <h1>Course studio</h1>
          <p className="muted">Build your course, organize lessons, upload source videos, and publish when ready.</p>
        </div>
        <button className="small" onClick={() => refresh()}>Refresh</button>
      </div>

      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="studioError" role="alert">{error}</p>}

      <section className="panel">
        <h2>Create a course</h2>
        <form className="studioForm" onSubmit={create}>
          <input
            required
            minLength="3"
            maxLength="180"
            placeholder="Course title"
            value={newCourse.title}
            onChange={e => setNewCourse({ ...newCourse, title: e.target.value })}
          />
          <input
            maxLength="100"
            placeholder="Category (e.g. Full-stack)"
            value={newCourse.category}
            onChange={e => setNewCourse({ ...newCourse, category: e.target.value })}
          />
          <textarea
            maxLength="10000"
            placeholder="What will students learn?"
            value={newCourse.description}
            onChange={e => setNewCourse({ ...newCourse, description: e.target.value })}
          />
          <label>
            Price (₹)
            <input
              type="number"
              min="0"
              max="10000000"
              step="0.01"
              required
              value={newCourse.priceRupees}
              onChange={e => setNewCourse({ ...newCourse, priceRupees: e.target.value })}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Working…' : 'Create draft'}
          </button>
        </form>
      </section>

      <div className="studioLayout">
        <aside className="panel studioList">
          <h2>Your courses <small>({courses.length})</small></h2>
          {courses.map(c => (
            <button
              key={c._id}
              className={`studioCourse ${active?._id === c._id ? 'selected' : ''}`}
              onClick={() => {
                setActive(c);
                setForm({
                  title: c.title,
                  description: c.description || '',
                  category: c.category || '',
                  priceRupees: String((c.pricePaise || 0) / 100)
                });
                setError('');
                setMessage('');
              }}
            >
              <b>{c.title}</b>
              <span>{c.published ? 'Published' : 'Draft'} · {c.lessons?.length || 0} lessons</span>
            </button>
          ))}
          {!courses.length && <p className="muted">No courses belong to this instructor account yet. Create your first draft.</p>}
        </aside>

        <section className="panel studioEditor">
          {!active ? (
            <div className="empty">Select or create a course to start editing.</div>
          ) : (
            <>
              <div className="editorTitle">
                <div>
                  <span className="eyebrow">COURSE DETAILS</span>
                  <h2>{active.title}</h2>
                </div>
                <span className={`statusPill ${active.published ? 'published' : ''}`}>
                  {active.published ? 'Published' : 'Draft'}
                </span>
              </div>

              <form className="studioForm" onSubmit={saveCourse}>
                <input
                  required
                  minLength="3"
                  maxLength="180"
                  placeholder="Course title"
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                />
                <input
                  maxLength="100"
                  placeholder="Category"
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                />
                <textarea
                  maxLength="10000"
                  placeholder="Course description"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                />
                <label>
                  Price (₹)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.priceRupees}
                    onChange={e => setForm({ ...form, priceRupees: e.target.value })}
                  />
                </label>
                <button className="primary" disabled={busy}>Save course</button>
              </form>

              <div className="lessonHeader">
                <h2>Lessons <small>({active.lessons?.length || 0})</small></h2>
              </div>

              <div className="studioLessons">
                {(active.lessons || []).map((lesson, i) => (
                  <article className="studioLesson" key={lesson._id}>
                    <div className="lessonTitle">
                      <b>{i + 1}. {lesson.title}</b>
                      <span className={`statusPill ${lesson.videoStatus === 'ready' ? 'published' : ''}`}>
                        {lesson.videoStatus || 'missing'}
                      </span>
                    </div>
                    {lesson.description && <p className="muted">{lesson.description}</p>}
                    {lesson.videoUrl && lesson.videoStatus === 'ready' && (
                      <small className="readyText">Video ready for playback</small>
                    )}
                    <div className="uploadRow">
                      <input
                        type="file"
                        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                        disabled={uploading === lesson._id}
                        onChange={e => {
                          files.current[lesson._id] = e.target.files?.[0];
                        }}
                      />
                      <button
                        className="small"
                        disabled={!!uploading || busy}
                        onClick={() => upload(lesson)}
                      >
                        {uploading === lesson._id ? 'Uploading / processing…' : 'Upload video'}
                      </button>
                      <button
                        className="small danger"
                        disabled={!!uploading}
                        onClick={() => removeLesson(lesson)}
                      >
                        Remove
                      </button>
                    </div>
                    <small className="muted">MP4, MOV, or WebM · Maximum 2 GB · Upload link expires in 10 minutes</small>
                  </article>
                ))}
                {!active.lessons?.length && <p className="muted">Add your first lesson below.</p>}
              </div>

              <form className="studioForm addLessonForm" onSubmit={addLesson}>
                <h3>Add a lesson</h3>
                <input
                  required
                  minLength="2"
                  maxLength="180"
                  placeholder="Lesson title"
                  value={newLesson.title}
                  onChange={e => setNewLesson({ ...newLesson, title: e.target.value })}
                />
                <textarea
                  maxLength="4000"
                  placeholder="Lesson description (optional)"
                  value={newLesson.description}
                  onChange={e => setNewLesson({ ...newLesson, description: e.target.value })}
                />
                <button className="primary" disabled={busy}>Add lesson</button>
              </form>

              <div className="publishRow">
                <p className="muted">Publishing requires one or more lessons with processed videos.</p>
                {active.published ? (
                  <button className="small" disabled={busy} onClick={unpublish}>Unpublish</button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || !active.lessons?.length || active.lessons.some(l => l.videoStatus !== 'ready' || !l.videoUrl)}
                    onClick={publish}
                  >
                    Publish course
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <p className="muted studioFootnote">For production, configure a private S3 bucket, narrowly scoped IAM access, bucket CORS, CloudFront origin access, and lifecycle cleanup for unneeded source files.</p>
    </main>
  );
}