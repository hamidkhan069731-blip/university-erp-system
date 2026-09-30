// University backend: Express + PostgreSQL. Express 5 forwards async errors to the error handler for us.
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // return DATE columns as 'YYYY-MM-DD' text, not JS timestamps

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) { console.error('Set JWT_SECRET (32+ characters) in .env'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const app = express();
// Inline scripts are allowed only because the demo page uses them. Move JS to files, then remove 'unsafe-inline'.
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  'script-src': ["'self'", "'unsafe-inline'"], 'style-src': ["'self'", "'unsafe-inline'"], 'upgrade-insecure-requests': null } } }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '../public')));

const limit = max => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false });
const q = (sql, params) => pool.query(sql, params).then(r => r.rows);

// Sign-in check. auth('admin') allows only admins; auth() allows any signed-in user.
const auth = (...roles) => (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), SECRET);
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Not allowed' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please sign in' }); }
};
const bad = (res, msg) => res.status(400).json({ error: msg });
const studentId = '(SELECT id FROM students WHERE user_id = $1)';

/* ---------- Public ---------- */
app.get('/api/programs', async (req, res) => {
  res.json(await q(`SELECT p.id, p.name, p.level, p.duration_years, f.name AS faculty
                    FROM programs p JOIN faculties f ON f.id = p.faculty_id ORDER BY p.id`));
});

const appSchema = z.object({
  full_name: z.string().trim().min(2).max(100),
  email: z.email().max(120),
  phone: z.string().regex(/^[0-9+\-\s]{7,20}$/),
  program_id: z.number().int().positive(),
  last_qualification: z.string().max(60).optional(),
  marks_percent: z.number().min(0).max(100),
});
app.post('/api/applications', limit(20), async (req, res) => {
  const p = appSchema.safeParse(req.body);
  if (!p.success) return bad(res, 'Please check the form: name, email, phone, program and marks are required.');
  const d = p.data;
  try {
    const [row] = await q(
      `INSERT INTO applications (application_no, full_name, email, phone, program_id, last_qualification, marks_percent)
       VALUES ('APP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('application_no_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6)
       RETURNING application_no`,
      [d.full_name, d.email.toLowerCase(), d.phone, d.program_id, d.last_qualification || null, d.marks_percent]);
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23503') return bad(res, 'That program does not exist.');
    throw e;
  }
});

app.post('/api/login', limit(10), async (req, res) => {
  const p = z.object({ email: z.email(), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!p.success) return bad(res, 'Enter a valid email and password.');
  const [u] = await q('SELECT id, password_hash, role, full_name FROM users WHERE email = $1', [p.data.email.toLowerCase()]);
  // Compare against a dummy hash when the email is unknown, so response time does not reveal which emails exist.
  const ok = await bcrypt.compare(p.data.password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: 'Wrong email or password.' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '8h' }), role: u.role, name: u.full_name });
});

