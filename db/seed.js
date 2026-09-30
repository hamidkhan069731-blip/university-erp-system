// Fills an EMPTY database with sample data and prints one-time random passwords.
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Same order as the website's program list, so ids line up (1 = BS Computer Science).
const PROGRAMS = [
  ['Computer Science & IT', 'BS Computer Science', 'Undergraduate', 4], ['Computer Science & IT', 'BS Software Engineering', 'Undergraduate', 4], ['Computer Science & IT', 'MS Data Science', 'Postgraduate', 2],
  ['Business & Management', 'BBA (Hons)', 'Undergraduate', 4], ['Business & Management', 'MBA', 'Postgraduate', 2],
  ['Engineering & Technology', 'BSc Electrical Engineering', 'Undergraduate', 4], ['Engineering & Technology', 'BSc Civil Engineering', 'Undergraduate', 4],
  ['Law', 'LLB', 'Undergraduate', 5], ['Pharmacy', 'Pharm.D', 'Undergraduate', 5], ['Allied Health', 'Doctor of Physical Therapy', 'Undergraduate', 5],
  ['Art & Design', 'BFA Fine Arts', 'Undergraduate', 4], ['Social Sciences', 'BS Psychology', 'Undergraduate', 4], ['Sciences', 'BS Chemistry', 'Undergraduate', 4], ['Sciences', 'MS Chemistry', 'Postgraduate', 2],
];

