import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(dir, '..', 'assets');
const INK = '#2b2b2b', SOFT = '#5a5a5a';

// ---- decorative corner flourish (drawn in local coordinates, mirrored per corner) ----
function spiral(doc, cx, cy, r0, r1, turns, start = 0, dir = 1) {
  const steps = Math.round(turns * 40);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, a = start + dir * t * turns * Math.PI * 2, r = r0 + (r1 - r0) * (1 - t);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? doc.lineTo(x, y) : doc.moveTo(x, y);
  }
  doc.stroke();
}
function leaf(doc, x, y, len, angle) {
  doc.save().translate(x, y).rotate(angle);
  doc.moveTo(0, 0).bezierCurveTo(len * 0.3, -len * 0.38, len * 0.75, -len * 0.3, len, 0)
     .bezierCurveTo(len * 0.75, len * 0.3, len * 0.3, len * 0.38, 0, 0).stroke();
  doc.restore();
}
function corner(doc, x, y, sx, sy) {
  doc.save().translate(x, y).scale(sx, sy).lineWidth(1).strokeColor(INK).fillColor(INK);
  doc.moveTo(0, 0).lineTo(112, 0).stroke();           // top rule
  doc.moveTo(0, 0).lineTo(0, 92).stroke();            // side rule
  spiral(doc, 30, 30, 1.5, 21, 2.1, 0.4, 1);
  spiral(doc, 66, 15, 1.2, 12, 1.8, 2.8, -1);
  spiral(doc, 14, 64, 1.2, 12, 1.8, -0.5, 1);
  spiral(doc, 52, 44, 1, 8, 1.5, 1.2, -1);
  doc.moveTo(38, 14).bezierCurveTo(52, 2, 78, 4, 96, 14).stroke();
  doc.moveTo(14, 42).bezierCurveTo(4, 56, 6, 78, 16, 92).stroke();
  leaf(doc, 42, 40, 22, 0.8); leaf(doc, 22, 52, 18, 1.9); leaf(doc, 60, 28, 16, 0.2); leaf(doc, 84, 10, 14, 0.1); leaf(doc, 8, 80, 14, 1.5);
  for (const [cx, cy] of [[30, 30], [66, 15], [14, 64], [52, 44]]) doc.circle(cx, cy, 1.6).fill();
  doc.restore();
}

function fit(doc, text, font, size, maxWidth, min = 10) {
  doc.font(font);
  let s = size;
  while (s > min) { doc.fontSize(s); if (doc.widthOfString(text) <= maxWidth) break; s -= 1; }
  doc.fontSize(s);
  return s;
}
const centered = (doc, text, y, W) => doc.text(text, 0, y, { width: W, align: 'center', lineBreak: false });

/**
 * Draws the certificate onto an A4-landscape pdfkit document (margin 0).
 * data: {studentName, courseTitle, instructorName, awardedOn(Date), certificateId, verifyUrl, qr(Buffer|null),
 *        lessonsTotal, quizAverage(number|null)}
 */
export function renderCertificate(doc, data) {
  const W = doc.page.width, H = doc.page.height, cx = W / 2;
  doc.registerFont('Title', path.join(ASSETS, 'fonts/pinyon-script-latin-400-normal.woff'));
  doc.registerFont('Name', path.join(ASSETS, 'fonts/dancing-script-latin-600-normal.woff'));
  doc.registerFont('Body', path.join(ASSETS, 'fonts/raleway-latin-400-normal.woff'));
  doc.registerFont('BodyBold', path.join(ASSETS, 'fonts/raleway-latin-600-normal.woff'));

  doc.rect(0, 0, W, H).fill('#ffffff');
  // double frame
  doc.lineWidth(5).strokeColor(INK).rect(16, 16, W - 32, H - 32).stroke();
  doc.lineWidth(1).strokeColor(INK).rect(30, 30, W - 60, H - 60).stroke();
  const m = 44;
  corner(doc, m, m, 1, 1); corner(doc, W - m, m, -1, 1); corner(doc, m, H - m, 1, -1); corner(doc, W - m, H - m, -1, -1);

  // title
  doc.fillColor(INK); fit(doc, 'Certificate of Completion', 'Title', 58, W - 240); centered(doc, 'Certificate of Completion', 82, W);

  doc.fillColor(INK).font('Body').fontSize(13); centered(doc, 'This certifies that', 178, W);

  // recipient
  const nameSize = fit(doc, data.studentName, 'Name', 40, 470, 18);
  doc.fillColor(INK); centered(doc, data.studentName, 202, W);
  const nameW = Math.min(doc.widthOfString(data.studentName) + 60, 520);
  const ly = 202 + nameSize * 1.25;
  doc.lineWidth(0.9).strokeColor(INK).moveTo(cx - nameW / 2, ly).lineTo(cx + nameW / 2, ly).stroke();

  doc.fillColor(INK).font('Body').fontSize(13); centered(doc, 'has successfully completed the course', ly + 22, W);
  fit(doc, data.courseTitle, 'BodyBold', 21, W - 220, 12); centered(doc, data.courseTitle, ly + 46, W);

  const score = data.quizAverage != null ? ` and passed every assessment with an average score of ${Math.round(data.quizAverage)}%` : '';
  const body = `Offered on LearnLive and taught by ${data.instructorName || 'our instructor'}. The learner completed all ${data.lessonsTotal} lesson${data.lessonsTotal === 1 ? '' : 's'}${score}. We congratulate them on their dedication and wish them every success in their learning journey.`;
  doc.fillColor(SOFT).font('Body').fontSize(11.5).text(body, 150, ly + 84, { width: W - 300, align: 'center', lineGap: 4 });

  const dateText = new Date(data.awardedOn).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.fillColor(INK).font('Body').fontSize(13); centered(doc, `Awarded on ${dateText}`, 404, W);

  // bottom: date (left), QR (centre), signature (right)
  const lineY = 498;
  doc.lineWidth(1).strokeColor(INK);
  doc.moveTo(105, lineY).lineTo(285, lineY).stroke();
  doc.fillColor(INK).font('Body').fontSize(11.5).text(dateText, 105, lineY - 20, { width: 180, align: 'center', lineBreak: false });
  doc.fillColor(SOFT).fontSize(12).text('Date', 105, lineY + 6, { width: 180, align: 'center', lineBreak: false });

  const sx0 = W - 285, sw = 180, sigW = 140, sigH = sigW * 369 / 900;
  doc.image(path.join(ASSETS, 'signature.png'), sx0 + (sw - sigW) / 2, lineY - sigH - 2, { width: sigW });
  doc.moveTo(sx0, lineY).lineTo(sx0 + sw, lineY).stroke();
  doc.fillColor(SOFT).font('Body').fontSize(12).text('Authorized Signatory', sx0, lineY + 6, { width: sw, align: 'center', lineBreak: false });

  if (data.qr) doc.image(data.qr, cx - 30, 448, { width: 60, height: 60 });
  doc.fillColor(SOFT).font('Body').fontSize(8.5);
  centered(doc, `Certificate ID: ${data.certificateId}`, 514, W);
  doc.fontSize(7.5); centered(doc, `Verify at ${data.verifyUrl}`, 526, W);
}
