import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Modal, KeyboardAvoidingView, Platform, BackHandler, Alert, Linking } from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';
import Toast from '../../components/Toast';
import { getFriendlyError } from '../../utils/errorMessages';

const EDIT_REASONS = [
  'Data entry mistake',
  'Re-evaluation correction',
  'Absent mark correction',
  'Grading error',
  'Other',
];

const ALL_SUBJECTS = [
  { name: 'Mathematics', short: 'Math', color: C.gold },
  { name: 'Science', short: 'Sci', color: C.teal },
  { name: 'English', short: 'Eng', color: C.purple },
  { name: 'Social Studies', short: 'Soc', color: C.coral },
  { name: 'Tamil', short: 'Tam', color: '#34D399' },
  { name: 'Computer', short: 'Comp', color: '#60A5FA' },
];

const EXAM_TYPES = [
  { id: 'FA1', label: 'FA1' },
  { id: 'FA2', label: 'FA2' },
  { id: 'FA3', label: 'FA3' },
  { id: 'FA4', label: 'FA4' },
  { id: 'SA1', label: 'SA1' },
  { id: 'SA2', label: 'SA2' },
];

const MAX_MARKS = 20;
const STUDENT_COLORS = [C.teal, C.gold, C.purple, C.coral, '#34D399', '#60A5FA'];

function getGrade(m, max) {
  const pct = Math.round((parseInt(m) / (max || MAX_MARKS)) * 100);
  if (isNaN(pct)) return { g: '–', c: C.muted };
  if (pct >= 90) return { g: 'A+', c: C.teal };
  if (pct >= 75) return { g: 'A', c: C.gold };
  if (pct >= 60) return { g: 'B+', c: C.purple };
  if (pct >= 50) return { g: 'B', c: C.muted };
  return { g: 'C', c: C.coral };
}

function normalizeGrade(s) {
  return (s || '').trim().replace(/^Grade\s+/i, '').toLowerCase();
}

function normalizeSubject(s) {
  return (s || '').trim().toLowerCase();
}

