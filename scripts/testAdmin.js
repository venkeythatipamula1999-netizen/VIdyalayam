require('dotenv').config();
const http = require('http');

const BASE_HOST = '127.0.0.1';
const BASE_PORT = 5000;
const SCHOOL   = 'V-HYDE';

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data  = body ? JSON.stringify(body) : null;
    const opts  = {
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
      res.on('data', d => b += d);
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
  const icon = ok ? '✅' : '❌';
  console.log(`${icon}  ${label}${detail ? '  →  ' + detail : ''}`);
}

async function run() {
  console.log('\n════════════════════════════════════════');
  console.log('  ADMIN / PRINCIPAL FULL FUNCTIONALITY TEST');
  console.log(`  School: ${SCHOOL}`);
  console.log('════════════════════════════════════════\n');

  // ── 1. LOGIN ──────────────────────────────────────────────
  console.log('── AUTHENTICATION ──');
  const loginRes = await req('POST', '/api/login', {
    email: 'venkateshthatipamulaaaa@gmail.com',
    password: 'School@123',
  });
  const token = loginRes.body?.token;
  const role  = loginRes.body?.user?.role;
  pass('Admin login', !!token, role || loginRes.body?.error);
  if (!token) { console.log('\nCannot continue without token.'); return; }

  // ── 2. PROFILE ────────────────────────────────────────────
  console.log('\n── PROFILE ──');
  const profileUpdate = await req('POST', '/api/admin/update-profile', {
    schoolId: SCHOOL,
    mobile: '9542447192',
    bloodGroup: 'O+',
  }, token);
  pass('Update profile', profileUpdate.status === 200, JSON.stringify(profileUpdate.body).slice(0, 60));

  // ── 3. NOTIFICATIONS ─────────────────────────────────────
  console.log('\n── NOTIFICATIONS ──');
  const notifs = await req('GET', `/api/admin/notifications?schoolId=${SCHOOL}`, null, token);
  pass('Admin notifications', notifs.status === 200, `unread: ${notifs.body?.unreadCount ?? notifs.body?.error}`);

  const schNotifs = await req('GET', `/api/school-notifications?schoolId=${SCHOOL}`, null, token);
  pass('School notifications', schNotifs.status === 200, `unread: ${schNotifs.body?.unreadCount ?? schNotifs.body?.error}`);

  const markRead = await req('POST', '/api/admin/notifications/mark-read', { schoolId: SCHOOL }, token);
  pass('Mark notifications read', markRead.status === 200, JSON.stringify(markRead.body).slice(0, 60));

  // ── 4. STAFF MANAGEMENT ───────────────────────────────────
  console.log('\n── STAFF MANAGEMENT ──');
  const users = await req('GET', `/api/onboarded-users?schoolId=${SCHOOL}`, null, token);
  pass('List onboarded users', users.status === 200, `count: ${users.body?.users?.length ?? users.body?.error}`);

  const logistics = await req('GET', `/api/logistics-staff?schoolId=${SCHOOL}`, null, token);
  pass('List logistics staff', logistics.status === 200 || Array.isArray(logistics.body), `count: ${Array.isArray(logistics.body) ? logistics.body.length : logistics.body?.error}`);

  // ── 5. STUDENTS ───────────────────────────────────────────
  console.log('\n── STUDENTS ──');
  const studs = await req('GET', `/api/students/list?schoolId=${SCHOOL}`, null, token);
  pass('List students', studs.status === 200, `total: ${studs.body?.total ?? studs.body?.error}`);

  const classes = await req('GET', `/api/classes?schoolId=${SCHOOL}`, null, token);
  pass('List classes', classes.status === 200, `count: ${classes.body?.classes?.length ?? classes.body?.error}`);

  const classTeacher = await req('GET', `/api/class-teacher?schoolId=${SCHOOL}&grade=10-A`, null, token);
  pass('Get class teacher', classTeacher.status === 200, JSON.stringify(classTeacher.body).slice(0, 80));

  // ── 6. ATTENDANCE ─────────────────────────────────────────
  console.log('\n── ATTENDANCE ──');
  const today = new Date().toISOString().split('T')[0];

  const attSummary = await req('GET', `/api/attendance/class-summary?schoolId=${SCHOOL}&date=${today}`, null, token);
  pass('Attendance class summary', attSummary.status === 200, JSON.stringify(attSummary.body).slice(0, 80));

  const attStats = await req('GET', `/api/attendance/class-stats?schoolId=${SCHOOL}&classIds=10-A&date=${today}`, null, token);
  pass('Attendance class stats', attStats.status === 200, JSON.stringify(attStats.body).slice(0, 80));

  const submitStatus = await req('GET', `/api/attendance/submission-status?schoolId=${SCHOOL}&date=${today}&classId=10-A`, null, token);
  pass('Attendance submission status', submitStatus.status === 200, JSON.stringify(submitStatus.body).slice(0, 80));

  // ── 7. FEES ───────────────────────────────────────────────
  console.log('\n── FEES ──');
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year  = now.getFullYear();
  const feeBulk = await req('GET', `/api/admin/fees/bulk-status?schoolId=${SCHOOL}&month=${month}&year=${year}`, null, token);
  pass('Fee bulk status', feeBulk.status === 200, JSON.stringify(feeBulk.body).slice(0, 80));

  const feeStudents = await req('GET', `/api/fee-students?schoolId=${SCHOOL}`, null, token);
  pass('Fee students list', feeStudents.status === 200, `count: ${Array.isArray(feeStudents.body) ? feeStudents.body.length : feeStudents.body?.error}`);

  // ── 8. BUSES ─────────────────────────────────────────────
  console.log('\n── BUS MANAGEMENT ──');
  const buses = await req('GET', `/api/admin/buses?schoolId=${SCHOOL}`, null, token);
  pass('List buses', buses.status === 200, `count: ${buses.body?.buses?.length ?? buses.body?.error}`);

  const busAlerts = await req('GET', `/api/admin/bus-alerts?schoolId=${SCHOOL}`, null, token);
  pass('Bus alerts', busAlerts.status === 200, JSON.stringify(busAlerts.body).slice(0, 60));

  // ── 9. MARKS / CCE ────────────────────────────────────────
  console.log('\n── MARKS & CCE ──');
  const marksClass = await req('GET', `/api/marks/class/10-A?schoolId=${SCHOOL}&examType=FA1&academicYear=2025-26`, null, token);
  pass('Marks by class', marksClass.status === 200, JSON.stringify(marksClass.body).slice(0, 80));

  // ── 10. PROMOTION ─────────────────────────────────────────
  console.log('\n── PROMOTION ──');
  const promPreview = await req('GET', `/api/admin/promotion/preview?schoolId=${SCHOOL}&fromClass=10-A&toClass=10-B`, null, token);
  pass('Promotion preview', promPreview.status === 200 || promPreview.status === 400, JSON.stringify(promPreview.body).slice(0, 80));

  // ── 11. PARENT ACCOUNTS ───────────────────────────────────
  console.log('\n── PARENT ACCOUNTS ──');
  const parents = await req('GET', `/api/admin/parent-accounts?schoolId=${SCHOOL}`, null, token);
  pass('Parent accounts', parents.status === 200, `count: ${Array.isArray(parents.body) ? parents.body.length : parents.body?.error}`);

  // ── 12. LEAVE REQUESTS ────────────────────────────────────
  console.log('\n── LEAVE REQUESTS ──');
  const leaves = await req('GET', `/api/leave-requests/students?schoolId=${SCHOOL}`, null, token);
  pass('Student leave requests', leaves.status === 200, JSON.stringify(leaves.body).slice(0, 80));

  const staffLeaves = await req('GET', `/api/leave-requests/students?schoolId=${SCHOOL}`, null, token);
  pass('Staff leave requests', staffLeaves.status === 200, JSON.stringify(staffLeaves.body).slice(0, 80));

  // ── 13. EVENTS ────────────────────────────────────────────
  console.log('\n── EVENTS & CALENDAR ──');
  const events = await req('GET', `/api/teacher-calendar?schoolId=${SCHOOL}&roleId=PRIN-V-HYDE`, null, token);
  pass('School events', events.status === 200, `count: ${events.body?.events?.length ?? events.body?.error}`);

  // ── 14. BACKUP & SYSTEM ───────────────────────────────────
  console.log('\n── SYSTEM ──');
  const syncStatus = await req('GET', `/api/admin/sync-status?schoolId=${SCHOOL}`, null, token);
  pass('Sync status', syncStatus.status === 200, JSON.stringify(syncStatus.body).slice(0, 80));

  const backupStatus = await req('GET', `/api/admin/backup/status?schoolId=${SCHOOL}`, null, token);
  pass('Backup status', backupStatus.status === 200, JSON.stringify(backupStatus.body).slice(0, 80));

  const auditReport = await req('GET', `/api/admin/audit-report?schoolId=${SCHOOL}`, null, token);
  pass('Audit report', auditReport.status === 200, JSON.stringify(auditReport.body).slice(0, 80));

  const dutyStaff = await req('GET', `/api/duty/all-staff?schoolId=${SCHOOL}`, null, token);
  pass('Duty staff list', dutyStaff.status === 200, JSON.stringify(dutyStaff.body).slice(0, 80));

  console.log('\n════════════════════════════════════════');
  console.log('  TEST COMPLETE');
  console.log('════════════════════════════════════════\n');
}

run().catch(console.error);