/* ---------- Admin ---------- */
app.get('/api/admin/applications', auth('admin'), async (req, res) => {
  res.json(await q(`SELECT a.application_no, a.full_name, a.email, a.phone, p.name AS program, a.marks_percent, a.status, a.submitted_at
                    FROM applications a JOIN programs p ON p.id = a.program_id ORDER BY a.id DESC LIMIT 200`));
});
app.patch('/api/admin/applications/:no', auth('admin'), async (req, res) => {
  const p = z.object({ status: z.enum(['submitted', 'under_review', 'accepted', 'rejected']) }).safeParse(req.body);
  if (!p.success) return bad(res, 'Unknown status.');
  const rows = await q('UPDATE applications SET status = $1 WHERE application_no = $2 RETURNING application_no, status', [p.data.status, req.params.no]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'Application not found.' });
});
app.get('/api/admin/requests', auth('admin'), async (req, res) => {
  res.json(await q(`SELECT r.request_no, u.full_name AS student, s.roll_no, r.request_type, r.details, r.status, r.submitted_at
                    FROM requests r JOIN students s ON s.id = r.student_id JOIN users u ON u.id = s.user_id
                    ORDER BY r.id DESC LIMIT 200`));
});
app.patch('/api/admin/requests/:no', auth('admin'), async (req, res) => {
  const p = z.object({ status: z.enum(['submitted', 'under_review', 'approved', 'rejected']) }).safeParse(req.body);
  if (!p.success) return bad(res, 'Unknown status.');
  const rows = await q('UPDATE requests SET status = $1 WHERE request_no = $2 RETURNING request_no, status', [p.data.status, req.params.no]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'Request not found.' });
});
app.get('/api/admin/tickets', auth('admin'), async (req, res) => {
  res.json(await q(`SELECT t.ticket_no, u.full_name AS student, t.subject, t.status, t.created_at
                    FROM support_tickets t JOIN students s ON s.id = t.student_id JOIN users u ON u.id = s.user_id
                    ORDER BY t.id DESC LIMIT 200`));
});
app.patch('/api/admin/tickets/:no', auth('admin'), async (req, res) => {
  const p = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
  if (!p.success) return bad(res, 'Unknown status.');
  const rows = await q('UPDATE support_tickets SET status = $1 WHERE ticket_no = $2 RETURNING ticket_no, status', [p.data.status, req.params.no]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'Ticket not found.' });
});
app.get('/api/admin/fees', auth('admin'), async (req, res) => {
  res.json(await q(`SELECT f.voucher_no, u.full_name AS student, t.name AS term, f.amount, f.due_on, f.status
                    FROM fee_vouchers f JOIN students s ON s.id = f.student_id JOIN users u ON u.id = s.user_id JOIN terms t ON t.id = f.term_id
                    ORDER BY f.id DESC LIMIT 200`));
});
app.post('/api/admin/notifications', auth('admin'), limit(30), async (req, res) => {
  const p = z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(1000) }).safeParse(req.body);
  if (!p.success) return bad(res, 'Title and body are required.');
  const [row] = await q('INSERT INTO notifications (title, body) VALUES ($1,$2) RETURNING id, title', [p.data.title, p.data.body]);
  res.status(201).json(row);
});

