import axios from 'axios';export const api=axios.create({baseURL:import.meta.env.VITE_API_URL||(import.meta.env.DEV?'/api':'http://localhost:4000/api')});api.interceptors.request.use(c=>{const token=localStorage.getItem('ll-token');if(token)c.headers.Authorization=`Bearer ${token}`;return c});

// ---- Razorpay Checkout (added) ----
let razorpayScript = null;
function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  razorpayScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { razorpayScript = null; s.remove(); reject(new Error('Could not load Razorpay Checkout. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return razorpayScript;
}

// Opens Razorpay Checkout for a paid course. Resolves with the verified enrollment,
// rejects with err.cancelled === true when the student simply closes the window.
export async function checkoutCourse(course, user) {
  await loadRazorpayScript();
  const { data } = await api.post('/payments/order', { courseId: course._id });
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: data.keyId,
      order_id: data.order.id,
      amount: data.order.amount,
      currency: data.order.currency,
      name: 'LearnLive',
      description: data.courseName,
      prefill: { name: user?.name, email: user?.email },
      handler: async response => {
        try {
          resolve((await api.post('/payments/verify', response)).data);
        } catch (e) {
          const err = new Error(e.response?.data?.error || 'Payment received, but confirmation is delayed. If money was deducted, your access is granted automatically within a few minutes.');
          err.pending = true;
          reject(err);
        }
      },
      // UPI first (QR / UPI ID / installed UPI apps); cards, netbanking and wallets stay available below it.
      // A dashboard checkout configuration (config_id) controls the payment-method layout when set; otherwise use the built-in one.
      ...(data.configId
        ? { config_id: data.configId }
        : { config: { display: { blocks: { upi: { name: 'Pay via UPI', instruments: [{ method: 'upi' }] } }, sequence: ['block.upi'], preferences: { show_default_blocks: true } } } }),
      retry: { enabled: true },
      timeout: 900,
      modal: { ondismiss: () => reject(Object.assign(new Error('Payment cancelled'), { cancelled: true })) }
    });
    // A failed attempt keeps the modal open so the student can retry, so we do not reject here.
    checkout.on('payment.failed', () => {});
    checkout.open();
  });
}
