
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const blank = {
  title: '',
  description: '',
  category: '',
  priceRupees: '0'
};

const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024;
const ALLOWED_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm'
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getErrorMessage(error) {
  return (
    error?.response?.data?.error ||
    error?.message ||
    'Request failed. Please try again.'
  );
}

function getS3ErrorMessage(status, body) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(body || '', 'application/xml');

  const code = xml.querySelector('Code')?.textContent;
  const message = xml.querySelector('Message')?.textContent;
  const requestId = xml.querySelector('RequestId')?.textContent;

  console.error('S3 upload failure:', {
    status,
    code,
    message,
    requestId,
    body
  });

  if (code === 'SignatureDoesNotMatch') {
    return 'S3 rejected the signature. Verify the signed Content-Type, region, credentials and upload headers.';
  }

  if (code === 'AccessDenied') {
    return 'S3 AccessDenied. Check IAM permissions, bucket policy, encryption permissions and explicit denies.';
  }

  if (code === 'ExpiredToken' || code === 'ExpiredPresignedRequest') {
    return 'The upload authorization expired. Request a fresh upload link and retry.';
  }

  if (code === 'AuthorizationHeaderMalformed' || code === 'PermanentRedirect') {
    return 'S3 region mismatch. Check AWS_REGION against the actual bucket region.';
  }

  if (code === 'RequestExpired') {
    return 'The signed upload request expired. Request a new upload link.';
  }

  if (message) {
    return `S3 upload rejected (${status}): ${message}${code ? ` [${code}]` : ''}`;
  }

  return `S3 upload rejected (${status}). Check the browser Network tab and bucket CORS configuration.`;
}