/* ---------- Student (each student sees only their own rows) ---------- */
app.get('/api/me/attendance', auth('student'), async (req, res) => {
  res.json(await q(`SELECT c.code, c.title, v.held::int, v.attended::int, v.percent::float FROM attendance_summary v
                    JOIN offerings o ON o.id = v.offering_id JOIN courses c ON c.id = o.course_id
                    WHERE v.student_id = ${studentId} ORDER BY c.code`, [req.user.id]));
});
app.get('/api/me/results', auth('student'), async (req, res) => {
  res.json(await q(`SELECT t.name AS term, c.code, c.title, c.credit_hours, e.marks, e.grade FROM enrollments e
                    JOIN offerings o ON o.id = e.offering_id JOIN courses c ON c.id = o.course_id JOIN terms t ON t.id = o.term_id
                    WHERE e.student_id = ${studentId} ORDER BY t.starts_on, c.code`, [req.user.id]));
});
app.get('/api/me/fees', auth('student'), async (req, res) => {
  res.json(await q(`SELECT f.voucher_no, t.name AS term, f.amount, f.due_on, f.status FROM fee_vouchers f
                    JOIN terms t ON t.id = f.term_id WHERE f.student_id = ${studentId} ORDER BY f.due_on`, [req.user.id]));
});
app.get('/api/me/profile', auth('student'), async (req, res) => {
  const [row] = await q(`SELECT u.full_name AS name, s.roll_no, p.name AS program, f.name AS faculty, s.admitted_term,
                          COALESCE(a.cgpa,0) AS cgpa, COALESCE(a.pass_credits,0) AS pass_credits, COALESCE(a.f_grades,0) AS f_grades,
                          adv.full_name AS advisor_name, adv.email AS advisor_email, sup.full_name AS supervisor_name
                         FROM students s JOIN users u ON u.id = s.user_id JOIN programs p ON p.id = s.program_id JOIN faculties f ON f.id = p.faculty_id
                         LEFT JOIN student_academic_summary a ON a.student_id = s.id
                         LEFT JOIN student_advisors sa ON sa.student_id = s.id
                         LEFT JOIN users adv ON adv.id = sa.advisor_id LEFT JOIN users sup ON sup.id = sa.supervisor_id
                         WHERE s.user_id = $1`, [req.user.id]);
  row ? res.json(row) : res.status(404).json({ error: 'Profile not found.' });
});
app.get('/api/me/timetable', auth('student'), async (req, res) => {
  res.json(await q(`SELECT c.code, c.title, tt.weekday, tt.starts_at, tt.ends_at, tt.room FROM timetable_slots tt
                    JOIN offerings o ON o.id = tt.offering_id JOIN courses c ON c.id = o.course_id
                    JOIN enrollments e ON e.offering_id = o.id WHERE e.student_id = ${studentId}
                    ORDER BY tt.weekday, tt.starts_at`, [req.user.id]));
});
app.get('/api/me/today', auth('student'), async (req, res) => {
  res.json(await q(`SELECT c.title, tt.starts_at, tt.ends_at, tt.room, tu.full_name AS faculty FROM timetable_slots tt
                    JOIN offerings o ON o.id = tt.offering_id JOIN courses c ON c.id = o.course_id JOIN users tu ON tu.id = o.teacher_id
                    JOIN enrollments e ON e.offering_id = o.id
                    WHERE e.student_id = ${studentId} AND tt.weekday = EXTRACT(ISODOW FROM CURRENT_DATE)::int - 1
                    ORDER BY tt.starts_at`, [req.user.id]));
});
app.get('/api/me/exam-slip', auth('student'), async (req, res) => {
  res.json(await q(`SELECT c.code, c.title, ex.exam_type, ex.held_on, ex.room FROM exam_schedule ex
                    JOIN offerings o ON o.id = ex.offering_id JOIN courses c ON c.id = o.course_id
                    JOIN enrollments e ON e.offering_id = o.id WHERE e.student_id = ${studentId}
                    ORDER BY ex.held_on`, [req.user.id]));
});
app.get('/api/me/transcript', auth('student'), async (req, res) => {
  res.json(await q(`SELECT t.name AS term, c.code, c.title, c.credit_hours, e.grade FROM enrollments e
                    JOIN offerings o ON o.id = e.offering_id JOIN courses c ON c.id = o.course_id JOIN terms t ON t.id = o.term_id
                    WHERE e.student_id = ${studentId} AND e.grade IS NOT NULL ORDER BY t.starts_on, c.code`, [req.user.id]));
});
app.get('/api/me/hostel', auth('student'), async (req, res) => {
  const [row] = await q(`SELECT hr.block, hr.room_no, ha.allocated_on FROM hostel_allocations ha
                         JOIN hostel_rooms hr ON hr.id = ha.room_id WHERE ha.student_id = ${studentId}`, [req.user.id]);
  res.json(row || null);
});
app.get('/api/notifications', auth(), async (req, res) => {
  res.json(await q('SELECT title, body, posted_at FROM notifications ORDER BY posted_at DESC LIMIT 20'));
});