(async () => {
  const db = await pool.connect();
  try {
    if ((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n > 0) { console.log('Database already has users. Seed skipped.'); return; }
    await db.query('BEGIN');
    const out = [];
    const user = async (email, name, role) => {
      const pw = crypto.randomBytes(6).toString('hex');
      const r = await db.query('INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [email, await bcrypt.hash(pw, 10), name, role]);
      out.push(role.padEnd(8) + ' ' + email + '  ' + pw);
      return r.rows[0].id;
    };
    for (const f of [...new Set(PROGRAMS.map(p => p[0]))]) await db.query('INSERT INTO faculties (name) VALUES ($1)', [f]);
    for (const p of PROGRAMS) await db.query('INSERT INTO programs (faculty_id, name, level, duration_years) VALUES ((SELECT id FROM faculties WHERE name=$1),$2,$3,$4)', p);
    await db.query("INSERT INTO campuses (name, city) VALUES ('Main campus', 'City')");
    const term = (await db.query("INSERT INTO terms (name, starts_on, ends_on) VALUES ('Fall 2026','2026-09-01','2027-01-15') RETURNING id")).rows[0].id;
    const c1 = (await db.query("INSERT INTO courses (code, title, credit_hours) VALUES ('CS101','Programming fundamentals',3) RETURNING id")).rows[0].id;
    const c2 = (await db.query("INSERT INTO courses (code, title, credit_hours) VALUES ('CS103','Introduction to ICT',3) RETURNING id")).rows[0].id;

    await user('admin@example.edu', 'Admin Demo', 'admin');
    const teacher = await user('teacher@example.edu', 'Teacher Demo', 'faculty');
    const offs = [];
    for (const c of [c1, c2]) offs.push((await db.query('INSERT INTO offerings (course_id, term_id, teacher_id) VALUES ($1,$2,$3) RETURNING id', [c, term, teacher])).rows[0].id);

    // Advisor and supervisor accounts, plus a graded result so CGPA shows on the dashboard
    const advisor = await user('advisor@example.edu', 'Aleena Aslam', 'faculty');
    const supervisor = await user('supervisor@example.edu', 'Jamil Durrani', 'faculty');

    const sids = [];
    for (let i = 1; i <= 3; i++) {
      const uid = await user('student' + i + '@example.edu', 'Student Demo ' + i, 'student');
      const sid = (await db.query("INSERT INTO students (user_id, roll_no, program_id, campus_id, admitted_term) VALUES ($1,$2,1,1,'Fall 2026') RETURNING id", [uid, 'DEMO-BSCS-F26-00' + i])).rows[0].id;
      sids.push(sid);
      for (const o of offs) await db.query('INSERT INTO enrollments (student_id, offering_id) VALUES ($1,$2)', [sid, o]);
      await db.query("INSERT INTO fee_vouchers (voucher_no, student_id, term_id, amount, due_on) VALUES ($1,$2,$3,90000,'2026-10-05')", ['V-26-000' + i, sid, term]);
      await db.query('INSERT INTO student_advisors (student_id, advisor_id, supervisor_id) VALUES ($1,$2,$3)', [sid, advisor, supervisor]);
    }
    // A finished term of grades for student 1, so CGPA and transcript are not empty
    await db.query("UPDATE enrollments SET marks = 88, grade = 'A' WHERE student_id = $1 AND offering_id = $2", [sids[0], offs[0]]);
    await db.query("UPDATE enrollments SET marks = 74, grade = 'B' WHERE student_id = $1 AND offering_id = $2", [sids[0], offs[1]]);

    // Timetable: two classes a week per offering
    await db.query('INSERT INTO timetable_slots (offering_id, weekday, starts_at, ends_at, room) VALUES ($1,0,\'08:00\',\'10:40\',\'Room 204\'),($1,2,\'08:00\',\'10:40\',\'Room 204\')', [offs[0]]);
    await db.query('INSERT INTO timetable_slots (offering_id, weekday, starts_at, ends_at, room) VALUES ($1,1,\'10:40\',\'13:20\',\'Room 110\'),($1,3,\'10:40\',\'13:20\',\'Room 110\')', [offs[1]]);
    // Final exam schedule
    await db.query("INSERT INTO exam_schedule (offering_id, exam_type, held_on, room) VALUES ($1,'final','2026-12-10','Room 204'),($2,'final','2026-12-12','Room 110')", [offs[0], offs[1]]);

    // Hostel: one room, one allocation
    const room = (await db.query("INSERT INTO hostel_rooms (block, room_no, capacity) VALUES ('Block A','A-101',2) RETURNING id")).rows[0].id;
    await db.query('INSERT INTO hostel_allocations (student_id, room_id) VALUES ($1,$2)', [sids[0], room]);

    // Notifications (policy-style announcements)
    await db.query(`INSERT INTO notifications (title, body) VALUES
      ('Attendance Policy', '80% attendance is required in every course. Falling below 75% by the exam cut-off means you cannot sit the final exam.'),
      ('Fee Deadline', 'The Fall 2026 voucher is due by 5 Oct 2026. A late fee applies automatically after the due date.'),
      ('Add/Drop Window', 'Course add/drop requests for the current term close two weeks after classes begin.')`);

    // A student support ticket and a request, so the lists aren't empty
    await db.query("INSERT INTO support_tickets (ticket_no, student_id, subject, status) VALUES ('TCK-0001',$1,'Transcript request','closed')", [sids[0]]);
    await db.query("INSERT INTO requests (request_no, student_id, request_type, status) VALUES ('REQ-0001',$1,'Retest','under_review')", [sids[0]]);
    // Sequences must start after the numbers used above, or the next real submission collides.
    await db.query("SELECT setval('request_no_seq', 1)");
    await db.query("SELECT setval('ticket_no_seq', 1)");

    // Three past classes for CS101; student 3 misses two of them.
    for (let d = 1; d <= 3; d++) {
      const s = (await db.query('INSERT INTO class_sessions (offering_id, held_on) VALUES ($1,$2) RETURNING id', [offs[0], '2026-09-0' + (d + 1)])).rows[0].id;
      for (let i = 0; i < sids.length; i++) await db.query('INSERT INTO attendance (session_id, student_id, present) VALUES ($1,$2,$3)', [s, sids[i], !(i === 2 && d < 3)]);
    }
    await db.query('COMMIT');
    console.log('Seed done. Save these passwords now, they are not stored anywhere else:\n\n' + out.join('\n'));
  } catch (e) { await db.query('ROLLBACK'); console.error(e); process.exitCode = 1; }
  finally { db.release(); await pool.end(); }
})();
