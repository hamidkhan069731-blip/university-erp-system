-- PostgreSQL starter schema for a university system.
-- Run: createdb uni && psql -d uni -f university_schema.sql

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- store bcrypt/argon2 hashes, never plain passwords
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('applicant','student','faculty','accountant','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campuses  (id SERIAL PRIMARY KEY, name TEXT NOT NULL, city TEXT);
CREATE TABLE faculties (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE programs (
  id SERIAL PRIMARY KEY,
  faculty_id INT NOT NULL REFERENCES faculties(id),
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('ADP','Undergraduate','Postgraduate','PhD')),
  duration_years NUMERIC(3,1) NOT NULL,
  UNIQUE (name, level)
);

-- Admissions (the website form writes here)
CREATE TABLE applications (
  id SERIAL PRIMARY KEY,
  application_no TEXT UNIQUE NOT NULL,      -- e.g. APP-2026-0001
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  program_id INT NOT NULL REFERENCES programs(id),
  last_qualification TEXT,
  marks_percent NUMERIC(5,2) CHECK (marks_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','accepted','rejected')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- People
CREATE TABLE students (
  id SERIAL PRIMARY KEY,
  user_id INT UNIQUE NOT NULL REFERENCES users(id),
  roll_no TEXT UNIQUE NOT NULL,
  program_id INT NOT NULL REFERENCES programs(id),
  campus_id INT REFERENCES campuses(id),
  admitted_term TEXT
);
CREATE TABLE faculty_members (
  user_id INT PRIMARY KEY REFERENCES users(id),
  faculty_id INT REFERENCES faculties(id),
  designation TEXT
);

-- Teaching
CREATE TABLE terms   (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, starts_on DATE, ends_on DATE);
CREATE TABLE courses (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, credit_hours INT NOT NULL CHECK (credit_hours > 0));
CREATE TABLE offerings (                     -- a course taught in a term by a teacher
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id),
  term_id INT NOT NULL REFERENCES terms(id),
  teacher_id INT NOT NULL REFERENCES users(id),
  UNIQUE (course_id, term_id, teacher_id)
);
CREATE TABLE enrollments (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id),
  offering_id INT NOT NULL REFERENCES offerings(id),
  marks NUMERIC(5,2) CHECK (marks BETWEEN 0 AND 100),
  grade TEXT,
  UNIQUE (student_id, offering_id)
);

-- Attendance: one session per class, one row per student
CREATE TABLE class_sessions (
  id SERIAL PRIMARY KEY,
  offering_id INT NOT NULL REFERENCES offerings(id),
  held_on DATE NOT NULL,
  UNIQUE (offering_id, held_on)             -- stops double-marking on the same day
);
CREATE TABLE attendance (
  session_id INT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id),
  present BOOLEAN NOT NULL,
  PRIMARY KEY (session_id, student_id)
);

-- Fees
CREATE TABLE fee_vouchers (
  id SERIAL PRIMARY KEY,
  voucher_no TEXT UNIQUE NOT NULL,
  student_id INT NOT NULL REFERENCES students(id),
  term_id INT NOT NULL REFERENCES terms(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  due_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','overdue'))
);
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  voucher_id INT NOT NULL REFERENCES fee_vouchers(id),
  paid_amount NUMERIC(12,2) NOT NULL CHECK (paid_amount > 0),
  method TEXT,
  reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Website content
CREATE TABLE news (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  published_on DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Indexes for the screens people open most
CREATE INDEX idx_enroll_student ON enrollments(student_id);
CREATE INDEX idx_att_student    ON attendance(student_id);
CREATE INDEX idx_vouch_student  ON fee_vouchers(student_id, status);
CREATE INDEX idx_app_status     ON applications(status);

-- Attendance percentage per student per course (the student portal reads this)
CREATE VIEW attendance_summary AS
SELECT s.offering_id, a.student_id,
       COUNT(*) AS held,
       COUNT(*) FILTER (WHERE a.present) AS attended,
       ROUND(100.0 * COUNT(*) FILTER (WHERE a.present) / COUNT(*), 1) AS percent
FROM attendance a
JOIN class_sessions s ON s.id = a.session_id
GROUP BY s.offering_id, a.student_id;

-- Used to build application numbers like APP-2026-0001
CREATE SEQUENCE application_no_seq;

-- ===== New modules =====

-- Weekly class schedule (feeds Time Table and Today's Classes)
CREATE TABLE timetable_slots (
  id SERIAL PRIMARY KEY,
  offering_id INT NOT NULL REFERENCES offerings(id),
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Mon
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  room TEXT
);

-- Exam schedule (feeds Print Exam Slip)
CREATE TABLE exam_schedule (
  id SERIAL PRIMARY KEY,
  offering_id INT NOT NULL REFERENCES offerings(id),
  exam_type TEXT NOT NULL DEFAULT 'final' CHECK (exam_type IN ('midterm','final')),
  held_on DATE NOT NULL,
  room TEXT
);

-- Student requests (Alternative Course, Retest, Course Drop, I-Grade, Defer Term, Term Resume, Final Degree)
CREATE TABLE requests (
  id SERIAL PRIMARY KEY,
  request_no TEXT UNIQUE NOT NULL,
  student_id INT NOT NULL REFERENCES students(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('Alternative Course','Retest','Course Drop','I-Grade Request','Defer Term','Term Resume','Final Degree')),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','approved','rejected')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE request_no_seq;

-- Student Support Office tickets
CREATE TABLE support_tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  student_id INT NOT NULL REFERENCES students(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE ticket_no_seq;

-- Hostel
CREATE TABLE hostel_rooms (id SERIAL PRIMARY KEY, block TEXT NOT NULL, room_no TEXT NOT NULL, capacity INT NOT NULL DEFAULT 2);
CREATE TABLE hostel_allocations (
  id SERIAL PRIMARY KEY,
  student_id INT UNIQUE NOT NULL REFERENCES students(id),
  room_id INT NOT NULL REFERENCES hostel_rooms(id),
  allocated_on DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Notifications (policy announcements, admin-postable)
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Advisor / supervisor assignment (both are just staff users)
CREATE TABLE student_advisors (
  student_id INT PRIMARY KEY REFERENCES students(id),
  advisor_id INT REFERENCES users(id),
  supervisor_id INT REFERENCES users(id)
);

CREATE INDEX idx_req_student ON requests(student_id);
CREATE INDEX idx_tkt_student ON support_tickets(student_id);
CREATE INDEX idx_tt_offering ON timetable_slots(offering_id);

-- CGPA/credits summary per student (the dashboard reads this)
CREATE VIEW student_academic_summary AS
SELECT s.id AS student_id,
       COALESCE(SUM(c.credit_hours) FILTER (WHERE e.grade IS NOT NULL AND e.grade <> 'F'), 0) AS pass_credits,
       COUNT(*) FILTER (WHERE e.grade = 'F') AS f_grades,
       ROUND(COALESCE(SUM(c.credit_hours * CASE e.grade
              WHEN 'A' THEN 4 WHEN 'A-' THEN 3.67 WHEN 'B+' THEN 3.33 WHEN 'B' THEN 3
              WHEN 'B-' THEN 2.67 WHEN 'C+' THEN 2.33 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END)
         FILTER (WHERE e.grade IS NOT NULL), 0) / NULLIF(SUM(c.credit_hours) FILTER (WHERE e.grade IS NOT NULL), 0), 2) AS cgpa
FROM students s
LEFT JOIN enrollments e ON e.student_id = s.id
LEFT JOIN offerings o ON o.id = e.offering_id
LEFT JOIN courses c ON c.id = o.course_id
GROUP BY s.id;
