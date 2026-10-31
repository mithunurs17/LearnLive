import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const rupees = paise => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });
const notify = (message, type = 'info') =>
  window.dispatchEvent(new CustomEvent('learnlive:toast', { detail: { id: Date.now() + Math.random(), message, type } }));

// Student purchase history with self-service refunds (only shown once the student has paid for something).
export default function PaymentHistory() {
  const [payments, setPayments] = useState([]);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try { setPayments((await api.get('/payments/mine')).data.payments || []); } catch { /* history is optional UI */ }
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('learnlive:enrollments-updated', load);
    return () => window.removeEventListener('learnlive:enrollments-updated', load);
  }, [load]);

  async function refund(p) {
    if (!window.confirm(`Refund ${rupees(p.amountPaise)} for “${p.courseTitle}”? You will lose access to the course.`)) return;
    setBusyId(p.id);
    try {
      await api.post(`/payments/${p.id}/refund`, { reason: 'Requested by student' });
      notify('Refund initiated. Razorpay usually credits it to your original payment method in 5–7 working days.', 'success');
      window.dispatchEvent(new CustomEvent('learnlive:enrollments-updated'));
    } catch (e) {
      notify(e.response?.data?.error || e.message, 'error');
    } finally {
      setBusyId('');
      load();
    }
  }

  if (!payments.length) return null;
  return (
    <div className="paymentHistory">
      <h3>Payments &amp; refunds</h3>
      {payments.map(p => (
        <div className="adminRow" key={p.id}>
          <div>
            <b>{p.courseTitle}</b>
            <p>
              {rupees(p.amountPaise)} · {new Date(p.paidAt).toLocaleDateString('en-IN')}
              {p.refundedPaise > 0 && ` · refunded ${rupees(p.refundedPaise)}`}
            </p>
            <small>
              {p.status === 'refunded'
                ? `Refunded${p.refunds.some(r => r.status === 'pending') ? ' (credit pending)' : ''}`
                : p.refundEligible ? p.refundNote : `Paid · ${p.refundNote}`}
            </small>
          </div>
          {p.refundEligible && (
            <button className="small" disabled={busyId === p.id} onClick={() => refund(p)}>
              {busyId === p.id ? 'Refunding…' : 'Request refund'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
