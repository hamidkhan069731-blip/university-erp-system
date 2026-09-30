# University ERP (starter, working end to end)

Node.js + Express + PostgreSQL. Two pages are served:
- `public/index.html` — public website with program search and the online admissions form
- `public/portal.html` — the logged-in ERP: Student, Faculty and Admin, all reading and writing real data

## Run it (about 10 minutes)
1. Install Node.js 20+ and PostgreSQL 14+.
2. `createdb uni`
3. `psql -d uni -f db/schema.sql`
4. Copy `.env.example` to `.env`, fill in `DATABASE_URL`, and generate `JWT_SECRET` with the command written inside that file.
5. `npm install`
6. `npm run seed` — fills sample data and **prints one-time passwords for every account**. Copy them now; they are not shown again and are not stored anywhere in plain text.
7. `npm start`, then open `http://localhost:3000` for the website, or `http://localhost:3000/portal.html` to sign in.

## What's inside

**Student portal** — Dashboard (today's classes, attendance bars, CGPA, advisor/supervisor, notifications), Profile, Attendance, Results & Exams, Notifications, Enrollments, Requests (Alternative Course, Retest, Course Drop, I-Grade Request, Defer Term, Term Resume, Final Degree), Time Table, Student Support Office (tickets), Print Exam Slip, Transcript (print/PDF), Invoices, Hostel.

**Faculty portal** — My Classes, Mark Attendance (per course, per day — the same class can't be double-saved), Enter Results (auto-computes the letter grade).

**Admin portal** — Admissions Queue (accept/reject), Requests Queue (approve), Support Queue (close tickets), Fee Management (read-only overview), Post Notification.

**Public website** — program search, online application form that writes straight into the `applications` table.

Everything above is read from and saved to PostgreSQL through the API in `src/server.js` — nothing in the portal is sample/fake data once you've seeded and are running the server.

## API summary
See `src/server.js` for the full list — routes are grouped by role: `/api/me/*` (student, own data only), `/api/faculty/*` (own classes only), `/api/admin/*`.

## Already in place
Passwords hashed with bcrypt. Every query parameterised (no SQL injection). Inputs validated with zod. Login and write endpoints are rate-limited. A student can only ever read their own rows (enforced in SQL, not just in the UI). A teacher can only mark/grade their own courses, and only enrolled students. The same class can't be attendance-marked twice on one day. Content-Security-Policy via helmet.

## Before real students use it
- **This is a working starter, not a hardened production system.** Get a security review before storing real personal data (CNIC numbers, phone numbers, marks).
- Host behind HTTPS (a VPS with Caddy or nginx works) and set a strong, unique `JWT_SECRET` for that deployment.
- Take automatic database backups and test a restore.
- Move the pages' inline JavaScript into separate files, then remove `'unsafe-inline'` from the CSP in `src/server.js`.
- Add a real payment gateway for fees (currently vouchers are marked paid/unpaid only, no online payment).
- Add password reset / forgot-password flow (not included).
- Load-test before a deadline day (fee due dates, result day) — that's when traffic spikes.
- The seed data, sample emails and all names are fake. Never reuse seed passwords for a real account.