export default function Studio() {
  const [courses, setCourses] = useState([]);
  const [active, setActive] = useState(null);

  const [form, setForm] = useState(blank);
  const [newCourse, setNewCourse] = useState(blank);

  const [newLesson, setNewLesson] = useState({
    title: '',
    description: ''
  });

  const [uploading, setUploading] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const files = useRef({});
  const mounted = useRef(false);

  const announce = (text) => {
    setMessage(text);
    setError('');
  };

  const problem = (err) => {
    setError(getErrorMessage(err));
    setMessage('');
  };

  function courseToForm(course) {
    return {
      title: course.title || '',
      description: course.description || '',
      category: course.category || '',
      priceRupees: String((course.pricePaise || 0) / 100)
    };
  }

  async function refresh(preferredId) {
    try {
      const response = await api.get('/instructor/courses/mine');

      const list = response.data.courses || [];

      if (!mounted.current) return;

      setCourses(list);

      const targetId = preferredId || active?._id;

      const next =
        list.find(course => course._id === targetId) ||
        list[0] ||
        null;

      setActive(next);

      if (next) {
        setForm(courseToForm(next));
      } else {
        setForm(blank);
      }

      return list;
    } catch (err) {
      if (mounted.current) problem(err);
      throw err;
    }
  }

  useEffect(() => {
    mounted.current = true;

    refresh().catch(() => {});

    return () => {
      mounted.current = false;
    };
    // Initial load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(event) {
    event.preventDefault();

    const rupees = Number(newCourse.priceRupees);

    if (!Number.isFinite(rupees) || rupees < 0) {
      setError('Enter a valid course price.');
      return;
    }

    const pricePaise = Math.round(rupees * 100);

    if (!Number.isSafeInteger(pricePaise)) {
      setError('Course price is too large.');
      return;
    }

    setBusy(true);

    try {
      const payload = {
        title: newCourse.title.trim(),
        description: newCourse.description,
        category: newCourse.category,
        pricePaise
      };

      const response = await api.post(
        '/instructor/courses',
        payload
      );

      setNewCourse(blank);

      const courseId = response.data.course._id;

      await refresh(courseId);

      announce(
        'Draft created. Add lessons and upload videos before publishing.'
      );
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveCourse(event) {
    event.preventDefault();

    if (!active) return;

    const rupees = Number(form.priceRupees);

    if (!Number.isFinite(rupees) || rupees < 0) {
      setError('Enter a valid course price.');
      return;
    }

    const pricePaise = Math.round(rupees * 100);

    if (!Number.isSafeInteger(pricePaise)) {
      setError('Course price is too large.');
      return;
    }

    setBusy(true);

    try {
      await api.patch(
        `/instructor/courses/${active._id}`,
        {
          title: form.title.trim(),
          description: form.description,
          category: form.category,
          pricePaise
        }
      );

      await refresh(active._id);

      announce('Course details saved.');
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  async function addLesson(event) {
    event.preventDefault();

    if (!active) return;

    setBusy(true);

    try {
      await api.post(
        `/instructor/courses/${active._id}/lessons`,
        {
          title: newLesson.title.trim(),
          description: newLesson.description
        }
      );

      setNewLesson({
        title: '',
        description: ''
      });

      await refresh(active._id);

      announce('Lesson added. Select its video file below.');
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  async function removeLesson(lesson) {
    if (!active) return;

    const confirmed = window.confirm(
      `Remove lesson "${lesson.title}"?`
    );

    if (!confirmed) return;

    setBusy(true);

    try {
      await api.delete(
        `/instructor/courses/${active._id}/lessons/${lesson._id}`
      );

      await refresh(active._id);

      announce('Lesson removed.');
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  async function upload(lesson) {
    if (!active) return;

    const file = files.current[lesson._id];

    if (!file) {
      setError('Choose a video file first.');
      return;
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Choose an MP4, MOV or WebM video.');
      return;
    }

    if (file.size < 1 || file.size > MAX_VIDEO_SIZE) {
      setError('Video must be larger than 0 bytes and at most 2 GB.');
      return;
    }

    setUploading(lesson._id);
    setError('');
    setMessage('');

    try {
      // Step 1: Ask the authenticated backend for upload authorization.
      const intentResponse = await api.post(
        `/instructor/courses/${active._id}/lessons/${lesson._id}/upload-intent`,
        {
          filename: file.name,
          contentType: file.type,
          size: file.size
        }
      );

      const intent = intentResponse.data;

      if (
        !intent.uploadUrl ||
        !intent.assetId ||
        !intent.headers
      ) {
        throw new Error(
          'Upload authorization response is incomplete. Check your backend response.'
        );
      }

      announce('Uploading video to storage...');

      // Step 2: Upload directly to S3.
      // Do NOT send your application JWT to S3.
      // Only send the headers included in the signed upload intent.
      const uploadHeaders = {
        ...intent.headers
      };

      let putResponse;

      try {
        putResponse = await fetch(intent.uploadUrl, {
          method: 'PUT',
          headers: uploadHeaders,
          body: file
        });
      } catch (fetchError) {
        console.error('S3 network/CORS error:', fetchError);

        throw new Error(
          'Browser could not read the S3 upload response. Check bucket CORS, the Network tab, and whether the upload URL is valid.'
        );
      }

      if (!putResponse.ok) {
        let responseBody = '';

        try {
          responseBody = await putResponse.text();
        } catch {
          // The browser may be unable to expose the response.
        }

        throw new Error(
          getS3ErrorMessage(
            putResponse.status,
            responseBody
          )
        );
      }

      announce('Video uploaded. Verifying the upload...');

      // Step 3: Ask backend to verify object metadata
      // and enqueue the processing job.
      const completeResponse = await api.post(
        `/instructor/courses/assets/${intent.assetId}/upload-complete`
      );

      const jobId = completeResponse.data.jobId;

      announce(
        `Upload complete. Video processing started${jobId ? ` (job ${jobId})` : ''}.`
      );

      await refresh(active._id);

      // Step 4: Poll server-managed asset status.
      let finished = false;

      for (let attempt = 0; attempt < 90; attempt++) {
        await sleep(5000);

        const statusResponse = await api.get(
          `/instructor/courses/assets/${intent.assetId}`
        );

        const asset = statusResponse.data.asset;

        if (asset.status === 'ready') {
          finished = true;

          await refresh(active._id);

          announce(
            `"${lesson.title}" is processed and ready.`
          );

          break;
        }

        if (asset.status === 'failed') {
          throw new Error(
            asset.error ||
            'Video processing failed. Check worker logs and retry.'
          );
        }

        if (!mounted.current) break;
      }

      if (!finished && mounted.current) {
        announce(
          'Video processing is taking longer than expected. Refresh later to check its status.'
        );
      }
    } catch (err) {
      problem(err);

      try {
        await refresh(active._id);
      } catch {
        // Preserve the original upload error.
      }
    } finally {
      if (mounted.current) {
        setUploading('');
      }
    }
  }

  async function publish() {
    if (!active) return;

    setBusy(true);

    try {
      await api.post(
        `/instructor/courses/${active._id}/publish`
      );

      await refresh(active._id);

      announce(
        'Course published and now visible in the public catalog.'
      );
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!active) return;

    setBusy(true);

    try {
      await api.post(
        `/instructor/courses/${active._id}/unpublish`
      );

      await refresh(active._id);

      announce('Course unpublished.');
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  function selectCourse(course) {
    setActive(course);
    setForm(courseToForm(course));
    setError('');
    setMessage('');
  }

  return (
    <main className="shell studioPage">

      <div className="studioHeading">
        <div>
          <span className="eyebrow">
            INSTRUCTOR WORKSPACE
          </span>

          <h1>Course studio</h1>

          <p className="muted">
            Build your course, organize lessons, upload
            source videos, and publish when ready.
          </p>
        </div>

        <button
          className="small"
          disabled={busy || !!uploading}
          onClick={() => refresh().catch(() => {})}
        >
          Refresh
        </button>
      </div>

      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}

      {error && (
        <p className="studioError" role="alert">
          {error}
        </p>
      )}

      {/* Create course */}
      <section className="panel">
        <h2>Create a course</h2>

        <form className="studioForm" onSubmit={create}>
          <input
            required
            minLength={3}
            maxLength={180}
            placeholder="Course title"
            value={newCourse.title}
            onChange={e =>
              setNewCourse({
                ...newCourse,
                title: e.target.value
              })
            }
          />

          <input
            maxLength={100}
            placeholder="Category (e.g. Full-stack)"
            value={newCourse.category}
            onChange={e =>
              setNewCourse({
                ...newCourse,
                category: e.target.value
              })
            }
          />

          <textarea
            maxLength={10000}
            placeholder="What will students learn?"
            value={newCourse.description}
            onChange={e =>
              setNewCourse({
                ...newCourse,
                description: e.target.value
              })
            }
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
              onChange={e =>
                setNewCourse({
                  ...newCourse,
                  priceRupees: e.target.value
                })
              }
            />
          </label>

          <button
            className="primary"
            disabled={busy || !!uploading}
          >
            {busy ? 'Working...' : 'Create draft'}
          </button>
        </form>
      </section>

      <div className="studioLayout">

        {/* Course list */}
        <aside className="panel studioList">
          <h2>
            Your courses <small>({courses.length})</small>
          </h2>

          {courses.map(course => (
            <button
              key={course._id}
              className={`studioCourse ${
                active?._id === course._id ? 'selected' : ''
              }`}
              onClick={() => selectCourse(course)}
              disabled={!!uploading || busy}
            >
              <b>{course.title}</b>

              <span>
                {course.published ? 'Published' : 'Draft'}
                {' · '}
                {course.lessons?.length || 0} lessons
              </span>
            </button>
          ))}

          {!courses.length && (
            <p className="muted">
              No courses yet. Create your first draft.
            </p>
          )}
        </aside>

        {/* Course editor */}
        <section className="panel studioEditor">

          {!active ? (
            <div className="empty">
              Select or create a course to start editing.
            </div>
          ) : (
            <>
              <div className="editorTitle">
                <div>
                  <span className="eyebrow">
                    COURSE DETAILS
                  </span>

                  <h2>{active.title}</h2>
                </div>

                <span
                  className={`statusPill ${
                    active.published ? 'published' : ''
                  }`}
                >
                  {active.published ? 'Published' : 'Draft'}
                </span>
              </div>

              {/* Edit course */}
              <form
                className="studioForm"
                onSubmit={saveCourse}
              >
                <input
                  required
                  minLength={3}
                  maxLength={180}
                  placeholder="Course title"
                  value={form.title}
                  onChange={e =>
                    setForm({
                      ...form,
                      title: e.target.value
                    })
                  }
                />

                <input
                  maxLength={100}
                  placeholder="Category"
                  value={form.category}
                  onChange={e =>
                    setForm({
                      ...form,
                      category: e.target.value
                    })
                  }
                />

                <textarea
                  maxLength={10000}
                  placeholder="Course description"
                  value={form.description}
                  onChange={e =>
                    setForm({
                      ...form,
                      description: e.target.value
                    })
                  }
                />

                <label>
                  Price (₹)
                  <input
                    type="number"
                    min="0"
                    max="10000000"
                    step="0.01"
                    required
                    value={form.priceRupees}
                    onChange={e =>
                      setForm({
                        ...form,
                        priceRupees: e.target.value
                      })
                    }
                  />
                </label>

                <button
                  className="primary"
                  disabled={busy || !!uploading}
                >
                  Save course
                </button>
              </form>

              {/* Lessons */}
              <div className="lessonHeader">
                <h2>
                  Lessons
                  {' '}
                  <small>
                    ({active.lessons?.length || 0})
                  </small>
                </h2>
              </div>

              <div className="studioLessons">
                {(active.lessons || []).map((lesson, index) => (
                  <article
                    className="studioLesson"
                    key={lesson._id}
                  >
                    <div className="lessonTitle">
                      <b>
                        {index + 1}. {lesson.title}
                      </b>

                      <span
                        className={`statusPill ${
                          lesson.videoStatus === 'ready'
                            ? 'published'
                            : ''
                        }`}
                      >
                        {lesson.videoStatus || 'missing'}
                      </span>
                    </div>

                    {lesson.description && (
                      <p className="muted">
                        {lesson.description}
                      </p>
                    )}

                    {lesson.videoUrl &&
                      lesson.videoStatus === 'ready' && (
                        <small className="readyText">
                          Video ready for playback
                        </small>
                      )}

                    <div className="uploadRow">
                      <input
                        type="file"
                        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                        disabled={!!uploading || busy}
                        onChange={e => {
                          files.current[lesson._id] =
                            e.target.files?.[0] || null;
                        }}
                      />

                      <button
                        type="button"
                        className="small"
                        disabled={!!uploading || busy}
                        onClick={() => upload(lesson)}
                      >
                        {uploading === lesson._id
                          ? 'Uploading / processing...'
                          : 'Upload video'}
                      </button>

                      <button
                        type="button"
                        className="small danger"
                        disabled={!!uploading || busy}
                        onClick={() => removeLesson(lesson)}
                      >
                        Remove
                      </button>
                    </div>

                    <small className="muted">
                      MP4, MOV, or WebM · Maximum 2 GB
                      · Upload authorization expires in 10 minutes
                    </small>
                  </article>
                ))}

                {!active.lessons?.length && (
                  <p className="muted">
                    Add your first lesson below.
                  </p>
                )}
              </div>

              {/* Add lesson */}
              <form
                className="studioForm addLessonForm"
                onSubmit={addLesson}
              >
                <h3>Add a lesson</h3>

                <input
                  required
                  minLength={2}
                  maxLength={180}
                  placeholder="Lesson title"
                  value={newLesson.title}
                  onChange={e =>
                    setNewLesson({
                      ...newLesson,
                      title: e.target.value
                    })
                  }
                />

                <textarea
                  maxLength={4000}
                  placeholder="Lesson description (optional)"
                  value={newLesson.description}
                  onChange={e =>
                    setNewLesson({
                      ...newLesson,
                      description: e.target.value
                    })
                  }
                />

                <button
                  className="primary"
                  disabled={busy || !!uploading}
                >
                  Add lesson
                </button>
              </form>

              {/* Publishing */}
              <div className="publishRow">
                <p className="muted">
                  Publishing requires one or more lessons
                  with processed videos.
                </p>

                {active.published ? (
                  <button
                    type="button"
                    className="small"
                    disabled={busy || !!uploading}
                    onClick={unpublish}
                  >
                    Unpublish
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      busy ||
                      !!uploading ||
                      !active.lessons?.length ||
                      active.lessons.some(
                        lesson =>
                          lesson.videoStatus !== 'ready' ||
                          !lesson.videoUrl
                      )
                    }
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

      <p className="muted studioFootnote">
        For production, configure a private S3 bucket,
        narrowly scoped IAM access, bucket CORS,
        CloudFront access controls, and lifecycle cleanup
        for unneeded source files.
      </p>
    </main>
  );
}
