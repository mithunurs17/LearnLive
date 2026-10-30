import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Verify({ certId }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    api.get(`/certificates/verify/${encodeURIComponent(certId)}`)
      .then(r => live && setState({ data: r.data }))
      .catch(e => live && setState({ data: e.response?.data || { valid: false, error: 'Could not reach the verification service' } }));
    return () => { live = false; };
  }, [certId]);
  const d = state.data;
  return <main className="shell verifyPage">
    <span className="eyebrow">CERTIFICATE VERIFICATION</span>
    <h1>Verify a LearnLive certificate</h1>
    <p className="muted">Certificate ID <b>{certId}</b></p>
    {state.loading && <p className="muted">Checking…</p>}
    {d?.valid && <section className="panel verifyCard ok" role="status">
      <div className="verifyBadge">✓ Valid certificate</div>
      <dl><dt>Awarded to</dt><dd>{d.studentName}</dd>
        <dt>Course</dt><dd>{d.courseTitle}</dd>
        {d.instructorName && <><dt>Instructor</dt><dd>{d.instructorName}</dd></>}
        <dt>Issued on</dt><dd>{new Date(d.issuedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</dd></dl>
      <p className="muted">This certificate was issued by LearnLive after the learner completed every lesson and passed all quizzes.</p>
    </section>}
    {d && !d.valid && <section className="panel verifyCard bad" role="alert"><div className="verifyBadge">✕ {d.revoked ? 'Certificate revoked' : 'Not a valid certificate'}</div>
      <p>{d.error || 'We could not find a certificate with this ID.'} Check the ID printed on the certificate and try again.</p></section>}
    <Link to="/" className="small">← Back to LearnLive</Link>
  </main>;
}