export default function TeacherMarksScreen({ onBack, currentUser }) {
  const isAdmin = currentUser?.role === 'principal';
  const roleId = currentUser?.role_id;

  const [allClasses, setAllClasses] = useState([]);
  const [loadingClasses, setLoadingClasses] = useState(true);

  const [allowedSubjects, setAllowedSubjects] = useState([]);
  const [subjectClassMap, setSubjectClassMap] = useState({});
  const [permLoading, setPermLoading] = useState(!isAdmin);

  const [students, setStudents] = useState([]);
  const [loadingStudents, setLoadingStudents] = useState(false);

  const [mode, setMode] = useState('entry');
  const [selectedSubjectIdx, setSelectedSubjectIdx] = useState(0);
  const [selectedExamIdx, setSelectedExamIdx] = useState(0);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [showSubjectPicker, setShowSubjectPicker] = useState(false);
  const [showExamPicker, setShowExamPicker] = useState(false);
  const [showClassPicker, setShowClassPicker] = useState(false);

  const [marks, setMarks] = useState({});
  const [validationErrors, setValidationErrors] = useState({});
  const [loadingMarks, setLoadingMarks] = useState(false);
  const [submittedExams, setSubmittedExams] = useState(new Set());
  const [loadingSubmittedExams, setLoadingSubmittedExams] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [errorMsg, setErrorMsg] = useState('');
  const [marksVersions, setMarksVersions] = useState({});
  const [conflictError, setConflictError] = useState(false);

  const [editDialogVisible, setEditDialogVisible] = useState(false);
  const [editStudent, setEditStudent] = useState(null);
  const [editNewMarks, setEditNewMarks] = useState('');
  const [editReason, setEditReason] = useState('');
  const [editCustomReason, setEditCustomReason] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [viewData, setViewData] = useState(null);
  const [loadingView, setLoadingView] = useState(false);
  const [viewClassId, setViewClassId] = useState('');
  const [viewExamIdx, setViewExamIdx] = useState(0);
  const [showViewClassPicker, setShowViewClassPicker] = useState(false);

  useEffect(() => {
    apiFetch('/classes?t=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.classes)) {
          setAllClasses(
            data.classes
              .map(c => ({ id: c.id, label: 'Grade ' + c.name, grade: c.name }))
              .sort((a, b) => a.grade.localeCompare(b.grade, undefined, { numeric: true }))
          );
        }
      })
      .catch(() => {})
      .finally(() => setLoadingClasses(false));
  }, []);

  const [freshAssignedClasses, setFreshAssignedClasses] = useState(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  useEffect(() => {
    if (isAdmin) {
      setAllowedSubjects(ALL_SUBJECTS);
      setPermLoading(false);
      return;
    }

    const buildFromProfile = (profile) => {
      const timetable = profile?.timetable || currentUser?.timetable || [];
      const subj = profile?.subject || currentUser?.subject || '';
      const assignedClasses = profile?.assignedClasses || currentUser?.assignedClasses || [];
      const map = {};
      const subjSet = new Set();
      for (const entry of timetable) {
        const s = entry.subject;
        const cls = (entry.className || '').replace(/^Grade\s+/i, '');
        if (s) {
          subjSet.add(s);
          if (!map[s]) map[s] = [];
          if (cls && !map[s].includes(cls)) map[s].push(cls);
        }
      }
      if (subj && !subjSet.has(subj)) {
        subjSet.add(subj);
        if (!map[subj]) map[subj] = assignedClasses.map(c => c.replace(/^Grade\s+/i, ''));
      }
      const filtered = ALL_SUBJECTS.filter(s => [...subjSet].some(ts => normalizeSubject(ts) === normalizeSubject(s.name)));
      setAllowedSubjects(filtered.length > 0 ? filtered : []);
      setSubjectClassMap(map);
      if (assignedClasses.length > 0) setFreshAssignedClasses(assignedClasses.map(c => c.replace(/^Grade\s+/i, '')));
    };

    if (!roleId) { buildFromProfile(null); setPermLoading(false); return; }

    apiFetch(`/teacher/permissions?roleId=${encodeURIComponent(roleId)}&t=` + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        const filtered = ALL_SUBJECTS.filter(s =>
          (data.subjects || []).some(ds => normalizeSubject(ds) === normalizeSubject(s.name))
        );
        setAllowedSubjects(filtered.length > 0 ? filtered : []);
        setSubjectClassMap(data.subjectClassMap || {});
        if (data.classes && data.classes.length > 0) {
          setFreshAssignedClasses(data.classes.map(c => c.replace(/^Grade\s+/i, '')));
        }
      })
      .catch(() => {
        apiFetch(`/teacher/profile?roleId=${encodeURIComponent(roleId)}&t=` + Date.now(), { cache: 'no-store' })
          .then(r => r.json())
          .then(profile => buildFromProfile(profile))
          .catch(() => buildFromProfile(null));
      })
      .finally(() => setPermLoading(false));
  }, [roleId, isAdmin]);

  const entrySubject = allowedSubjects[selectedSubjectIdx];
  const exam = EXAM_TYPES[selectedExamIdx];

  const effectiveAssignedClasses = freshAssignedClasses || (currentUser?.assignedClasses || []).map(c => c.replace(/^Grade\s+/i, ''));

  const entryClasses = useMemo(() => {
    if (isAdmin) return allClasses;
    if (!entrySubject) return [];
    const mapKey = Object.keys(subjectClassMap).find(k => normalizeSubject(k) === normalizeSubject(entrySubject?.name));
    if (mapKey) {
      const entries = subjectClassMap[mapKey] || [];
      const allowed = entries.map(g => normalizeGrade(g));
      return allClasses.filter(c => allowed.includes(normalizeGrade(c.grade)));
    }
    const assignedGrades = effectiveAssignedClasses.map(normalizeGrade);
    if (assignedGrades.length > 0) return allClasses.filter(c => assignedGrades.includes(normalizeGrade(c.grade)));
    return allClasses;
  }, [isAdmin, allClasses, entrySubject, subjectClassMap, effectiveAssignedClasses]);

  const viewClasses = useMemo(() => {
    if (isAdmin) return allClasses;
    const assignedGrades = new Set([
      ...effectiveAssignedClasses.map(normalizeGrade),
      ...Object.values(subjectClassMap).flat().map(normalizeGrade),
    ]);
    if (assignedGrades.size > 0) return allClasses.filter(c => assignedGrades.has(normalizeGrade(c.grade)));
    return allClasses;
  }, [isAdmin, allClasses, subjectClassMap, effectiveAssignedClasses]);

  useEffect(() => {
    if (entryClasses.length > 0 && (!selectedClassId || !entryClasses.find(c => c.id === selectedClassId))) {
      setSelectedClassId(entryClasses[0].id);
    }
  }, [entryClasses]);

  useEffect(() => {
    if (viewClasses.length > 0 && !viewClassId) {
      setViewClassId(viewClasses[0].id);
    }
  }, [viewClasses]);

  const selectedClass = allClasses.find(c => c.id === selectedClassId);

  useEffect(() => {
    if (!selectedClassId) { setStudents([]); return; }
    setLoadingStudents(true);
    apiFetch('/students/' + selectedClassId + '?t=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.students)) {
          setStudents(data.students.map((s, i) => ({
            id: s.id,
            name: s.name || s.studentName || 'Unknown',
            roll: s.rollNumber || s.roll || 0,
            color: STUDENT_COLORS[i % STUDENT_COLORS.length],
          })));
        } else { setStudents([]); }
      })
      .catch(() => setStudents([]))
      .finally(() => setLoadingStudents(false));
  }, [selectedClassId]);

  useEffect(() => {
    setValidationErrors({});
    setErrorMsg('');
    if (!selectedClassId || !entrySubject || !exam) { setMarks({}); return; }
    setLoadingMarks(true);
    apiFetch(`/marks/view?examType=${exam.id}&classId=${selectedClassId}`)
      .then(r => r.json())
      .then(data => {
        const existing = {};
        const versions = {};
        (data.marks || []).forEach(m => {
          if (normalizeSubject(m.subject) === normalizeSubject(entrySubject.name)) {
            existing[m.studentId] = String(m.marksObtained);
            if (m.version !== undefined) versions[m.studentId] = m.version;
          }
        });
        setMarks(existing);
        setMarksVersions(versions);
      })
      .catch(() => setMarks({}))
      .finally(() => setLoadingMarks(false));
  }, [selectedClassId, selectedSubjectIdx, selectedExamIdx]);

  useEffect(() => {
    if (!selectedClassId || !entrySubject) { setSubmittedExams(new Set()); return; }
    setLoadingSubmittedExams(true);
    apiFetch(`/marks/submitted-exams?classId=${selectedClassId}&subject=${encodeURIComponent(entrySubject.name)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.submittedExams)) {
          setSubmittedExams(new Set(data.submittedExams));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingSubmittedExams(false));
  }, [selectedClassId, selectedSubjectIdx]);

  useEffect(() => {
    if (mode === 'view' && viewClassId) loadViewData(viewClassId);
  }, [mode, viewClassId]);

  const loadViewData = async (classId) => {
    setLoadingView(true);
    setViewData(null);
    try {
      console.log('Loading comprehensive marks for classId:', classId);
      const res = await apiFetch(`/teacher/class-comprehensive/${encodeURIComponent(classId)}`);
      const data = await res.json();
      console.log('Comprehensive marks loaded:', data.total, 'students,', data.subjects?.length, 'subjects');
      if (data.success) {
        // Transform the data for display
        const viewDataTransformed = {
          students: data.students.map(s => ({
            ...s,
            overallPct: 0, // Will calculate below
            byExam: data.exams.map(exam => {
              const subjectMarks = s.subjectMarks || {};
              const total = Object.values(subjectMarks).reduce((sum, exams) => {
                return sum + (exams[exam]?.marks || 0);
              }, 0);
              const max = Object.values(subjectMarks).reduce((sum, exams) => {
                return sum + (exams[exam]?.maxMarks || 0);
              }, 0);
              return {
                examType: exam,
                total,
                maxTotal: max,
                subjects: data.subjects.map(subject => ({
                  subject,
                  marks: s.subjectMarks?.[subject]?.[exam]?.marks || null,
                  maxMarks: s.subjectMarks?.[subject]?.[exam]?.maxMarks || 20,
                })).filter(sm => sm.marks !== null),
              };
            }),
          })),
          classAvgBySubject: data.subjects.map(subject => ({
            subject,
            pct: data.subjectAverages[subject] || 0,
          })),
        };
        setViewData(viewDataTransformed);
      }
    } catch (err) {
      console.error('Teacher view marks error:', err);
      setViewData(null);
    } finally {
      setLoadingView(false);
    }
  };

  const showToast = (msg, type = 'success') => setToast({ visible: true, message: msg, type });

  const generateReportCard = async (studentId, studentName) => {
    try {
      const res = await apiFetch(
        `/reports/report-card/${encodeURIComponent(studentId)}`,
        { method: 'POST', body: JSON.stringify({ examType: exam?.id || 'Term 1' }) }
      );
      if (!res.ok) throw new Error('Failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-card-${studentName}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      Alert.alert('Error', 'Could not generate report card');
    }
  };

  const handleMarksChange = (studentId, value) => {
    const cleaned = value.replace(/[^0-9]/g, '');
    setMarks(prev => ({ ...prev, [studentId]: cleaned }));
    const v = parseInt(cleaned);
    if (cleaned && v > MAX_MARKS) {
      setValidationErrors(prev => ({ ...prev, [studentId]: `Max ${MAX_MARKS}` }));
    } else {
      setValidationErrors(prev => { const n = { ...prev }; delete n[studentId]; return n; });
    }
  };

  const handleSubmit = async () => {
    if (!entrySubject || !selectedClassId || students.length === 0) return;
    setErrorMsg('');
    const errors = {};
    const records = [];
    for (const s of students) {
      const val = marks[s.id];
      if (!val && val !== '0') { errors[s.id] = 'Required'; continue; }
      const v = parseInt(val);
      if (isNaN(v) || v < 0) { errors[s.id] = 'Invalid'; continue; }
      if (v > MAX_MARKS) { errors[s.id] = `Max ${MAX_MARKS}`; continue; }
      records.push({
        studentId: s.id,
        studentName: s.name,
        classId: selectedClassId,
        subject: entrySubject.name,
        examType: exam.id,
        marksObtained: v,
        maxMarks: MAX_MARKS,
        recordedBy: roleId || currentUser?.email || 'teacher',
        version: marksVersions[s.id],
      });
    }
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      setErrorMsg('Please fill in all marks before submitting.');
      return;
    }
    setSubmitting(true);
    setSyncStatus('syncing');
    try {
      const res = await apiFetch('/marks/save', {
        method: 'POST',
        body: JSON.stringify({
          records,
          subject: entrySubject.name,
          examType: exam.id,
          teacherId: roleId || '',
          classId: selectedClassId,
          className: selectedClass?.grade || '',
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setConflictError(true);
        setErrorMsg('These marks were updated by someone else. Please refresh and try again.');
        setSyncStatus('error');
        setTimeout(() => setSyncStatus('idle'), 5000);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to save marks');
      setSyncStatus(data.sheetSync ? 'synced' : 'partial');
      showToast(`${exam.label} marks saved! ${entrySubject.name} – ${selectedClass?.label || ''}`, 'success');
      const below40 = students.filter(s => {
        const mark = marks[s.id];
        return mark !== undefined && mark !== '' && Number(mark) < MAX_MARKS * 0.4;
      });
      if (below40.length > 0) {
        Alert.alert(
          '⚠️ Low Marks Warning',
          `${below40.length} student${below40.length > 1 ? 's' : ''} scored below 40%. Please review before submitting to admin.`,
          [{ text: 'OK' }]
        );
      }
      setSubmittedExams(prev => new Set([...prev, exam.id]));
      // Instantly reload view data so teacher sees results immediately
      if (mode === 'view' || true) {
        loadViewData(selectedClassId);
      }
      // Reload marks for this exam to reflect submitted state
      apiFetch(`/marks/view?examType=${exam.id}&classId=${selectedClassId}`)
        .then(r => r.json())
        .then(data => {
          const updated = {};
          const versions = {};
          (data.marks || []).forEach(m => {
            if ((m.subject || '').trim().toLowerCase() === (entrySubject.name || '').trim().toLowerCase()) {
              updated[m.studentId] = String(m.marksObtained);
              if (m.version !== undefined) versions[m.studentId] = m.version;
            }
          });
          setMarks(updated);
          setMarksVersions(versions);
        })
        .catch(() => {});
      setTimeout(() => setSyncStatus('idle'), 5000);
    } catch (err) {
      setErrorMsg(getFriendlyError(err, 'Failed to save marks.'));
      setSyncStatus('error');
      showToast(getFriendlyError(err, 'Failed to save marks'), 'error');
      setTimeout(() => setSyncStatus('idle'), 5000);
    } finally {
      setSubmitting(false);
    }
  };

  const openEditDialog = (student) => {
    setEditStudent(student);
    setEditNewMarks(marks[student.id] || '');
    setEditReason('');
    setEditCustomReason('');
    setEditDialogVisible(true);
  };

  const handleEditSubmit = async () => {
    if (!editStudent || !entrySubject || !exam) return;
    const finalReason = editReason === 'Other' ? editCustomReason.trim() : editReason;
    if (!finalReason) { showToast('Please select or enter a reason for editing.', 'error'); return; }
    const newVal = parseInt(editNewMarks);
    if (isNaN(newVal) || newVal < 0 || newVal > MAX_MARKS) { showToast(`Marks must be between 0 and ${MAX_MARKS}.`, 'error'); return; }

    setEditSubmitting(true);
    try {
      const res = await apiFetch('/marks/edit', {
        method: 'POST',
        body: JSON.stringify({
          studentId: editStudent.id,
          studentName: editStudent.name,
          classId: selectedClassId,
          className: selectedClass?.grade || '',
          subject: entrySubject.name,
          examType: exam.id,
          newMarks: newVal,
          maxMarks: MAX_MARKS,
          reason: finalReason,
          editedBy: currentUser?.name || currentUser?.email || roleId || 'teacher',
          version: marksVersions[editStudent.id],
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setConflictError(true);
        setEditDialogVisible(false);
        setErrorMsg('These marks were updated by someone else. Please refresh and try again.');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to update marks');
      setMarks(prev => ({ ...prev, [editStudent.id]: String(newVal) }));
      setEditDialogVisible(false);
      showToast(`Marks updated for ${editStudent.name}: ${data.oldMarks} → ${newVal}`, 'success');
    } catch (err) {
      showToast(getFriendlyError(err, 'Failed to update marks'), 'error');
    } finally {
      setEditSubmitting(false);
    }
  };

  const filledCount = Object.values(marks).filter(v => v !== '' && v !== undefined).length;
  const classAvgPct = filledCount > 0
    ? Math.round(Object.values(marks).reduce((sum, v) => sum + (parseInt(v) || 0), 0) / filledCount / MAX_MARKS * 100)
    : 0;

  if (permLoading || loadingClasses) {
    return (
      <View style={{ flex: 1, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.gold} size="large" />
        <Text style={{ color: C.muted, fontSize: 13, marginTop: 12 }}>Loading...</Text>
      </View>
    );
  }

  if (!isAdmin && allowedSubjects.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: C.navy }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20 }}>
          <TouchableOpacity onPress={onBack} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <Text style={{ fontWeight: '700', fontSize: 18, color: C.white }}>Enter Marks</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>{'📚'}</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.white, textAlign: 'center', marginBottom: 8 }}>No Subject Assigned</Text>
          <Text style={{ fontSize: 14, color: C.muted, textAlign: 'center', lineHeight: 22 }}>
            {'No subject or class has been assigned to your profile yet.\nPlease contact the Principal to set up your Academic Schedule.'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.navy }}>
      <Toast {...toast} onHide={() => setToast(t => ({ ...t, visible: false }))} />

      <Modal visible={editDialogVisible} transparent animationType="fade" onRequestClose={() => !editSubmitting && setEditDialogVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <View style={{ backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: C.border, width: '100%', maxWidth: 400, padding: 24 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ fontSize: 20 }}>{'✏️'}</Text>
                  <Text style={{ fontWeight: '700', fontSize: 17, color: C.white }}>Edit Marks</Text>
                </View>
                <TouchableOpacity onPress={() => !editSubmitting && setEditDialogVisible(false)} style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: C.navyMid, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: C.muted, fontSize: 16, fontWeight: '700' }}>{'×'}</Text>
                </TouchableOpacity>
              </View>

              {editStudent && (
                <View style={{ backgroundColor: C.navyMid, borderRadius: 12, padding: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.teal + '33', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: C.teal, fontWeight: '700', fontSize: 13 }}>{(editStudent.name[0] || '?').toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '600', fontSize: 14, color: C.white }}>{editStudent.name}</Text>
                    <Text style={{ color: C.muted, fontSize: 11 }}>{entrySubject?.name} · {exam?.label} · Current: {marks[editStudent.id] || '–'}/{MAX_MARKS}</Text>
                  </View>
                </View>
              )}

              <Text style={{ color: C.muted, fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 }}>NEW MARKS</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <TextInput
                  style={{
                    flex: 1, height: 44, borderRadius: 12, textAlign: 'center',
                    fontWeight: '700', fontSize: 20, color: C.white,
                    backgroundColor: C.navyMid, borderWidth: 1.5, borderColor: C.gold + '66',
                  }}
                  keyboardType="numeric"
                  maxLength={2}
                  placeholder="0"
                  placeholderTextColor={C.muted}
                  value={editNewMarks}
                  onChangeText={v => setEditNewMarks(v.replace(/[^0-9]/g, ''))}
                  editable={!editSubmitting}
                />
                <Text style={{ color: C.muted, fontSize: 16, fontWeight: '600' }}>/ {MAX_MARKS}</Text>
              </View>

              <Text style={{ color: C.muted, fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 }}>REASON FOR EDITING *</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {EDIT_REASONS.map(r => (
                  <TouchableOpacity key={r} onPress={() => !editSubmitting && setEditReason(r)}
                    style={{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, backgroundColor: editReason === r ? C.gold + '22' : C.navyMid, borderWidth: 1.5, borderColor: editReason === r ? C.gold : C.border }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: editReason === r ? C.gold : C.muted }}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {editReason === 'Other' && (
                <TextInput
                  style={{
                    height: 44, borderRadius: 12, paddingHorizontal: 14,
                    fontSize: 14, color: C.white, backgroundColor: C.navyMid,
                    borderWidth: 1.5, borderColor: C.border, marginBottom: 10,
                  }}
                  placeholder="Enter reason..."
                  placeholderTextColor={C.muted}
                  value={editCustomReason}
                  onChangeText={setEditCustomReason}
                  editable={!editSubmitting}
                />
              )}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <TouchableOpacity onPress={() => !editSubmitting && setEditDialogVisible(false)}
                  style={{ flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: C.muted }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleEditSubmit} disabled={editSubmitting || !editReason || (editReason === 'Other' && !editCustomReason.trim())}
                  style={{ flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: C.gold, opacity: editSubmitting || !editReason ? 0.5 : 1 }}>
                  {editSubmitting
                    ? <ActivityIndicator size="small" color={C.navy} />
                    : <Text style={{ fontWeight: '700', fontSize: 14, color: C.navy }}>Update Marks</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ScrollView style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20 }}>
          <TouchableOpacity onPress={onBack} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '700', fontSize: 18, color: C.white }}>{mode === 'entry' ? 'Enter Marks' : 'View Marks'}</Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {mode === 'entry'
                ? `${selectedClass?.label || 'Select class'} · ${entrySubject?.name || ''} · ${exam?.label || ''}`
                : `${allClasses.find(c => c.id === viewClassId)?.label || 'Select class'} · All Subjects (Read Only)`}
            </Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, paddingBottom: 24 }}>
          <View style={{ flexDirection: 'row', backgroundColor: C.navyMid, borderRadius: 12, padding: 4, gap: 4, marginBottom: 16 }}>
            <TouchableOpacity onPress={() => setMode('entry')} style={{ flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center', backgroundColor: mode === 'entry' ? C.gold : 'transparent' }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: mode === 'entry' ? C.navy : C.muted }}>{'✏️ Entry Mode'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMode('view')} style={{ flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center', backgroundColor: mode === 'view' ? C.teal : 'transparent' }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: mode === 'view' ? C.white : C.muted }}>{'👁 View Mode'}</Text>
            </TouchableOpacity>
          </View>

          {mode === 'entry' ? renderEntryMode() : renderViewMode()}
        </View>
      </ScrollView>
    </View>
  );

  function renderEntryMode() {
    const subjectColor = entrySubject?.color || C.gold;
    return (
      <>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
          <TouchableOpacity
            style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: subjectColor + '55', borderRadius: 14, padding: 12 }}
            onPress={() => { setShowSubjectPicker(p => !p); setShowExamPicker(false); setShowClassPicker(false); }}
          >
            <Text style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>SUBJECT</Text>
            <Text style={{ color: subjectColor, fontWeight: '600', fontSize: 14 }}>{entrySubject?.name || 'Select'} {'▾'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12 }}
            onPress={() => { setShowExamPicker(p => !p); setShowSubjectPicker(false); setShowClassPicker(false); }}
          >
            <Text style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>EXAM TYPE</Text>
            <Text style={{ color: C.white, fontWeight: '600', fontSize: 14 }}>{exam.label} {'▾'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.teal + '55', borderRadius: 14, padding: 12, marginBottom: 10 }}
          onPress={() => { setShowClassPicker(p => !p); setShowSubjectPicker(false); setShowExamPicker(false); }}
        >
          <Text style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>CLASS / SECTION</Text>
          <Text style={{ color: C.teal, fontWeight: '600', fontSize: 14 }}>{selectedClass?.label || 'Select Class'} {'▾'}</Text>
        </TouchableOpacity>

        {showSubjectPicker && (
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, marginBottom: 12, overflow: 'hidden' }}>
            {allowedSubjects.map((s, i) => (
              <TouchableOpacity key={s.name} onPress={() => { setSelectedSubjectIdx(i); setShowSubjectPicker(false); }}
                style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: i === selectedSubjectIdx ? s.color + '22' : 'transparent', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: s.color }} />
                <Text style={{ color: i === selectedSubjectIdx ? s.color : C.white, fontWeight: '600', fontSize: 14, flex: 1 }}>{s.name}</Text>
                {i === selectedSubjectIdx && <Icon name="check" size={14} color={s.color} />}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {showExamPicker && (
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, marginBottom: 12, overflow: 'hidden' }}>
            {EXAM_TYPES.map((e, i) => {
              const isSubmitted = submittedExams.has(e.id);
              return (
                <TouchableOpacity key={e.id}
                  onPress={() => { if (!isSubmitted) { setSelectedExamIdx(i); setShowExamPicker(false); } }}
                  style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: i === selectedExamIdx ? C.gold + '22' : 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: isSubmitted ? 0.5 : 1 }}>
                  <Text style={{ color: i === selectedExamIdx ? C.gold : isSubmitted ? C.muted : C.white, fontWeight: '600', fontSize: 14 }}>{e.label}</Text>
                  {isSubmitted && (
                    <View style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8, backgroundColor: C.teal + '22' }}>
                      <Text style={{ color: C.teal, fontSize: 11, fontWeight: '700' }}>✓ Submitted</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {showClassPicker && (
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, marginBottom: 12, overflow: 'hidden', maxHeight: 250 }}>
            <ScrollView nestedScrollEnabled>
              {entryClasses.length === 0 ? (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ color: C.muted, fontSize: 13 }}>No classes available for this subject</Text>
                </View>
              ) : entryClasses.map(c => (
                <TouchableOpacity key={c.id} onPress={() => { setSelectedClassId(c.id); setShowClassPicker(false); }}
                  style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: c.id === selectedClassId ? C.teal + '22' : 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: c.id === selectedClassId ? C.teal : C.white, fontWeight: '600', fontSize: 14 }}>{c.label}</Text>
                  {c.id === selectedClassId && <Icon name="check" size={14} color={C.teal} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {!isAdmin && entrySubject && (
          <View style={{ backgroundColor: subjectColor + '15', borderWidth: 1, borderColor: subjectColor + '33', borderRadius: 12, padding: 10, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: subjectColor }} />
            <Text style={{ color: subjectColor, fontSize: 12, fontWeight: '600', flex: 1 }}>
              {'Entry: '}{entrySubject.name}{' · '}{exam.label}{' · Max '}{MAX_MARKS}{' marks per student'}
            </Text>
          </View>
        )}

        {loadingStudents || loadingMarks ? (
          <View style={{ alignItems: 'center', paddingVertical: 32 }}>
            <ActivityIndicator size="small" color={C.teal} />
            <Text style={{ color: C.muted, marginTop: 8, fontSize: 13 }}>{loadingStudents ? 'Loading students...' : 'Loading existing marks...'}</Text>
          </View>
        ) : students.length === 0 ? (
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 28, alignItems: 'center', marginBottom: 16 }}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>{'👥'}</Text>
            <Text style={{ color: C.muted, fontSize: 14, textAlign: 'center' }}>
              {'No students enrolled in this class.\nAsk Admin to add students.'}
            </Text>
          </View>
        ) : (
          <>
            {filledCount > 0 && (
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                <View style={{ flex: 1, backgroundColor: C.teal + '18', borderWidth: 1, borderColor: C.teal + '33', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 20, fontWeight: '700', color: C.teal }}>{filledCount}/{students.length}</Text>
                  <Text style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>Filled</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: C.gold + '18', borderWidth: 1, borderColor: C.gold + '33', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 20, fontWeight: '700', color: C.gold }}>{classAvgPct}%</Text>
                  <Text style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>Class Avg</Text>
                </View>
              </View>
            )}

            <ErrorBanner message={errorMsg} onDismiss={() => { setErrorMsg(''); setConflictError(false); }} />
            {conflictError && (
              <TouchableOpacity
                onPress={() => {
                  setConflictError(false);
                  setErrorMsg('');
                  if (selectedClassId && exam && entrySubject) {
                    setLoadingMarks(true);
                    apiFetch(`/marks/view?examType=${exam.id}&classId=${selectedClassId}`)
                      .then(r => r.json())
                      .then(data => {
                        const updated = {};
                        const versions = {};
                        (data.marks || []).forEach(m => {
                          if (normalizeSubject(m.subject) === normalizeSubject(entrySubject.name)) {
                            updated[m.studentId] = String(m.marksObtained);
                            if (m.version !== undefined) versions[m.studentId] = m.version;
                          }
                        });
                        setMarks(updated);
                        setMarksVersions(versions);
                      })
                      .catch(() => {})
                      .finally(() => setLoadingMarks(false));
                  }
                }}
                style={{ marginHorizontal: 20, marginBottom: 8, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold + '66', borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}
                activeOpacity={0.7}
              >
                <Text style={{ color: C.gold, fontWeight: '700', fontSize: 13 }}>↻ Refresh Marks</Text>
              </TouchableOpacity>
            )}

            <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 16, marginBottom: 16 }}>
              {students.map((s, idx) => {
                const val = marks[s.id] || '';
                const vNum = parseInt(val);
                const grade = val !== '' ? getGrade(val, MAX_MARKS) : null;
                const hasError = validationErrors[s.id];
                const isLocked = submittedExams.has(exam?.id);
                return (
                  <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: idx < students.length - 1 ? 1 : 0, borderBottomColor: C.border }}>
                    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: s.color + '33', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: s.color, fontWeight: '700', fontSize: 13 }}>{s.name[0].toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontWeight: '600', fontSize: 13, color: C.white }}>{s.name}</Text>
                      <Text style={{ color: C.muted, fontSize: 11 }}>Roll #{s.roll || '–'}</Text>
                    </View>
                    <View style={{ alignItems: 'center', gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        {isLocked ? (
                          <View style={{
                            width: 52, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                            backgroundColor: C.navyMid, borderWidth: 1.5, borderColor: val !== '' ? subjectColor + '44' : C.border,
                          }}>
                            <Text style={{ fontWeight: '700', fontSize: 16, color: val !== '' ? C.white : C.muted }}>{val || '–'}</Text>
                          </View>
                        ) : (
                          <TextInput
                            style={{
                              width: 52, height: 38, borderRadius: 10, textAlign: 'center',
                              fontWeight: '700', fontSize: 16, color: hasError ? C.coral : (val !== '' ? C.white : C.muted),
                              backgroundColor: hasError ? C.coral + '22' : C.navyMid,
                              borderWidth: 1.5, borderColor: hasError ? C.coral : (val !== '' ? subjectColor + '66' : C.border),
                            }}
                            keyboardType="numeric"
                            maxLength={2}
                            placeholder="–"
                            placeholderTextColor={C.muted}
                            value={val}
                            onChangeText={v => handleMarksChange(s.id, v)}
                          />
                        )}
                        <Text style={{ color: C.muted, fontSize: 12 }}>/{MAX_MARKS}</Text>
                        {isLocked && (
                          <TouchableOpacity onPress={() => openEditDialog(s)} style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold + '44', alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ fontSize: 14 }}>{'✏️'}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      {hasError ? (
                        <Text style={{ color: C.coral, fontSize: 9 }}>{validationErrors[s.id]}</Text>
                      ) : grade ? (
                        <Text style={{ color: grade.c, fontSize: 11, fontWeight: '700' }}>{grade.g}</Text>
                      ) : null}
                    </View>
                    <TouchableOpacity
                      onPress={() => generateReportCard(s.id, s.name)}
                      style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: C.gold + '22', marginLeft: 8 }}
                    >
                      <Text style={{ fontSize: 11, color: C.gold, fontWeight: '700' }}>📄 RC</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>

            {submittedExams.has(exam?.id) && (
              <View style={{ backgroundColor: C.teal + '15', borderWidth: 1, borderColor: C.teal + '44', borderRadius: 14, padding: 14, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ fontSize: 20 }}>🔒</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.teal, fontWeight: '700', fontSize: 13 }}>Marks Already Submitted</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{exam?.label} marks for {entrySubject?.name} have already been submitted. To edit a student's marks, use the ✏️ edit button in View Mode.</Text>
                </View>
              </View>
            )}

            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting || students.length === 0 || submittedExams.has(exam?.id)}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                paddingVertical: 14, borderRadius: 14,
                backgroundColor: syncStatus === 'synced' ? '#34D399' : subjectColor,
                marginBottom: 10, opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? <ActivityIndicator size="small" color={C.white} /> : <Icon name="check" size={18} color={C.white} />}
              <Text style={{ fontWeight: '600', fontSize: 15, color: C.white }}>
                {submitting ? 'Saving...' : syncStatus === 'synced' ? 'Saved ✓' : `Save ${exam.label} Marks`}
              </Text>
            </TouchableOpacity>
            <Text style={{ textAlign: 'center', fontSize: 12, color: C.muted, marginBottom: 8 }}>
              {'Saves to Firebase + Google Sheet · '}{students.length}{' student'}{students.length !== 1 ? 's' : ''}
            </Text>
          </>
        )}
      </>
    );
  }

  function renderViewMode() {
    const viewClass = allClasses.find(c => c.id === viewClassId);
    const viewSubjects = viewData?.classAvgBySubject || [];
    const viewExam = EXAM_TYPES[viewExamIdx];
    const allStudents = viewData?.students || [];
    const filteredByExam = viewExamIdx >= 0
      ? allStudents.map(s => ({
          ...s,
          examMarks: s.byExam?.find(e => e.examType === viewExam.id),
        }))
      : allStudents;

    return (
      <>
        <TouchableOpacity
          style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.teal + '55', borderRadius: 14, padding: 12, marginBottom: 10 }}
          onPress={() => setShowViewClassPicker(p => !p)}
        >
          <Text style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>CLASS</Text>
          <Text style={{ color: C.teal, fontWeight: '600', fontSize: 14 }}>{viewClass?.label || 'Select Class'} {'▾'}</Text>
        </TouchableOpacity>

        {showViewClassPicker && (
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, marginBottom: 12, overflow: 'hidden', maxHeight: 250 }}>
            <ScrollView nestedScrollEnabled>
              {viewClasses.map(c => (
                <TouchableOpacity key={c.id}
                  onPress={() => { setViewClassId(c.id); setShowViewClassPicker(false); loadViewData(c.id); }}
                  style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: c.id === viewClassId ? C.teal + '22' : 'transparent' }}>
                  <Text style={{ color: c.id === viewClassId ? C.teal : C.white, fontWeight: '600', fontSize: 14 }}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {EXAM_TYPES.map((e, i) => (
            <TouchableOpacity key={e.id} onPress={() => setViewExamIdx(i)}
              style={{ paddingVertical: 7, paddingHorizontal: 14, borderRadius: 10, backgroundColor: i === viewExamIdx ? C.gold + '22' : C.navyMid, borderWidth: 1.5, borderColor: i === viewExamIdx ? C.gold : C.border }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: i === viewExamIdx ? C.gold : C.muted }}>{e.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loadingView ? (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={C.teal} />
            <Text style={{ color: C.muted, marginTop: 12, fontSize: 13 }}>Loading marks...</Text>
          </View>
        ) : !viewData || allStudents.length === 0 ? (
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 28, alignItems: 'center' }}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>{'📊'}</Text>
            <Text style={{ color: C.muted, fontSize: 14, textAlign: 'center' }}>
              {!viewClassId ? 'Select a class to view marks.' : 'No marks entered yet for this class.'}
            </Text>
          </View>
        ) : (
          <>
            {viewSubjects.length > 0 && (
              <View style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 14, marginBottom: 14 }}>
                <Text style={{ color: C.muted, fontSize: 11, fontWeight: '700', marginBottom: 10, letterSpacing: 0.5 }}>{'📈 CLASS AVERAGES'}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {viewSubjects.map(sv => {
                    const subj = ALL_SUBJECTS.find(s => normalizeSubject(s.name) === normalizeSubject(sv.subject));
                    const col = subj?.color || C.muted;
                    return (
                      <View key={sv.subject} style={{ backgroundColor: col + '18', borderWidth: 1, borderColor: col + '33', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, minWidth: 90 }}>
                        <Text style={{ color: col, fontWeight: '800', fontSize: 16 }}>{sv.pct}%</Text>
                        <Text style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{sv.subject}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 16, marginBottom: 16 }}>
              {filteredByExam.map((s, idx) => {
                const examMarks = s.examMarks;
                return (
                  <View key={s.studentId} style={{ paddingVertical: 14, borderBottomWidth: idx < filteredByExam.length - 1 ? 1 : 0, borderBottomColor: C.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.teal + '33', alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ color: C.teal, fontWeight: '700', fontSize: 13 }}>{(s.name[0] || '?').toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: '600', fontSize: 14, color: C.white }}>{s.name}</Text>
                      </View>
                      <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.gold + '22' }}>
                        <Text style={{ color: C.gold, fontWeight: '700', fontSize: 13 }}>{s.overallPct}%</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 44 }}>
                      {(examMarks
                        ? examMarks.subjects
                        : ['English', 'Mathematics', 'Science', 'Social Studies', 'Telugu'].map(subject => ({ subject, marks: null, maxMarks: 20, notEntered: true }))
                      ).map(sv => {
                        const subName = sv.subject;
                        const subj = ALL_SUBJECTS.find(a => normalizeSubject(a.name) === normalizeSubject(subName));
                        const col = sv.notEntered ? C.muted : (subj?.color || C.muted);
                        const m = (!sv.notEntered && sv.marks !== null && sv.marks !== undefined) ? sv.marks : null;
                        const maxM = sv.maxMarks || MAX_MARKS;
                        return (
                          <View key={subName} style={{ backgroundColor: col + '18', borderWidth: 1, borderColor: col + '33', borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10, minWidth: 80, opacity: sv.notEntered ? 0.45 : 1 }}>
                            <Text style={{ color: col, fontWeight: '700', fontSize: 13 }}>
                              {m !== null ? `${m}/${maxM}` : '–'}
                            </Text>
                            <Text style={{ color: C.muted, fontSize: 9, marginTop: 2 }}>{subName}</Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </>
    );
  }
}
