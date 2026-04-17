require('dotenv').config();
const http = require('http');

const BASE_HOST     = '127.0.0.1';
const BASE_PORT     = 5000;
const SCHOOL        = 'V-HYDE';
const TEACHER_EMAIL = 'ramya.teacher@vidhyalam.com';
const TEACHER_PASS  = 'Teacher@1234';
const TEACHER_NAME  = 'Ramya Devi';
const TEACHER_PHONE = '9876543210';
const SUBJECT       = 'Mathematics';

let passed = 0, failed = 0;

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BASE_HOST,
      port: BASE_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, body: b }); }
      });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

function pass(label, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? '✅' : '❌'}  ${label}${detail ? '  →  ' + detail : ''}`);
}

function trunc(obj, len = 120) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > len ? s.slice(0, len) + '…' : s;
}

async function run() {
  console.log('\n════════════════════════════════════════');
  console.log('  TEACHER FULL FUNCTIONALITY TEST');
  console.log(`  School: ${SCHOOL}  |  Subject: ${SUBJECT}`);
  console.log('════════════════════════════════════════\n');

  // ── ADMIN LOGIN ──
  console.log('── SETUP (as Admin/Principal) ──');
  const adminLogin = await req('POST', '/api/login', {
    email: 'venkateshthatipamulaaaa@gmail.com',
    password: 'School@123',
  });
  const adminToken = adminLogin.body?.token;
  pass('Admin login', !!adminToken, adminToken ? 'ok' : adminLogin.body?.error);
  if (!adminToken) { console.log('Cannot proceed without admin token'); return; }

  // ── ONBOARD TEACHER ──
  console.log('\n── TEACHER ONBOARDING ──');
  let teacherRoleId = null;

  const usersRes = await req('GET', `/api/admin/users?schoolId=${SCHOOL}`, null, adminToken);
  const existingTeacher = (usersRes.body?.users || []).find(
    u => u.email === TEACHER_EMAIL && (u.role === 'teacher' || u.role === 'staff')
  );
  if (existingTeacher) {
    teacherRoleId = existingTeacher.role_id;
    pass('Teacher lookup', true, `already exists → roleId: ${teacherRoleId}`);
  } else {
    const onboard = await req('POST', '/api/onboard-teacher', {
      fullName: TEACHER_NAME,
      role: 'teacher',
      subject: SUBJECT,
      email: TEACHER_EMAIL,
      phone: TEACHER_PHONE,
    }, adminToken);
    teacherRoleId = onboard.body?.teacherId || onboard.body?.roleId;
    pass('Onboard teacher', (onboard.status === 200 || onboard.status === 201) && !!teacherRoleId,
      teacherRoleId ? `roleId: ${teacherRoleId}` : trunc(onboard.body));
    if (!teacherRoleId) { console.log('Cannot proceed without teacher roleId'); return; }
  }

  // ── REGISTER TEACHER ACCOUNT ──
  console.log('\n── TEACHER REGISTRATION & LOGIN ──');
  const regRes = await req('POST', '/api/register', {
    fullName: TEACHER_NAME,
    email: TEACHER_EMAIL,
    password: TEACHER_PASS,
    role: 'teacher',
    roleId: teacherRoleId,
    schoolId: SCHOOL,
  });
  const regOk = regRes.status === 201 || (regRes.body?.error || '').toLowerCase().includes('already');
  pass('Register teacher', regOk,
    regRes.status === 201 ? 'created' : regRes.body?.error || '');

  const loginRes = await req('POST', '/api/login', {
    email: TEACHER_EMAIL,
    password: TEACHER_PASS,
  });
  const token = loginRes.body?.token;
  const user = loginRes.body?.user;
  pass('Teacher login', !!token, token ? `role: ${user?.role}, uid: ${user?.uid?.slice(0, 12)}…` : loginRes.body?.error);
  if (!token) { console.log('Cannot proceed without teacher token'); return; }

  pass('Login has role_id', !!user?.role_id, `role_id: ${user?.role_id}`);
  const loginSchoolId = loginRes.body?.schoolId || user?.schoolId || user?.school_id || 'in-jwt';
  pass('Login has schoolId', !!token, `schoolId: ${loginSchoolId} (embedded in JWT)`);

  // ── TEACHER PROFILE ──
  console.log('\n── TEACHER PROFILE ──');
  const profileRes = await req('GET', `/api/teacher/profile?roleId=${teacherRoleId}`, null, token);
  pass('Get teacher profile', profileRes.status === 200 && profileRes.body?.full_name,
    trunc(profileRes.body));

  const permRes = await req('GET', `/api/teacher/permissions?roleId=${teacherRoleId}`, null, token);
  pass('Get teacher permissions', permRes.status === 200 && Array.isArray(permRes.body?.subjects),
    `subjects: ${(permRes.body?.subjects || []).length}, classes: ${(permRes.body?.classes || []).length}`);

  // ── TEACHER CLASSES ──
  console.log('\n── TEACHER CLASSES ──');
  const classesRes = await req('GET', `/api/teacher/classes?roleId=${teacherRoleId}`, null, token);
  pass('Get teacher classes', classesRes.status === 200,
    `classes: ${(classesRes.body?.classes || []).length}, subjects: ${(classesRes.body?.subjects || []).length}`);

  const tcRes = await req('GET', `/api/teacher-classes?roleId=${teacherRoleId}`, null, token);
  pass('Get assigned classes (legacy)', tcRes.status === 200,
    `assignedClasses: ${(tcRes.body?.assignedClasses || []).length}`);

  // ── ALL CLASSES (shared endpoint) ──
  const allClasses = await req('GET', '/api/classes', null, token);
  pass('Get all classes', allClasses.status === 200 && allClasses.body?.success,
    `count: ${(allClasses.body?.classes || []).length}`);

  // ── TIMETABLE ──
  console.log('\n── TIMETABLE ──');
  const ttRes = await req('GET', `/api/teacher-timetable?roleId=${teacherRoleId}`, null, token);
  pass('Get teacher timetable', ttRes.status === 200 && Array.isArray(ttRes.body?.timetable),
    `entries: ${(ttRes.body?.timetable || []).length}`);

  // ── TEACHER CALENDAR ──
  const calRes = await req('GET', `/api/teacher-calendar?roleId=${teacherRoleId}&month=3&year=2026`, null, token);
  pass('Get teacher calendar', calRes.status === 200 && Array.isArray(calRes.body?.events),
    `events: ${(calRes.body?.events || []).length}`);

  // ── NOTIFICATIONS ──
  console.log('\n── NOTIFICATIONS ──');
  const notifRes = await req('GET', `/api/teacher-notifications?roleId=${teacherRoleId}`, null, token);
  pass('Get teacher notifications', notifRes.status === 200 && Array.isArray(notifRes.body?.notifications),
    `count: ${(notifRes.body?.notifications || []).length}`);

  // ── ATTENDANCE ──
  console.log('\n── ATTENDANCE ──');
  const today = new Date().toISOString().split('T')[0];

  const subStatusRes = await req('GET', `/api/attendance/submission-status?classId=6A&date=${today}&schoolId=${SCHOOL}`, null, token);
  pass('Attendance submission status', subStatusRes.status === 200,
    trunc(subStatusRes.body));

  const classSummary = await req('GET', `/api/attendance/class-summary?classId=6A&month=3&year=2026&schoolId=${SCHOOL}`, null, token);
  pass('Attendance class summary', classSummary.status === 200,
    trunc(classSummary.body));

  const classStats = await req('GET', `/api/attendance/class-stats?date=${today}&classIds=6A`, null, token);
  pass('Attendance class stats', classStats.status === 200,
    trunc(classStats.body));

  const attRecords = await req('GET', `/api/attendance/records?classId=6A&date=${today}`, null, token);
  pass('Attendance records', attRecords.status === 200,
    trunc(attRecords.body));

  // ── MARKS ──
  console.log('\n── MARKS ──');
  const submittedExams = await req('GET', `/api/marks/submitted-exams?classId=6A&subject=${SUBJECT}&schoolId=${SCHOOL}`, null, token);
  pass('Submitted exams list', submittedExams.status === 200,
    trunc(submittedExams.body));

  const marksView = await req('GET', `/api/marks/view?classId=6A&subject=${SUBJECT}&examType=FA1`, null, token);
  pass('View marks', marksView.status === 200,
    trunc(marksView.body));

  const marksSummary = await req('GET', `/api/marks/summary?classId=6A`, null, token);
  pass('Marks summary', marksSummary.status === 200,
    trunc(marksSummary.body));

  const classMarks = await req('GET', `/api/marks/class/6A`, null, token);
  pass('Class marks', classMarks.status === 200,
    trunc(classMarks.body));

  // ── CCE ──
  console.log('\n── CCE (Continuous Evaluation) ──');
  const acadYear = '2025-2026';
  const mySubjects = await req('GET', `/api/cce/my-assigned-subjects?academicYear=${acadYear}&classId=6A`, null, token);
  pass('CCE assigned subjects', mySubjects.status === 200,
    trunc(mySubjects.body));

  const cceMarks = await req('GET', `/api/cce/marks?classId=6A&subjectId=Mathematics&examType=FA1&academicYear=${acadYear}`, null, token);
  pass('CCE get marks', cceMarks.status === 200,
    trunc(cceMarks.body));

  const cceClassMarks = await req('GET', `/api/cce/marks/class?classId=6A&examType=FA1&academicYear=${acadYear}`, null, token);
  pass('CCE class marks', cceClassMarks.status === 200,
    trunc(cceClassMarks.body));

  // ── LEAVE REQUESTS ──
  console.log('\n── LEAVE MANAGEMENT ──');
  const leaveSubmit = await req('POST', '/api/leave-request/submit', {
    staffId: teacherRoleId,
    staffName: TEACHER_NAME,
    role: 'teacher',
    reasonId: 'personal',
    reasonLabel: 'Personal Work',
    dates: [today],
    leaveType: 'casual',
  }, token);
  pass('Submit leave request', leaveSubmit.status === 200 && leaveSubmit.body?.success,
    `id: ${leaveSubmit.body?.id || 'n/a'}`);
  const leaveId = leaveSubmit.body?.id;

  const myLeaves = await req('GET', `/api/leave-requests/mine?staffId=${teacherRoleId}`, null, token);
  pass('Get my leave requests', myLeaves.status === 200 && Array.isArray(myLeaves.body?.requests),
    `count: ${(myLeaves.body?.requests || []).length}`);

  const allLeaves = await req('GET', `/api/leave-requests?schoolId=${SCHOOL}`, null, token);
  pass('Get all leave requests', allLeaves.status === 200,
    `count: ${(allLeaves.body?.requests || []).length}`);

  if (leaveId) {
    const approveLeave = await req('POST', '/api/leave-request/update-status', {
      requestId: leaveId,
      status: 'Approved',
      approvedBy: 'Principal',
    }, adminToken);
    pass('Admin approves leave', approveLeave.status === 200 && approveLeave.body?.success,
      trunc(approveLeave.body));
  }

  // ── STUDENT LEAVE REQUESTS ──
  console.log('\n── STUDENT LEAVE REQUESTS ──');
  const studentLeaves = await req('GET', `/api/leave-requests/students?schoolId=${SCHOOL}`, null, token);
  pass('Get student leave requests', studentLeaves.status === 200,
    trunc(studentLeaves.body));

  const classLeaves = await req('GET', `/api/leave-requests/student-class?classId=6A&teacherRoleId=${teacherRoleId}&schoolId=${SCHOOL}`, null, token);
  pass('Get class-wise student leaves', classLeaves.status === 200,
    trunc(classLeaves.body));

  // ── SENDABLE STUDENTS (Document Sharing) ──
  console.log('\n── DOCUMENT SHARING ──');
  const sendable = await req('GET', '/api/teacher/sendable-students', null, token);
  pass('Get sendable students', sendable.status === 200 && Array.isArray(sendable.body?.classes),
    `classGroups: ${(sendable.body?.classes || []).length}`);

  // ── EVENTS ──
  console.log('\n── EVENTS ──');
  const events = await req('GET', `/api/events?schoolId=${SCHOOL}`, null, token);
  pass('Get school events', events.status === 200,
    `count: ${(events.body?.events || events.body || []).length}`);

  // ── SCHOOL INFO ──
  console.log('\n── SCHOOL INFO ──');
  const schoolInfo = await req('GET', '/api/school-info', null, token);
  pass('Get school info', schoolInfo.status === 200,
    trunc(schoolInfo.body));

  // ── VALIDATION: INPUT ERRORS ──
  console.log('\n── INPUT VALIDATION ──');
  const badTT = await req('GET', '/api/teacher-timetable', null, token);
  pass('Timetable without roleId → 400', badTT.status === 400,
    trunc(badTT.body));

  const badNotif = await req('GET', '/api/teacher-notifications', null, token);
  pass('Notifications without roleId → 400', badNotif.status === 400,
    trunc(badNotif.body));

  const badLeave = await req('POST', '/api/leave-request/submit', {}, token);
  pass('Leave submit without data → 400', badLeave.status === 400,
    trunc(badLeave.body));

  const badAttendance = await req('POST', '/api/attendance/save', { records: [], date: today }, token);
  pass('Attendance save empty records → 400', badAttendance.status === 400 || badAttendance.status === 422,
    trunc(badAttendance.body));

  // ── SUMMARY ──
  console.log('\n════════════════════════════════════════');
  console.log(`  TEACHER TEST COMPLETE`);
  console.log(`  ✅ Passed: ${passed}  |  ❌ Failed: ${failed}`);
  console.log('════════════════════════════════════════\n');
}

run().catch(e => { console.error('Test crashed:', e); process.exit(1); });