const REQUEST_TYPES = ['Alternative Course', 'Retest', 'Course Drop', 'I-Grade Request', 'Defer Term', 'Term Resume', 'Final Degree'];
app.get('/api/me/requests', auth('student'), async (req, res) => {
  res.json(await q(`SELECT request_no, request_type, details, status, submitted_at FROM requests
                    WHERE student_id = ${studentId} ORDER BY id DESC`, [req.user.id]));
});
app.post('/api/me/requests', auth('student'), limit(30), async (req, res) => {
  const p = z.object({ request_type: z.enum(REQUEST_TYPES), details: z.string().max(500).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, 'Choose a valid request type.');
  const [row] = await q(
    `INSERT INTO requests (request_no, student_id, request_type, details)
     VALUES ('REQ-' || lpad(nextval('request_no_seq')::text, 4, '0'), ${studentId}, $2, $3) RETURNING request_no, status`,
    [req.user.id, p.data.request_type, p.data.details || null]);
  res.status(201).json(row);
});
app.get('/api/me/tickets', auth('student'), async (req, res) => {
  res.json(await q(`SELECT ticket_no, subject, status, created_at FROM support_tickets
                    WHERE student_id = ${studentId} ORDER BY id DESC`, [req.user.id]));
});
app.post('/api/me/tickets', auth('student'), limit(30), async (req, res) => {
  const p = z.object({ subject: z.string().trim().min(3).max(150) }).safeParse(req.body);
  if (!p.success) return bad(res, 'Enter a subject (3-150 characters).');
  const [row] = await q(
    `INSERT INTO support_tickets (ticket_no, student_id, subject)
     VALUES ('TCK-' || lpad(nextval('ticket_no_seq')::text, 4, '0'), ${studentId}, $2) RETURNING ticket_no, status`,
    [req.user.id, p.data.subject]);
  res.status(201).json(row);
});

/* ---------- Faculty ---------- */
// A teacher may only touch their own offerings (admins may touch all).
async function owns(req, id) {
  const [o] = await q('SELECT teacher_id FROM offerings WHERE id = $1', [id]);
  return o && (req.user.role === 'admin' || o.teacher_id === req.user.id);
}
app.get('/api/faculty/offerings', auth('faculty', 'admin'), async (req, res) => {
  res.json(await q(`SELECT o.id, c.code, c.title, t.name AS term FROM offerings o
                    JOIN courses c ON c.id = o.course_id JOIN terms t ON t.id = o.term_id
                    WHERE $2 OR o.teacher_id = $1 ORDER BY t.starts_on DESC, c.code`, [req.user.id, req.user.role === 'admin']));
});
app.get('/api/faculty/offerings/:id/students', auth('faculty', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !(await owns(req, id))) return res.status(403).json({ error: 'Not allowed' });
  res.json(await q(`SELECT s.id AS student_id, s.roll_no, u.full_name FROM enrollments e
                    JOIN students s ON s.id = e.student_id JOIN users u ON u.id = s.user_id
                    WHERE e.offering_id = $1 ORDER BY s.roll_no`, [id]));
});
const markSchema = z.object({
  offering_id: z.number().int().positive(),
  held_on: z.iso.date(),
  marks: z.array(z.object({ student_id: z.number().int().positive(), present: z.boolean() })).min(1).max(500),
});
app.post('/api/faculty/attendance', auth('faculty', 'admin'), async (req, res) => {
  const p = markSchema.safeParse(req.body);
  if (!p.success) return bad(res, 'Send offering_id, held_on (YYYY-MM-DD) and marks.');
  const { offering_id, held_on, marks } = p.data;
  if (!(await owns(req, offering_id))) return res.status(403).json({ error: 'Not allowed' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(
      'INSERT INTO class_sessions (offering_id, held_on) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [offering_id, held_on]);
    if (!s.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Attendance for that day is already saved.' }); }
    // The join keeps only students really enrolled in this course.
    const r = await client.query(
      `INSERT INTO attendance (session_id, student_id, present)
       SELECT $1, u.sid, u.pr FROM unnest($2::int[], $3::bool[]) AS u(sid, pr)
       JOIN enrollments e ON e.student_id = u.sid AND e.offering_id = $4`,
      [s.rows[0].id, marks.map(m => m.student_id), marks.map(m => m.present), offering_id]);
    await client.query('COMMIT');
    res.status(201).json({ saved: r.rowCount });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

const gradeSchema = z.object({
  offering_id: z.number().int().positive(),
  marks: z.array(z.object({ student_id: z.number().int().positive(), marks: z.number().min(0).max(100) })).min(1).max(500),
});
app.post('/api/faculty/results', auth('faculty', 'admin'), async (req, res) => {
  const p = gradeSchema.safeParse(req.body);
  if (!p.success) return bad(res, 'Send offering_id and marks for each student.');
  const { offering_id, marks } = p.data;
  if (!(await owns(req, offering_id))) return res.status(403).json({ error: 'Not allowed' });
  const grade = m => m >= 85 ? 'A' : m >= 80 ? 'A-' : m >= 75 ? 'B+' : m >= 70 ? 'B' : m >= 65 ? 'B-' : m >= 60 ? 'C+' : m >= 55 ? 'C' : m >= 50 ? 'D' : 'F';
  const r = await q(
    `UPDATE enrollments e SET marks = u.mk, grade = u.gr FROM unnest($1::int[], $2::numeric[], $3::text[]) AS u(sid, mk, gr)
     WHERE e.student_id = u.sid AND e.offering_id = $4 RETURNING e.id`,
    [marks.map(m => m.student_id), marks.map(m => m.marks), marks.map(m => grade(m.marks)), offering_id]);
  res.json({ updated: r.length });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
