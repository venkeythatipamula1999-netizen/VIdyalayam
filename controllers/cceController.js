'use strict';

const admin = require('firebase-admin');
const { sendAndLog } = require('../services/whatsappService');
const {
  getFAGrade, getSAGrade, getFinalGrade,
  MAX_MARKS, VALID_EXAM_TYPES,
} = require('../helpers/cceGrading');
const {
  notifyAdminMarksSubmitted,
  notifyAdminMarksEdited,
  notifyParentMarksUpdated,
} = require('../services/notificationService');

const DEFAULT_SCHOOL_ID = process.env.DEFAULT_SCHOOL_ID || 'school_001';
const ADMIN_ROLES = ['principal', 'admin', 'staff'];

function db() { return admin.firestore(); }

function cceColl(schoolId) {
  return db().collection('schools').doc(schoolId).collection('cce_marks');
}

function teacherSubjectsColl(schoolId) {
  return db().collection('schools').doc(schoolId).collection('teacher_subjects');
}

function docId(studentId, subjectId, examType, academicYear) {
  return `${studentId}_${subjectId}_${examType}_${academicYear}`;
}

function schoolId(req) { return req.schoolId || DEFAULT_SCHOOL_ID; }

function validateEntry(examType, marks) {
  if (!VALID_EXAM_TYPES.includes(examType)) {
    return `Invalid examType. Must be one of: ${VALID_EXAM_TYPES.join(', ')}`;
  }
  const n = Number(marks);
  if (isNaN(n) || n < 0) return 'marks must be a number >= 0';
  if (n > MAX_MARKS[examType])  return `marks cannot exceed ${MAX_MARKS[examType]} for ${examType}`;
  return null;
}

async function checkTeacherAssignment(req, subjectId, classId, section, academicYear) {
  const role = req.userRole || '';
  if (ADMIN_ROLES.includes(role)) return true;

  const snap = await teacherSubjectsColl(schoolId(req))
    .where('teacherId',    '==', req.userId || '')
    .where('subjectId',    '==', subjectId)
    .where('classId',      '==', classId)
    .where('academicYear', '==', academicYear)
    .get();

  if (!snap.empty) {
    if (section) {
      const matchSection = snap.docs.some(d => {
        const s = d.data().section;
        return !s || s === section;
      });
      return matchSection;
    }
    return true;
  }

  const userDoc = await db().collection('users').doc(req.userId || '').get();
  if (!userDoc.exists) return false;
  const userData = userDoc.data();
  const teacherSubject = (userData.subject || '').toLowerCase();
  const assignedClasses = (userData.assignedClasses || []).map(c => c.trim().toLowerCase());
  const timetable = userData.timetable || [];

  const subjectMatch = teacherSubject === subjectId.toLowerCase() ||
    timetable.some(t => (t.subject || '').toLowerCase() === subjectId.toLowerCase());

  const classNorm = classId.replace(/^Grade\s*/i, '').trim().toLowerCase();
  const classMatch = assignedClasses.some(ac => ac.replace(/^Grade\s*/i, '').trim() === classNorm) ||
    timetable.some(t => (t.className || '').replace(/^Grade\s*/i, '').trim().toLowerCase() === classNorm);

  if (subjectMatch && classMatch) {
    console.log(`[cce] Fallback assignment check passed for ${req.userId}: ${subjectId} in ${classId}`);
    return true;
  }

  return false;
}

