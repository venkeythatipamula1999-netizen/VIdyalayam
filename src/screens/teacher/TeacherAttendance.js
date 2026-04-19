import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Modal, BackHandler, Alert } from 'react-native';
import { C } from '../../theme/colors';
import { StudentProfileModal } from './TeacherDashboard';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import ErrorBanner from '../../components/ErrorBanner';
import Toast from '../../components/Toast';
import { getFriendlyError } from '../../utils/errorMessages';

function getToday() {
  return new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function normalizeGrade(s) {
  return (s || '').trim().replace(/^Grade\s+/i, '').toLowerCase();
}

function EditDialog({ student, onSave, onCancel, saving }) {
  const isLeave = student.currentStatus === 'Leave';
  const [newStatus, setNewStatus] = useState(
    student.currentStatus === 'Absent' ? 'Present' : 'Absent'
  );
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');

  const handleSave = () => {
    if (!reason.trim()) {
      setReasonError('Reason is required to edit attendance.');
      return;
    }
    onSave({ newStatus, reason: reason.trim() });
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(5,15,30,0.9)', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: '#0F2340', borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 24 }}>
          <Text style={{ fontWeight: '700', fontSize: 17, color: C.white, marginBottom: 4 }}>Edit Attendance</Text>
          <Text style={{ color: C.muted, fontSize: 13, marginBottom: 12 }}>{student.name} {'·'} Roll #{student.roll || '–'}</Text>

          {isLeave && (
            <View style={{ backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold + '55', borderRadius: 12, padding: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 16 }}>⚠️</Text>
              <Text style={{ color: C.gold, fontSize: 12, fontWeight: '600', flex: 1 }}>
                This student is on approved Leave. Editing will override the leave record.
              </Text>
            </View>
          )}

          <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 }}>Current Status</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <View style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 10, backgroundColor: isLeave ? C.gold + '33' : student.currentStatus === 'Present' ? C.teal + '33' : C.coral + '33' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: isLeave ? C.gold : student.currentStatus === 'Present' ? C.teal : C.coral }}>{student.currentStatus}</Text>
            </View>
            <Text style={{ color: C.muted }}>{'→'}</Text>
            <TouchableOpacity
              onPress={() => setNewStatus(s => s === 'Present' ? 'Absent' : 'Present')}
              style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 10, backgroundColor: newStatus === 'Present' ? C.teal + '55' : C.coral + '55', borderWidth: 2, borderColor: newStatus === 'Present' ? C.teal : C.coral }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: newStatus === 'Present' ? C.teal : C.coral }}>{newStatus} (tap to toggle)</Text>
            </TouchableOpacity>
          </View>

          <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 }}>Reason for Edit <Text style={{ color: C.coral }}>*</Text></Text>
          <TextInput
            style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: reasonError ? C.coral : C.border, borderRadius: 12, padding: 14, color: C.white, fontSize: 14, minHeight: 70, textAlignVertical: 'top', marginBottom: 6 }}
            placeholder="Explain why you are editing this attendance record..."
            placeholderTextColor={C.muted}
            value={reason}
            onChangeText={t => { setReason(t); if (t.trim()) setReasonError(''); }}
            multiline
          />
          {reasonError ? <Text style={{ color: C.coral, fontSize: 12, marginBottom: 12 }}>{reasonError}</Text> : <View style={{ height: 12 }} />}

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity onPress={onCancel} style={{ flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, alignItems: 'center' }}>
              <Text style={{ color: C.muted, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSave} disabled={saving} style={{ flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: isLeave ? C.coral : C.gold, alignItems: 'center', opacity: saving ? 0.7 : 1 }}>
              {saving ? <ActivityIndicator size="small" color={C.navy} /> : <Text style={{ color: C.navy, fontWeight: '700' }}>{isLeave ? 'Override Leave' : 'Save Edit'}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function TeacherAttendance({ onBack, currentUser }) {
  const isAdmin = currentUser?.role === 'principal';
  const roleId = currentUser?.role_id || null;

  const [allClasses, setAllClasses] = useState([]);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [freshProfile, setFreshProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(!!roleId && !isAdmin);

  const [students, setStudents] = useState([]);
  const [loadingStudents, setLoadingStudents] = useState(false);

  const [selectedClass, setSelectedClass] = useState('');
  const [date, setDate] = useState(getToday());
  const [showClassPicker, setShowClassPicker] = useState(false);
  const [absentSet, setAbsentSet] = useState(new Set());
  const [searchText, setSearchText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [errorMsg, setErrorMsg] = useState('');

  const [submissionStatus, setSubmissionStatus] = useState(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [submittedRecords, setSubmittedRecords] = useState([]);

  const [editingStudent, setEditingStudent] = useState(null);
  const [savingEdit, setSavingEdit] = useState(null);
  const [selectedProfileStudent, setSelectedProfileStudent] = useState(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const classTeacherOf = freshProfile?.classTeacherOf || currentUser?.classTeacherOf || null;
  const normalizedCT = normalizeGrade(classTeacherOf);

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

    if (roleId && !isAdmin) {
      apiFetch('/teacher/profile?roleId=' + encodeURIComponent(roleId) + '&t=' + Date.now(), { cache: 'no-store' })
        .then(r => r.json())
        .then(data => { if (!data.error) setFreshProfile(data); })
        .catch(() => {})
        .finally(() => setLoadingProfile(false));
    }
  }, [roleId, isAdmin]);

  const CLASSES = useMemo(() => {
    if (isAdmin) return allClasses;
    if (normalizedCT) {
      return allClasses.filter(c => normalizeGrade(c.grade) === normalizedCT);
    }
    return [];
  }, [allClasses, normalizedCT, isAdmin]);

  useEffect(() => {
    if (CLASSES.length > 0 && !selectedClass) {
      setSelectedClass(CLASSES[0].id);
    }
  }, [CLASSES]);

  useEffect(() => {
    if (!selectedClass) {
      setStudents([]);
      setSubmissionStatus(null);
      return;
    }
    setLoadingStudents(true);
    setAbsentSet(new Set());
    setSearchText('');
    setSubmissionStatus(null);
    setSubmittedRecords([]);

    const studentFetch = apiFetch('/students/' + selectedClass + '?t=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.students)) {
          return data.students.map(s => ({
            id: s.id,
            name: s.name || s.studentName || s.fullName || 'Unknown',
            roll: s.rollNumber || s.roll || 0,
          }));
        }
        return [];
      });

    studentFetch
      .then(studs => {
        setStudents(studs);
        setLoadingStudents(false);
        return studs;
      })
      .catch(() => { setStudents([]); setLoadingStudents(false); return []; });
  }, [selectedClass]);

  const checkSubmissionStatus = useCallback(async () => {
    if (!selectedClass || !date) return;
    setCheckingStatus(true);
    try {
      const res = await apiFetch(`/attendance/submission-status?classId=${selectedClass}&date=${date}&t=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      setSubmissionStatus(data.submitted ? data : null);
      if (data.submitted && students.length > 0) {
        const attQ = await apiFetch(`/attendance/records?classId=${selectedClass}&date=${date}`);
        const attRecs = await attQ.json();
        if (attRecs.records) {
          const statusMap = {};
          attRecs.records.forEach(r => { statusMap[r.studentId] = r.status; });
          setSubmittedRecords(students.map(s => ({
            id: s.id,
            name: s.name,
            roll: s.roll || 0,
            currentStatus: statusMap[s.id] || 'Present',
          })));
        }
      }
    } catch (e) {
      console.error('Submission status check error:', e.message);
    } finally {
      setCheckingStatus(false);
    }
  }, [selectedClass, date, students]);

  useEffect(() => {
    if (selectedClass && date && students.length >= 0 && !loadingStudents) {
      checkSubmissionStatus();
    }
  }, [selectedClass, date, loadingStudents]);

  const classInfo = CLASSES.find(c => c.id === selectedClass);
  const canMarkAttendance = isAdmin || (normalizedCT && classInfo && normalizeGrade(classInfo.grade) === normalizedCT);
  const filteredStudents = searchText
    ? students.filter(s => s.name.toLowerCase().includes(searchText.toLowerCase()))
    : students;
  const presentCount = students.length - absentSet.size;
  const absentCount = absentSet.size;

  const toggleStudent = (id) => {
    if (!canMarkAttendance) return;
    const s = new Set(absentSet);
    s.has(id) ? s.delete(id) : s.add(id);
    setAbsentSet(s);
  };
  const markAllPresent = () => setAbsentSet(new Set());
  const markAllAbsent = () => setAbsentSet(new Set(students.map(s => s.id)));

  const showToast = (msg, type = 'success') => setToast({ visible: true, message: msg, type });

  const handleSubmit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setErrorMsg('Invalid date format. Please use YYYY-MM-DD.');
      return;
    }
    if (students.length === 0) {
      setErrorMsg('No students to submit attendance for.');
      return;
    }
    setSubmitting(true);
    setSyncStatus('syncing');
    setErrorMsg('');
    try {
      const records = students.map(s => ({
        studentId: s.id,
        studentName: s.name,
        rollNumber: s.roll || 0,
        classId: selectedClass,
        className: classInfo?.grade || '',
        schoolId: currentUser?.schoolId || 'school_001',
        date,
        month: date.substring(0, 7),
        status: absentSet.has(s.id) ? 'Absent' : 'Present',
        markedBy: currentUser?.role_id || currentUser?.email || 'teacher',
      }));
      const res = await apiFetch('/attendance/save', {
        method: 'POST',
        body: JSON.stringify({
          records,
          date,
          teacherName: currentUser?.full_name || currentUser?.role_id || 'Teacher',
          className: classInfo?.grade || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save attendance');
      setSyncStatus(data.sheetSync ? 'synced' : 'partial');
      const className = classInfo?.label || ('Grade ' + (classInfo?.grade || ''));
      showToast(
        `Attendance submitted successfully for ${className} on ${formatDate(date)}.` +
        (data.sheetSync ? ' Synced to Google Sheets.' : ''),
        'success'
      );
      const pct = students.length > 0
        ? Math.round(((students.length - absentSet.size) / students.length) * 100)
        : 100;
      if (pct < 75) {
        Alert.alert(
          '⚠️ Low Attendance',
          `Class attendance is ${pct}% — below the 75% threshold. ${absentSet.size} student${absentSet.size !== 1 ? 's' : ''} marked absent.`,
          [{ text: 'OK' }]
        );
      }
      setTimeout(() => setSyncStatus('idle'), 5000);
      await checkSubmissionStatus();
    } catch (err) {
      const msg = getFriendlyError(err, 'Failed to save. Please check your connection.');
      setErrorMsg(msg);
      setSyncStatus('error');
      showToast(msg, 'error');
      setTimeout(() => setSyncStatus('idle'), 5000);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSave = async ({ newStatus, reason }) => {
    if (!editingStudent) return;
    setSavingEdit(editingStudent.id);
    try {
      const res = await apiFetch('/attendance/edit', {
        method: 'POST',
        body: JSON.stringify({
          studentId: editingStudent.id,
          studentName: editingStudent.name,
          rollNumber: editingStudent.roll || 0,
          classId: selectedClass,
          className: classInfo?.grade || '',
          date,
          oldStatus: editingStudent.currentStatus,
          newStatus,
          reason,
          editedBy: currentUser?.role_id || currentUser?.email || 'teacher',
          teacherName: currentUser?.full_name || currentUser?.role_id || 'Teacher',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update attendance');

      const updatedRecords = submittedRecords.map(r =>
        r.id === editingStudent.id ? { ...r, currentStatus: newStatus } : r
      );
      setSubmittedRecords(updatedRecords);

      if (data.newCounts) {
        setSubmissionStatus(prev => prev ? { ...prev, ...data.newCounts } : prev);
      } else {
        const livePresent = updatedRecords.filter(r => r.currentStatus === 'Present').length;
        const liveAbsent = updatedRecords.filter(r => r.currentStatus === 'Absent').length;
        setSubmissionStatus(prev => prev ? {
          ...prev,
          presentCount: livePresent,
          absentCount: liveAbsent,
          lastEditedAt: new Date().toISOString(),
          lastEditedBy: currentUser?.full_name || currentUser?.role_id || 'Teacher',
        } : prev);
      }

      setEditingStudent(null);
      showToast('Attendance updated successfully.' + (data.sheetSync ? ' Synced to Google Sheets.' : ''), 'success');
    } catch (err) {
      showToast(getFriendlyError(err, 'Failed to update attendance.'), 'error');
    } finally {
      setSavingEdit(null);
    }
  };

  const isLoading = loadingClasses || loadingProfile;

  if (!isLoading && !isAdmin && !normalizedCT) {
    return (
      <View style={{ flex: 1, backgroundColor: C.navy }}>
      <StudentProfileModal visible={!!selectedProfileStudent} onClose={() => setSelectedProfileStudent(null)} student={selectedProfileStudent} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20 }}>
          <TouchableOpacity onPress={onBack} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <Text style={{ fontWeight: '700', fontSize: 18, color: C.white }}>Mark Attendance</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>{'📋'}</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.white, textAlign: 'center', marginBottom: 8 }}>Not a Class Teacher</Text>
          <Text style={{ fontSize: 14, color: C.muted, textAlign: 'center', lineHeight: 22 }}>
            {'You are not assigned as a Class Teacher for any class.\nPlease contact Admin to get your class assigned.'}
          </Text>
        </View>
      </View>
    );
  }

  const isSubmitted = submissionStatus && submissionStatus.submitted;

  return (
    <View style={{ flex: 1, backgroundColor: C.navy }}>
      {editingStudent && (
        <EditDialog
          student={editingStudent}
          onSave={handleEditSave}
          onCancel={() => setEditingStudent(null)}
          saving={savingEdit === editingStudent.id}
        />
      )}

      <Toast {...toast} onHide={() => setToast(t => ({ ...t, visible: false }))} />

      <ScrollView style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20 }}>
          <TouchableOpacity onPress={onBack} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '700', fontSize: 18, color: C.white }}>Mark Attendance</Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {classInfo?.label || 'Select a class'}
              {classInfo ? ' · ' + formatDate(date) : ''}
            </Text>
          </View>
          {isSubmitted && (
            <View style={{ backgroundColor: '#34D39922', borderWidth: 1, borderColor: '#34D39955', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8 }}>
              <Text style={{ color: '#34D399', fontSize: 11, fontWeight: '700' }}>{'✓ Submitted'}</Text>
            </View>
          )}
        </View>

        <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          {isLoading ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <ActivityIndicator size="large" color={C.teal} />
              <Text style={{ color: C.muted, marginTop: 12, fontSize: 13 }}>Loading class data...</Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                <TouchableOpacity
                  style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: isAdmin ? C.border : C.teal + '55', borderRadius: 14, padding: 12 }}
                  onPress={() => isAdmin && setShowClassPicker(!showClassPicker)}
                >
                  <Text style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>CLASS</Text>
                  <Text style={{ color: classInfo ? C.white : C.muted, fontWeight: '600', fontSize: 14 }}>
                    {classInfo?.label || 'No class assigned'}
                    {isAdmin ? ' \u25BE' : ''}
                  </Text>
                </TouchableOpacity>
                <View style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12 }}>
                  <Text style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>DATE</Text>
                  <TextInput
                    style={{ color: isSubmitted ? C.muted : C.white, fontWeight: '600', fontSize: 14, padding: 0 }}
                    value={date}
                    onChangeText={v => { setDate(v); setSubmissionStatus(null); }}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={C.muted}
                    editable={!isSubmitted}
                  />
                </View>
              </View>

              {showClassPicker && isAdmin && (
                <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, marginBottom: 16, overflow: 'hidden' }}>
                  {CLASSES.map(cls => (
                    <TouchableOpacity
                      key={cls.id}
                      onPress={() => { setSelectedClass(cls.id); setShowClassPicker(false); }}
                      style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: cls.id === selectedClass ? C.gold + '22' : 'transparent' }}
                    >
                      <Text style={{ color: cls.id === selectedClass ? C.gold : C.white, fontWeight: '600', fontSize: 14 }}>{cls.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {!isAdmin && classTeacherOf && (
                <View style={{ backgroundColor: C.teal + '15', borderWidth: 1, borderColor: C.teal + '33', borderRadius: 12, padding: 10, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 16 }}>{'🎓'}</Text>
                  <Text style={{ color: C.teal, fontSize: 12, fontWeight: '600', flex: 1 }}>
                    {'You are Class Teacher of Grade '}{classTeacherOf}
                  </Text>
                </View>
              )}

              {isSubmitted ? (
                <>
                  <View style={{ backgroundColor: '#34D39915', borderWidth: 1, borderColor: '#34D39944', borderRadius: 16, padding: 16, marginBottom: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <Text style={{ fontSize: 20 }}>{'✅'}</Text>
                      <Text style={{ color: '#34D399', fontWeight: '700', fontSize: 15 }}>Attendance Already Submitted</Text>
                    </View>
                    <Text style={{ color: C.muted, fontSize: 12, marginBottom: 2 }}>
                      {'By: '}{submissionStatus.teacherName || submissionStatus.submittedBy}
                      {' · '}{submissionStatus.submittedAt ? new Date(submissionStatus.submittedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}
                    </Text>
                    {submissionStatus.lastEditedAt && (
                      <Text style={{ color: '#FB923C', fontSize: 11, marginBottom: 6 }}>
                        {'Last edited by '}{submissionStatus.lastEditedBy || 'Teacher'}
                        {' · '}{new Date(submissionStatus.lastEditedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    )}
                    <View style={{ flexDirection: 'row', gap: 14, marginTop: 4 }}>
                      <View style={{ flex: 1, backgroundColor: '#34D39920', borderRadius: 10, padding: 10, alignItems: 'center' }}>
                        <Text style={{ color: '#34D399', fontWeight: '800', fontSize: 22 }}>{submissionStatus.presentCount}</Text>
                        <Text style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>Present</Text>
                      </View>
                      <View style={{ flex: 1, backgroundColor: C.coral + '20', borderRadius: 10, padding: 10, alignItems: 'center' }}>
                        <Text style={{ color: C.coral, fontWeight: '800', fontSize: 22 }}>{submissionStatus.absentCount}</Text>
                        <Text style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>Absent</Text>
                      </View>
                      <View style={{ flex: 1, backgroundColor: C.navyMid, borderRadius: 10, padding: 10, alignItems: 'center' }}>
                        <Text style={{ color: C.muted, fontWeight: '800', fontSize: 22 }}>{submissionStatus.totalCount}</Text>
                        <Text style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>Total</Text>
                      </View>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.navyMid, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: C.border }}>
                      <Icon name="search" size={16} color={C.muted} />
                      <TextInput
                        placeholder="Search student..."
                        placeholderTextColor={C.muted}
                        style={{ flex: 1, color: C.white, fontSize: 14 }}
                        value={searchText}
                        onChangeText={setSearchText}
                      />
                    </View>
                  </View>

                  {checkingStatus && submittedRecords.length === 0 ? (
                    <View style={{ padding: 28, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color={C.teal} />
                      <Text style={{ color: C.muted, marginTop: 8 }}>Loading records...</Text>
                    </View>
                  ) : (
                    <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 16, marginBottom: 20 }}>
                      {(searchText ? submittedRecords.filter(s => s.name.toLowerCase().includes(searchText.toLowerCase())) : submittedRecords).map((s, idx, arr) => (
                        <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: idx < arr.length - 1 ? 1 : 0, borderBottomColor: C.border }}>
                          <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: s.currentStatus === 'Present' ? C.teal + '33' : C.coral + '33', alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ color: s.currentStatus === 'Present' ? C.teal : C.coral, fontWeight: '700', fontSize: 14 }}>{(s.name[0] || '?').toUpperCase()}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontWeight: '600', fontSize: 14, color: C.white }}>{s.name}</Text>
                            <Text style={{ color: C.muted, fontSize: 12 }}>{'Roll #'}{s.roll || '–'}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: s.currentStatus === 'Present' ? C.teal + '22' : C.coral + '22' }}>
                              <Text style={{ fontSize: 12, fontWeight: '700', color: s.currentStatus === 'Present' ? C.teal : C.coral }}>{s.currentStatus}</Text>
                            </View>
                            {canMarkAttendance && (
                              <TouchableOpacity
                                onPress={() => setEditingStudent(s)}
                                style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}
                              >
                                <Text style={{ fontSize: 14 }}>{'✏️'}</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>
                      ))}
                      {submittedRecords.length === 0 && !checkingStatus && (
                        <View style={{ padding: 28, alignItems: 'center' }}>
                          <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>{'Detailed records loading. Tap ✏️ to edit individual students.'}</Text>
                        </View>
                      )}
                    </View>
                  )}
                </>
              ) : (
                <>
                  <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: C.teal + '22', borderWidth: 1, borderColor: C.teal + '44', borderRadius: 16, padding: 16, alignItems: 'center' }}>
                      <Text style={{ fontSize: 28, fontWeight: '700', color: C.teal }}>{loadingStudents ? '–' : presentCount}</Text>
                      <Text style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Present</Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 16, padding: 16, alignItems: 'center' }}>
                      <Text style={{ fontSize: 28, fontWeight: '700', color: C.coral }}>{loadingStudents ? '–' : absentCount}</Text>
                      <Text style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Absent</Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 16, alignItems: 'center' }}>
                      <Text style={{ fontSize: 28, fontWeight: '700', color: C.gold }}>{loadingStudents ? '–' : students.length}</Text>
                      <Text style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Total</Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.navyMid, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: C.border }}>
                      <Icon name="search" size={16} color={C.muted} />
                      <TextInput
                        placeholder="Search student..."
                        placeholderTextColor={C.muted}
                        style={{ flex: 1, color: C.white, fontSize: 14 }}
                        value={searchText}
                        onChangeText={setSearchText}
                      />
                    </View>
                  </View>

                  {!canMarkAttendance && selectedClass && (
                    <View style={{ backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold + '44', borderRadius: 12, padding: 14, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text style={{ fontSize: 20 }}>{'🔒'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: C.gold, fontWeight: '700', fontSize: 13 }}>View Only Mode</Text>
                        <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>Only the assigned Class Teacher or Admin can mark attendance.</Text>
                      </View>
                    </View>
                  )}

                  {canMarkAttendance && !loadingStudents && students.length > 0 && (
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                      <TouchableOpacity onPress={markAllPresent} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: C.teal + '22', borderWidth: 1, borderColor: C.teal + '44', alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: C.teal }}>All Present</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={markAllAbsent} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: C.coral }}>All Absent</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  <ErrorBanner message={errorMsg} onDismiss={() => setErrorMsg('')} />

                  <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 16, marginBottom: 20, minHeight: 80 }}>
                    {loadingStudents ? (
                      <View style={{ padding: 28, alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={C.teal} />
                        <Text style={{ color: C.muted, marginTop: 10, fontSize: 13 }}>Loading students...</Text>
                      </View>
                    ) : filteredStudents.length === 0 ? (
                      <View style={{ padding: 28, alignItems: 'center' }}>
                        <Text style={{ fontSize: 32, marginBottom: 8 }}>{'👥'}</Text>
                        <Text style={{ color: C.muted, fontSize: 14, textAlign: 'center' }}>
                          {students.length === 0 ? 'No students enrolled yet.\nAsk Admin to add students.' : 'No students match your search.'}
                        </Text>
                      </View>
                    ) : (
                      (() => {
    const presList = [];
    const absList = [];
    filteredStudents.forEach(s => {
      if (absentSet.has(s.id)) absList.push(s);
      else presList.push(s);
    });
    
    return (
      <View>
        {absList.length > 0 && (
          <View>
            <Text style={{ fontSize: 12, fontWeight: '700', color: C.coral, marginBottom: 8, marginTop: 8 }}>ABSENT ({absList.length})</Text>
            {absList.map((s, idx) => (
              <TouchableOpacity key={s.id} onPress={() => setSelectedProfileStudent({...s, className: classInfo?.grade})} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.coral + '33', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: C.coral, fontWeight: '700', fontSize: 14 }}>{(s.name[0] || '?').toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: C.white }}>{s.name}</Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{'Roll #'}{s.roll || '–'}</Text>
                </View>
                <TouchableOpacity onPress={() => toggleStudent(s.id)} disabled={!canMarkAttendance} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 20, overflow: 'hidden', opacity: canMarkAttendance ? 1 : 0.5 }}>
                  <View style={{ paddingVertical: 6, paddingHorizontal: 14, backgroundColor: C.navyMid, borderTopLeftRadius: 20, borderBottomLeftRadius: 20 }}><Text style={{ fontSize: 12, fontWeight: '700', color: C.muted }}>P</Text></View>
                  <View style={{ paddingVertical: 6, paddingHorizontal: 14, backgroundColor: C.coral, borderTopRightRadius: 20, borderBottomRightRadius: 20 }}><Text style={{ fontSize: 12, fontWeight: '700', color: C.white }}>A</Text></View>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}
        
        {presList.length > 0 && (
          <View>
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#34D399', marginBottom: 8, marginTop: absList.length > 0 ? 16 : 8 }}>PRESENT ({presList.length})</Text>
            {presList.map((s, idx) => (
              <TouchableOpacity key={s.id} onPress={() => setSelectedProfileStudent({...s, className: classInfo?.grade})} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.teal + '33', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: C.teal, fontWeight: '700', fontSize: 14 }}>{(s.name[0] || '?').toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: C.white }}>{s.name}</Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{'Roll #'}{s.roll || '–'}</Text>
                </View>
                <TouchableOpacity onPress={() => toggleStudent(s.id)} disabled={!canMarkAttendance} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 20, overflow: 'hidden', opacity: canMarkAttendance ? 1 : 0.5 }}>
                  <View style={{ paddingVertical: 6, paddingHorizontal: 14, backgroundColor: C.teal, borderTopLeftRadius: 20, borderBottomLeftRadius: 20 }}><Text style={{ fontSize: 12, fontWeight: '700', color: C.white }}>P</Text></View>
                  <View style={{ paddingVertical: 6, paddingHorizontal: 14, backgroundColor: C.navyMid, borderTopRightRadius: 20, borderBottomRightRadius: 20 }}><Text style={{ fontSize: 12, fontWeight: '700', color: C.muted }}>A</Text></View>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  })()
  //

                    )}
                  </View>

                  {selectedClass && students.length > 0 && canMarkAttendance && (
                    <>
                      <TouchableOpacity
                        onPress={handleSubmit}
                        disabled={submitting}
                        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 24, borderRadius: 14, backgroundColor: syncStatus === 'synced' ? '#34D399' : C.teal, marginBottom: 10, opacity: submitting ? 0.6 : 1 }}
                      >
                        {syncStatus === 'syncing' ? <ActivityIndicator size="small" color={C.white} /> : <Icon name="check" size={18} color={C.white} />}
                        <Text style={{ fontWeight: '600', fontSize: 15, color: C.white }}>
                          {submitting ? 'Saving...' : syncStatus === 'synced' ? 'Saved \u2713' : 'Submit Attendance'}
                        </Text>
                      </TouchableOpacity>
                      <Text style={{ textAlign: 'center', fontSize: 12, color: C.muted, marginBottom: 8 }}>
                        {'Saves to Firebase + Google Sheet · '}{students.length}{' student'}{students.length !== 1 ? 's' : ''}
                      </Text>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