// ── POST /api/cce/marks ──────────────────────────────────────────────────────
async function saveMarks(req, res) {
  try {
    const { studentId, subjectId, examType, marks, academicYear, classId, section } = req.body;
    if (!studentId || !subjectId || !academicYear || !classId) {
      return res.status(400).json({ error: 'studentId, subjectId, academicYear, classId are required' });
    }
    const err = validateEntry(examType, marks);
    if (err) return res.status(400).json({ error: err });

    const allowed = await checkTeacherAssignment(req, subjectId, classId, section || '', academicYear);
    if (!allowed) {
      return res.status(403).json({ error: 'You are not assigned to teach this subject for this class' });
    }

    const maxM    = MAX_MARKS[examType];
    const marksN  = Number(marks);
    const id      = docId(studentId, subjectId, examType, academicYear);

    const sid       = schoolId(req);
    const timestamp = new Date().toISOString();

    await cceColl(sid).doc(id).set({
      studentId, subjectId, examType,
      marks: marksN, maxMarks: maxM,
      academicYear, classId, section: section || '',
      schoolId: sid,
      enteredBy:  req.userId || '',
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Admin notification
    notifyAdminMarksSubmitted(sid, {
      teacherName: req.teacherName || req.userId || '',
      className:   classId,
      subjectName: subjectId,
      examType,
      studentCount: 1,
      timestamp,
    }).catch(() => {});

    // Parent notification (structured) + legacy parent_notifications + WhatsApp
    try {
      const studentQ = await db().collection('students').where('studentId', '==', studentId).limit(1).get();
      if (!studentQ.empty) {
        const stuData     = studentQ.docs[0].data();
        const parentPhone = stuData.parentPhone || '';
        const marksStr    = `${marksN}/${maxM}`;
        const pct         = Math.round(marksN * 100 / maxM);

        await db().collection('parent_notifications').add({
          studentId,
          type: 'marks_updated',
          title: `${subjectId} Marks Updated`,
          message: `${examType} marks for ${subjectId}: ${marksStr} (${pct}%)`,
          subjectId, examType, marks: marksN, maxMarks: maxM,
          schoolId: sid,
          read: false,
          createdAt: timestamp,
        });

        notifyParentMarksUpdated(sid, studentId, {
          studentName: stuData.full_name || stuData.name || studentId,
          subjectName: subjectId,
          examType,
          marks: marksN,
          gradeLetter: null,
          timestamp,
        }).catch(() => {});

        if (parentPhone) {
          sendAndLog(sid, parentPhone, 'vl_exam_result',
            [stuData.name || studentId, subjectId, examType, String(marksN), String(maxM), `${pct}%`],
            { studentName: stuData.name || studentId }
          ).catch(() => {});
        }
      }
    } catch (notifErr) {
      console.error('[cce/marks] parent notification error:', notifErr.message);
    }

    res.json({ success: true, message: 'Marks saved' });
  } catch (e) {
    console.error('[cce/marks POST]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── PUT /api/cce/marks (edit with audit trail) ───────────────────────────────
async function editMarks(req, res) {
  try {
    const {
      studentId, subjectId, examType, marks,
      academicYear, classId, section,
      reason, teacherName,
    } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Edit reason is required' });
    }
    if (!studentId || !subjectId || !academicYear || !classId) {
      return res.status(400).json({ error: 'studentId, subjectId, academicYear, classId are required' });
    }

    const err = validateEntry(examType, marks);
    if (err) return res.status(400).json({ error: err });

    const allowed = await checkTeacherAssignment(req, subjectId, classId, section || '', academicYear);
    if (!allowed) {
      return res.status(403).json({ error: 'You are not assigned to teach this subject for this class' });
    }

    const maxM      = MAX_MARKS[examType];
    const marksN    = Number(marks);
    const id        = docId(studentId, subjectId, examType, academicYear);
    const sid       = schoolId(req);
    const ref       = cceColl(sid).doc(id);
    const timestamp = new Date().toISOString();

    const existing     = await ref.get();
    const previousMarks = existing.exists ? existing.data().marks : null;

    const historyEntry = {
      editedBy:      teacherName || req.userId || '',
      teacherId:     req.userId  || '',
      previousMarks: previousMarks ?? null,
      updatedMarks:  marksN,
      reason:        reason.trim(),
      timestamp,
    };

    await ref.set({
      studentId, subjectId, examType,
      marks: marksN, maxMarks: maxM,
      academicYear, classId, section: section || '',
      schoolId: sid,
      enteredBy:   req.userId || '',
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      editHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
    }, { merge: true });

    // Admin notification
    notifyAdminMarksEdited(sid, {
      teacherName:   teacherName || req.userId || '',
      className:     classId,
      studentName:   studentId,
      subjectName:   subjectId,
      previousMarks: previousMarks ?? null,
      updatedMarks:  marksN,
      reason:        reason.trim(),
      timestamp,
    }).catch(() => {});

    // Parent notification
    notifyParentMarksUpdated(sid, studentId, {
      studentName:   studentId,
      subjectName:   subjectId,
      examType,
      marks:         marksN,
      previousMarks: previousMarks ?? null,
      gradeLetter:   null,
      timestamp,
    }).catch(() => {});

    res.json({ success: true, message: 'Marks updated with audit trail' });
  } catch (e) {
    console.error('[cce/marks PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── POST /api/cce/marks/bulk ─────────────────────────────────────────────────
async function saveBulkMarks(req, res) {
  try {
    const { entries, subjectId, examType, academicYear, classId, section } = req.body;
    if (!VALID_EXAM_TYPES.includes(examType)) {
      return res.status(400).json({ error: `Invalid examType: ${examType}` });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries must be a non-empty array' });
    }
    if (entries.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 entries per bulk operation' });
    }

    const allowed = await checkTeacherAssignment(req, subjectId, classId, section || '', academicYear);
    if (!allowed) {
      return res.status(403).json({ error: 'You are not assigned to teach this subject for this class' });
    }

    const maxM  = MAX_MARKS[examType];
    const sid   = schoolId(req);
    const coll  = cceColl(sid);
    const batch = db().batch();
    let count   = 0;

    for (const entry of entries) {
      const { studentId, marks } = entry;
      if (!studentId) continue;
      const n = Number(marks);
      if (isNaN(n) || n < 0 || n > maxM) continue;

      const id  = docId(studentId, subjectId, examType, academicYear);
      const ref = coll.doc(id);
      batch.set(ref, {
        studentId, subjectId, examType,
        marks: n, maxMarks: maxM,
        academicYear, classId, section: section || '',
        schoolId: sid,
        enteredBy:  req.userId || '',
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      count++;
    }

    await batch.commit();
    res.json({ success: true, count });
  } catch (e) {
    console.error('[cce/marks/bulk]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/marks ───────────────────────────────────────────────────────
async function getMarks(req, res) {
  try {
    const { academicYear, classId, section, subjectId, examType } = req.query;
    if (!academicYear || !classId || !subjectId || !examType) {
      return res.status(400).json({ error: 'academicYear, classId, subjectId, examType are required' });
    }

    // Authorization: Teachers can only view marks for their assigned subject/class
    const role = req.userRole || '';
    if (!ADMIN_ROLES.includes(role)) {
      const allowed = await checkTeacherAssignment(req, subjectId, classId, section || '', academicYear);
      if (!allowed) {
        return res.status(403).json({ error: 'You are not assigned to this subject/class' });
      }
    }

    const snap = await cceColl(schoolId(req))
      .where('academicYear', '==', academicYear)
      .where('classId',      '==', classId)
      .where('subjectId',    '==', subjectId)
      .where('examType',     '==', examType)
      .get();

    let marks = snap.docs.map(d => {
      const m = d.data();
      return { studentId: m.studentId, marks: m.marks, maxMarks: m.maxMarks, updatedAt: m.updatedAt };
    });

    if (section) marks = marks.filter(m => {
      const raw = snap.docs.find(d => d.data().studentId === m.studentId)?.data();
      return raw?.section === section;
    });

    res.json({ success: true, marks });
  } catch (e) {
    console.error('[cce/marks GET]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/my-assigned-subjects ────────────────────────────────────────
async function getMyAssignedSubjects(req, res) {
  try {
    const { academicYear, classId, section } = req.query;

    const role = req.userRole || '';
    if (ADMIN_ROLES.includes(role)) {
      const { SUBJECTS } = require('../helpers/cceGrading');
      return res.json({ success: true, subjects: SUBJECTS || [], isAdmin: true });
    }

    if (!academicYear || !classId) {
      return res.status(400).json({ error: 'academicYear and classId are required' });
    }

    let q = teacherSubjectsColl(schoolId(req))
      .where('teacherId',    '==', req.userId || '')
      .where('classId',      '==', classId)
      .where('academicYear', '==', academicYear);

    const snap = await q.get();

    let docs = snap.docs.map(d => d.data());
    if (section) {
      docs = docs.filter(d => !d.section || d.section === section);
    }

    let subjects = [...new Set(docs.map(d => d.subjectId).filter(Boolean))];

    if (subjects.length === 0) {
      const userDoc = await db().collection('users').doc(req.userId || '').get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        const assignedClasses = (userData.assignedClasses || []).map(c => c.trim().toLowerCase());
        const timetable = userData.timetable || [];
        const classNorm = classId.replace(/^Grade\s*/i, '').trim().toLowerCase();
        const hasClass = assignedClasses.some(ac => ac.replace(/^Grade\s*/i, '').trim() === classNorm) ||
          timetable.some(t => (t.className || '').replace(/^Grade\s*/i, '').trim().toLowerCase() === classNorm);

        if (hasClass) {
          const fallbackSubjects = new Set();
          if (userData.subject) fallbackSubjects.add(userData.subject);
          for (const t of timetable) {
            if (t.subject && (t.className || '').replace(/^Grade\s*/i, '').trim().toLowerCase() === classNorm) {
              fallbackSubjects.add(t.subject);
            }
          }
          subjects = [...fallbackSubjects];
        }
      }
    }

    res.json({ success: true, subjects });
  } catch (e) {
    console.error('[cce/my-assigned-subjects]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── POST /api/cce/admin/assign-subject ───────────────────────────────────────
async function assignTeacherSubject(req, res) {
  try {
    const role = req.userRole || '';
    if (!ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Only admin/principal can assign subjects' });
    }
    const { teacherId, subjectId, classId, section, academicYear } = req.body;
    if (!teacherId || !subjectId || !classId || !academicYear) {
      return res.status(400).json({ error: 'teacherId, subjectId, classId, academicYear are required' });
    }
    const sid = schoolId(req);
    const docRef = teacherSubjectsColl(sid).doc(`${teacherId}_${subjectId}_${classId}_${section || 'ALL'}_${academicYear}`);
    await docRef.set({
      teacherId, subjectId, classId,
      section: section || '',
      academicYear,
      schoolId: sid,
      assignedBy: req.userId || '',
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ success: true, message: 'Teacher subject assignment saved' });
  } catch (e) {
    console.error('[cce/admin/assign-subject]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── DELETE /api/cce/admin/assign-subject ─────────────────────────────────────
async function removeTeacherSubject(req, res) {
  try {
    const role = req.userRole || '';
    if (!ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Only admin/principal can remove subject assignments' });
    }
    const { teacherId, subjectId, classId, section, academicYear } = req.body;
    if (!teacherId || !subjectId || !classId || !academicYear) {
      return res.status(400).json({ error: 'teacherId, subjectId, classId, academicYear are required' });
    }
    const docRef = teacherSubjectsColl(schoolId(req))
      .doc(`${teacherId}_${subjectId}_${classId}_${section || 'ALL'}_${academicYear}`);
    await docRef.delete();
    res.json({ success: true, message: 'Assignment removed' });
  } catch (e) {
    console.error('[cce/admin/remove-subject]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/admin/teacher-subjects ─────────────────────────────────────
async function getTeacherSubjects(req, res) {
  try {
    const role = req.userRole || '';
    if (!ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Only admin/principal can view assignments' });
    }
    const { academicYear, classId, teacherId } = req.query;
    let q = teacherSubjectsColl(schoolId(req));
    if (academicYear) q = q.where('academicYear', '==', academicYear);
    if (classId)      q = q.where('classId',      '==', classId);
    if (teacherId)    q = q.where('teacherId',    '==', teacherId);
    const snap = await q.get();
    const assignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, assignments });
  } catch (e) {
    console.error('[cce/admin/teacher-subjects]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────
async function fetchClassMarks(sid, academicYear, classId, section) {
  const snap = await cceColl(sid)
    .where('academicYear', '==', academicYear)
    .where('classId',      '==', classId)
    .get();
  const docs = snap.docs.map(d => d.data());
  return section ? docs.filter(d => d.section === section) : docs;
}

function groupByStudentSubjectExam(rows) {
  const map = {};
  for (const r of rows) {
    map[r.studentId]                          = map[r.studentId]                          || {};
    map[r.studentId][r.subjectId]             = map[r.studentId][r.subjectId]             || {};
    map[r.studentId][r.subjectId][r.examType] = r.marks;
  }
  return map;
}

function n(v, fallback = 0) { return v !== undefined && v !== null ? Number(v) : fallback; }

// ── GET /api/cce/results/halfyear ────────────────────────────────────────────
async function getHalfYearResults(req, res) {
  try {
    const { academicYear, classId, section } = req.query;
    if (!academicYear || !classId) {
      return res.status(400).json({ error: 'academicYear and classId are required' });
    }

    const rows    = await fetchClassMarks(schoolId(req), academicYear, classId, section);
    const grouped = groupByStudentSubjectExam(rows);

    const results = Object.entries(grouped).map(([studentId, subjects]) => {
      const subjectResults = {};
      for (const [subjectId, exams] of Object.entries(subjects)) {
        const fa1 = exams['FA1'] !== undefined ? n(exams['FA1']) : null;
        const fa2 = exams['FA2'] !== undefined ? n(exams['FA2']) : null;
        const sa1 = exams['SA1'] !== undefined ? n(exams['SA1']) : null;

        const faTotal  = n(fa1) + n(fa2);
        const faWeight = parseFloat(((faTotal / 40) * 20).toFixed(2));
        const halfYear = sa1 !== null ? parseFloat((faWeight + sa1).toFixed(2)) : null;

        const halfYearGrade = halfYear !== null ? getFinalGrade(halfYear) : null;

        subjectResults[subjectId] = {
          fa1, fa2,
          faTotal, faWeight, sa1,
          halfYear,
          grade:       halfYearGrade?.grade  || null,
          gradePoints: halfYearGrade?.points || null,
        };
      }
      return { studentId, subjects: subjectResults };
    });

    res.json({ success: true, results });
  } catch (e) {
    console.error('[cce/results/halfyear]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/results/final ───────────────────────────────────────────────
async function getFinalResults(req, res) {
  try {
    const { academicYear, classId, section } = req.query;
    if (!academicYear || !classId) {
      return res.status(400).json({ error: 'academicYear and classId are required' });
    }

    const rows    = await fetchClassMarks(schoolId(req), academicYear, classId, section);
    const grouped = groupByStudentSubjectExam(rows);

    const results = Object.entries(grouped).map(([studentId, subjects]) => {
      let totalFinalScore = 0;
      let subjectCount    = 0;
      const subjectResults = {};

      for (const [subjectId, exams] of Object.entries(subjects)) {
        const fa1 = n(exams['FA1']);
        const fa2 = n(exams['FA2']);
        const fa3 = n(exams['FA3']);
        const fa4 = n(exams['FA4']);
        const sa1 = n(exams['SA1']);
        const sa2 = n(exams['SA2']);

        const faTotal  = fa1 + fa2 + fa3 + fa4;
        const faWeight = parseFloat(((faTotal / 80) * 40).toFixed(2));
        const saTotal  = sa1 + sa2;
        const saWeight = parseFloat(((saTotal / 160) * 60).toFixed(2));
        const final    = parseFloat((faWeight + saWeight).toFixed(2));

        const grade = getFinalGrade(final);
        totalFinalScore += final;
        subjectCount++;

        subjectResults[subjectId] = {
          fa1, fa2, fa3, fa4, faTotal, faWeight,
          sa1, sa2, saTotal, saWeight,
          finalScore:  final,
          grade:       grade.grade,
          gradePoints: grade.points,
        };
      }

      const avgFinal    = subjectCount > 0 ? parseFloat((totalFinalScore / subjectCount).toFixed(2)) : 0;
      const totalPoints = Object.values(subjectResults).reduce((s, r) => s + r.gradePoints, 0);
      const overallGrade = getFinalGrade(avgFinal);

      return { studentId, subjects: subjectResults, totalPoints, overallGrade: overallGrade.grade };
    });

    res.json({ success: true, results });
  } catch (e) {
    console.error('[cce/results/final]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/report/:studentId ───────────────────────────────────────────
async function getStudentReport(req, res) {
  try {
    const { studentId } = req.params;
    const { academicYear, classId, section, type } = req.query;
    if (!academicYear || !classId) {
      return res.status(400).json({ error: 'academicYear and classId are required' });
    }

    const snap = await cceColl(schoolId(req))
      .where('studentId',    '==', studentId)
      .where('academicYear', '==', academicYear)
      .where('classId',      '==', classId)
      .get();

    let rows = snap.docs.map(d => d.data());
    if (section) rows = rows.filter(r => r.section === section);

    let studentName = '';
    try {
      const stu = await db().collection('students').doc(studentId).get();
      if (stu.exists) { const sd = stu.data(); studentName = sd.studentName || sd.name || ''; }
    } catch (_) {}

    const subjectMap = {};
    for (const r of rows) {
      subjectMap[r.subjectId]             = subjectMap[r.subjectId] || {};
      subjectMap[r.subjectId][r.examType] = r.marks;
    }

    const isFinal   = type === 'final';
    const calcResults = {};

    for (const [subjectId, exams] of Object.entries(subjectMap)) {
      if (isFinal) {
        const fa1 = n(exams['FA1']); const fa2 = n(exams['FA2']);
        const fa3 = n(exams['FA3']); const fa4 = n(exams['FA4']);
        const sa1 = n(exams['SA1']); const sa2 = n(exams['SA2']);

        const faTotal  = fa1 + fa2 + fa3 + fa4;
        const faWeight = parseFloat(((faTotal / 80) * 40).toFixed(2));
        const saTotal  = sa1 + sa2;
        const saWeight = parseFloat(((saTotal / 160) * 60).toFixed(2));
        const final    = parseFloat((faWeight + saWeight).toFixed(2));
        const grade    = getFinalGrade(final);

        calcResults[subjectId] = {
          fa1, fa2, fa3, fa4, faTotal, faWeight,
          sa1, sa2, saTotal, saWeight,
          finalScore: final, grade: grade.grade, gradePoints: grade.points,
        };
      } else {
        const fa1 = exams['FA1'] !== undefined ? n(exams['FA1']) : null;
        const fa2 = exams['FA2'] !== undefined ? n(exams['FA2']) : null;
        const sa1 = exams['SA1'] !== undefined ? n(exams['SA1']) : null;

        const faTotal  = n(fa1) + n(fa2);
        const faWeight = parseFloat(((faTotal / 40) * 20).toFixed(2));
        const halfYear = sa1 !== null ? parseFloat((faWeight + sa1).toFixed(2)) : null;
        const grade    = halfYear !== null ? getFinalGrade(halfYear) : null;

        calcResults[subjectId] = {
          fa1, fa2, faTotal, faWeight, sa1, halfYear,
          grade:       grade?.grade  || null,
          gradePoints: grade?.points || null,
        };
      }
    }

    res.json({
      success: true,
      student: { studentId, name: studentName },
      results: calcResults,
      type:    type || 'halfyear',
    });
  } catch (e) {
    console.error('[cce/report]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/student-summary/:studentId ───────────────────────────────────
function getCurrentAcademicYear() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

const GRADE_COLORS = {
  A1: '#059669', A2: '#10b981', B1: '#3b82f6', B2: '#6366f1',
  C1: '#f59e0b', C2: '#f97316', D: '#ef4444', E: '#dc2626',
};

async function getStudentSummary(req, res) {
  try {
    const { studentId } = req.params;
    const { academicYear, type = 'halfyear' } = req.query;
    const year = academicYear || getCurrentAcademicYear();
    const sId  = schoolId(req);

    let classId = '', section = '', studentName = '';
    try {
      const stu = await db().collection('students').doc(studentId).get();
      if (stu.exists) {
        const sd = stu.data();
        classId     = sd.classId || sd.class || '';
        section     = sd.section || '';
        studentName = sd.studentName || sd.name || '';
      }
    } catch (_) {}

    const snap = await cceColl(sId)
      .where('studentId',    '==', studentId)
      .where('academicYear', '==', year)
      .get();

    const examMap = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (!examMap[data.subjectId]) examMap[data.subjectId] = {};
      examMap[data.subjectId][data.examType] = data.marks;
      if (!classId && data.classId) classId = data.classId;
      if (!section && data.section) section = data.section;
    });

    const isFinal = type === 'final';
    const subjects = {};
    let totalPoints  = 0;
    let subjectCount = 0;

    for (const [subjectId, exams] of Object.entries(examMap)) {
      if (isFinal) {
        const fa1 = n(exams['FA1']); const fa2 = n(exams['FA2']);
        const fa3 = n(exams['FA3']); const fa4 = n(exams['FA4']);
        const sa1 = exams['SA1'] !== undefined ? n(exams['SA1']) : null;
        const sa2 = exams['SA2'] !== undefined ? n(exams['SA2']) : null;

        const faTotal  = fa1 + fa2 + fa3 + fa4;
        const faWeight = parseFloat(((faTotal / 80) * 40).toFixed(2));
        const saTotal  = n(sa1) + n(sa2);
        const saWeight = parseFloat(((saTotal / 160) * 60).toFixed(2));
        const finalScore = parseFloat((faWeight + saWeight).toFixed(2));
        const gradeObj   = getFinalGrade(finalScore);

        subjects[subjectId] = {
          fa1, fa2, fa3, fa4,
          sa1, sa2,
          faTotal, faWeight,
          saTotal, saWeight,
          halfYear: null,
          final: finalScore,
          grade:       gradeObj.grade,
          gradePoints: gradeObj.points,
          gradeColor:  GRADE_COLORS[gradeObj.grade] || '#6b7280',
        };
        totalPoints += gradeObj.points || 0;
      } else {
        const fa1 = exams['FA1'] !== undefined ? n(exams['FA1']) : null;
        const fa2 = exams['FA2'] !== undefined ? n(exams['FA2']) : null;
        const sa1 = exams['SA1'] !== undefined ? n(exams['SA1']) : null;

        const faTotal  = n(fa1) + n(fa2);
        const faWeight = parseFloat(((faTotal / 40) * 20).toFixed(2));
        const halfYear = sa1 !== null ? parseFloat((faWeight + sa1).toFixed(2)) : null;
        const gradeObj = halfYear !== null ? getFinalGrade(halfYear) : null;

        subjects[subjectId] = {
          fa1, fa2, fa3: null, fa4: null,
          sa1, sa2: null,
          faTotal, faWeight,
          saTotal: null, saWeight: null,
          halfYear, final: null,
          grade:       gradeObj?.grade  || null,
          gradePoints: gradeObj?.points || null,
          gradeColor:  gradeObj ? (GRADE_COLORS[gradeObj.grade] || '#6b7280') : '#6b7280',
        };
        totalPoints += gradeObj?.points || 0;
      }
      subjectCount++;
    }

    const avgPoints      = subjectCount > 0 ? totalPoints / subjectCount : 0;
    const overallGradeObj = getFinalGrade(avgPoints * 10);

    res.json({
      success: true,
      studentId,
      studentName,
      classId,
      section,
      academicYear: year,
      type,
      subjects,
      totalPoints,
      overallGrade: overallGradeObj.grade,
      overallColor: GRADE_COLORS[overallGradeObj.grade] || '#6b7280',
    });
  } catch (e) {
    console.error('[cce/student-summary]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET /api/cce/marks/class ─────────────────────────────────────────────────
async function getClassMarks(req, res) {
  try {
    const { classId, examType, academicYear } = req.query;
    if (!classId || !examType || !academicYear) {
      return res.status(400).json({ error: 'classId, examType, academicYear are required' });
    }

    const sid = schoolId(req);

    // Authorization: Teachers can only view class marks for their assigned classes
    const role = req.userRole || '';
    if (!ADMIN_ROLES.includes(role)) {
      const userDoc = await db().collection('users').doc(req.userId || '').get();
      if (!userDoc.exists) {
        return res.status(403).json({ error: 'User not found' });
      }
      const userData = userDoc.data();
      const assignedClasses = (userData.assignedClasses || []).map(c => c.trim().toLowerCase());
      const timetable = userData.timetable || [];
      const classNorm = classId.replace(/^Grade\s*/i, '').trim().toLowerCase();
      const hasClassAccess = assignedClasses.some(ac => ac.replace(/^Grade\s*/i, '').trim() === classNorm) ||
        timetable.some(t => (t.className || '').replace(/^Grade\s*/i, '').trim().toLowerCase() === classNorm);
      if (!hasClassAccess) {
        return res.status(403).json({ error: 'You are not assigned to this class' });
      }
    }

    const [marksSnap, studSnap] = await Promise.all([
      cceColl(sid)
        .where('classId',      '==', classId)
        .where('examType',     '==', examType)
        .where('academicYear', '==', academicYear)
        .get(),
      db().collection('students')
        .where('schoolId', '==', sid)
        .where('classId',  '==', classId)
        .get(),
    ]);

    const marksMap = {};
    marksSnap.docs.forEach(d => {
      const m = d.data();
      if (!marksMap[m.studentId]) marksMap[m.studentId] = {};
      marksMap[m.studentId][m.subjectId] = m.marks;
    });

    const students = studSnap.docs
      .map(d => {
        const s = d.data();
        return {
          studentId:   s.studentId || d.id,
          studentName: s.studentName || s.full_name || s.name || '',
          rollNumber:  s.rollNumber || '',
        };
      })
      .sort((a, b) => a.studentName.localeCompare(b.studentName))
      .map(s => ({ ...s, marks: marksMap[s.studentId] || {} }));

    const { SUBJECTS } = require('../helpers/cceGrading');
    const maxM = MAX_MARKS[examType] || 0;

    res.json({ success: true, students, subjects: SUBJECTS, examType, classId, academicYear, maxMarks: maxM });
  } catch (e) {
    console.error('[cce/marks/class]', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  saveMarks, saveBulkMarks, editMarks, getMarks, getClassMarks,
  getMyAssignedSubjects, assignTeacherSubject, removeTeacherSubject, getTeacherSubjects,
  getHalfYearResults, getFinalResults, getStudentReport,
  getStudentSummary,
};
