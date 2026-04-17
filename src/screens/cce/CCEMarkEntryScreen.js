import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView,
  Platform, Modal, Alert,
} from 'react-native';
import { C } from '../../theme/colors';
import Toast from '../../components/Toast';
import { apiFetch } from '../../api/client';
import {
  getFAGrade, isSAExam, isFAExam, getPrecedingFAs,
  calcHalfYear, MAX_MARKS, VALID_EXAM_TYPES,
} from '../../helpers/cceGradingMobile';
import { SUBJECT_IDS, getSubjectLabel } from '../../constants/subjects';

const GRADE_BG = { A1:'#059669', A2:'#10b981', B1:'#3b82f6', B2:'#6366f1', C1:'#f59e0b', C2:'#f97316', D:'#ef4444', E:'#dc2626' };
const EXAM_TYPES_ALL = ['FA1', 'FA2', 'FA3', 'FA4', 'SA1', 'SA2'];
const MIN_REASON_LEN = 10;

function ViewOnlySubjectCard({ subjectId, academicYear, classId, students }) {
  const [expanded, setExpanded] = useState(false);
  const [subMarks, setSubMarks] = useState({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    if (loaded) { setExpanded((value) => !value); return; }
    setExpanded(true);
    setLoading(true);
    try {
      const results = await Promise.all(
        EXAM_TYPES_ALL.map((examType) =>
          apiFetch(`/cce/marks?academicYear=${encodeURIComponent(academicYear)}&classId=${encodeURIComponent(classId)}&subjectId=${encodeURIComponent(subjectId)}&examType=${examType}`)
            .then((res) => res.json())
            .then((data) => ({ examType, marks: data.marks || [] }))
            .catch(() => ({ examType, marks: [] }))
        )
      );
      const map = {};
      for (const { examType, marks } of results) {
        for (const item of marks) {
          map[item.studentId] = map[item.studentId] || {};
          map[item.studentId][examType] = item.marks;
        }
      }
      setSubMarks(map);
      setLoaded(true);
    } catch {}
    finally { setLoading(false); }
  };

  return (
    <View style={vst.card}>
      <TouchableOpacity style={vst.header} onPress={load} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={vst.icon}>View Only</Text>
          <Text style={vst.title}>{getSubjectLabel(subjectId)}</Text>
        </View>
        {loading
          ? <ActivityIndicator size="small" color={C.muted} />
          : <Text style={{ color: C.muted, fontSize: 16 }}>{expanded ? '▲' : '▼'}</Text>}
      </TouchableOpacity>

      {expanded && !loading && (
        <View>
          <View style={vst.tableHead}>
            <Text style={[vst.th, vst.nameW]}>Student</Text>
            {EXAM_TYPES_ALL.map((examType) => (
              <Text key={examType} style={vst.th}>{examType}</Text>
            ))}
          </View>
          {students.map((student, index) => {
            const studentId = student.studentId || student.id;
            const row = subMarks[studentId] || {};
            return (
              <View key={studentId} style={[vst.row, index % 2 === 0 && vst.rowEven]}>
                <Text style={[vst.td, vst.nameW]} numberOfLines={1}>{student.studentName || student.name}</Text>
                {EXAM_TYPES_ALL.map((examType) => (
                  <Text key={examType} style={[vst.td, { color: row[examType] !== undefined ? C.white : C.muted }]}>
                    {row[examType] !== undefined ? row[examType] : '—'}
                  </Text>
                ))}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default function CCEMarkEntryScreen({ onBack, params = {}, route }) {
  const navParams = route?.params || {};
  const incoming = { ...params, ...navParams };
  const academicYear = incoming.academicYear || '2025-26';
  const classId = incoming.classId || '';
  const className = incoming.className || classId;
  const subjectId = incoming.subjectId || incoming.subject || '';
  const isAdmin = !!incoming.isAdmin;

  const [selectedExamType, setSelectedExamType] = useState(incoming.examType || 'FA1');
  const [students, setStudents] = useState([]);
  const [marks, setMarks] = useState({});
  const [faMarks, setFaMarks] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [editModal, setEditModal] = useState({ visible: false, studentId: null, pendingValue: null, previousValue: null });
  const [editReason, setEditReason] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const reasonInputRef = useRef(null);
  const savedMarkValues = useRef({});
  const inputs = useRef({});

  const maxM = MAX_MARKS[selectedExamType] || 20;
  const isSA = isSAExam(selectedExamType);
  const precedingFAs = getPrecedingFAs(selectedExamType);
  const isSA1 = selectedExamType === 'SA1';
  const otherSubjects = isAdmin ? SUBJECT_IDS.filter((subject) => subject !== subjectId) : [];

  const showToast = (message, type = 'success') => setToast({ visible: true, message, type });

  useEffect(() => {
    loadAll();
  }, [selectedExamType, classId, subjectId, academicYear]);

  const loadAll = async () => {
    if (!classId || !subjectId) {
      setStudents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [studentsRes, marksRes] = await Promise.all([
        apiFetch(`/students/list?classId=${encodeURIComponent(classId)}`).then((res) => res.json()),
        apiFetch(`/cce/marks?academicYear=${encodeURIComponent(academicYear)}&classId=${encodeURIComponent(classId)}&subjectId=${encodeURIComponent(subjectId)}&examType=${encodeURIComponent(selectedExamType)}`).then((res) => res.json()),
      ]);

      const nextStudents = (studentsRes.students || []).sort((a, b) =>
        (a.studentName || a.name || '').localeCompare(b.studentName || b.name || '')
      );
      setStudents(nextStudents);

      const marksMap = {};
      savedMarkValues.current = {};
      for (const item of (marksRes.marks || [])) {
        marksMap[item.studentId] = String(item.marks ?? '');
        savedMarkValues.current[item.studentId] = item.marks;
      }
      setMarks(marksMap);

      if (isSA && precedingFAs.length) {
        const faData = {};
        await Promise.all(precedingFAs.map(async (examType) => {
          const data = await apiFetch(`/cce/marks?academicYear=${encodeURIComponent(academicYear)}&classId=${encodeURIComponent(classId)}&subjectId=${encodeURIComponent(subjectId)}&examType=${examType}`).then((res) => res.json());
          for (const item of (data.marks || [])) {
            faData[item.studentId] = faData[item.studentId] || {};
            faData[item.studentId][examType] = item.marks;
          }
        }));
        setFaMarks(faData);
      } else {
        setFaMarks({});
      }
    } catch (error) {
      console.warn('CCEMarkEntry load error', error.message);
    } finally {
      setLoading(false);
    }
  };

  const onChangeMark = (studentId, value) => {
    const cleaned = value.replace(/[^0-9.]/g, '');
    const alreadySaved = savedMarkValues.current[studentId] !== undefined;
    if (alreadySaved) {
      setMarks((prev) => ({ ...prev, [studentId]: cleaned }));
      const numericValue = parseFloat(cleaned);
      if (cleaned !== '' && !isNaN(numericValue) && numericValue >= 0 && numericValue <= maxM) {
        clearTimeout(inputs.current[`timer_${studentId}`]);
        inputs.current[`timer_${studentId}`] = setTimeout(() => {
          setEditModal({
            visible: true,
            studentId,
            pendingValue: numericValue,
            previousValue: savedMarkValues.current[studentId],
          });
          setEditReason('');
          setTimeout(() => reasonInputRef.current?.focus(), 200);
        }, 800);
      }
    } else {
      setMarks((prev) => ({ ...prev, [studentId]: cleaned }));
    }
  };

  const cancelEdit = () => {
    const { studentId, previousValue } = editModal;
    clearTimeout(inputs.current[`timer_${studentId}`]);
    setMarks((prev) => ({ ...prev, [studentId]: previousValue !== undefined ? String(previousValue) : '' }));
    setEditModal({ visible: false, studentId: null, pendingValue: null, previousValue: null });
    setEditReason('');
  };

  const confirmEdit = async () => {
    const { studentId, pendingValue } = editModal;
    if (!editReason.trim() || editReason.trim().length < MIN_REASON_LEN) return;

    setEditSaving(true);
    try {
      const res = await apiFetch('/cce/marks', {
        method: 'PUT',
        body: JSON.stringify({
          studentId,
          subjectId,
          examType: selectedExamType,
          marks: pendingValue,
          academicYear,
          classId,
          reason: editReason.trim(),
          teacherName: incoming?.teacherName || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to update mark', 'error');
        return;
      }
      savedMarkValues.current[studentId] = pendingValue;
      setMarks((prev) => ({ ...prev, [studentId]: String(pendingValue) }));
      setEditModal({ visible: false, studentId: null, pendingValue: null, previousValue: null });
      setEditReason('');
      showToast('Mark updated successfully', 'success');
    } catch {
      showToast('Network error updating mark', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const getUnsavedEntries = useCallback(() => {
    return students.reduce((items, student) => {
      const studentId = student.studentId || student.id;
      const value = marks[studentId] ?? '';
      const numericValue = parseFloat(value);
      const alreadySaved = savedMarkValues.current[studentId] !== undefined;
      if (!alreadySaved && value !== '' && !isNaN(numericValue) && numericValue >= 0 && numericValue <= maxM) {
        items.push({ studentId, marks: numericValue });
      }
      return items;
    }, []);
  }, [students, marks, maxM]);

  const doSubmit = async (entries) => {
    setSubmitting(true);
    try {
      const res = await apiFetch('/cce/marks/bulk', {
        method: 'POST',
        body: JSON.stringify({
          entries,
          subjectId,
          examType: selectedExamType,
          academicYear,
          classId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to submit marks', 'error');
        return;
      }
      for (const entry of entries) {
        savedMarkValues.current[entry.studentId] = entry.marks;
      }
      setMarks((prev) => ({ ...prev }));
      showToast(`Marks submitted successfully (${data.count ?? entries.length} saved)`, 'success');
    } catch {
      showToast('Network error. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = () => {
    const entries = getUnsavedEntries();
    if (entries.length === 0) {
      showToast('No new marks to submit', 'info');
      return;
    }

    Alert.alert(
      'Submit Marks',
      `Submit ${entries.length} mark${entries.length > 1 ? 's' : ''} for ${getSubjectLabel(subjectId)} - ${className}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Submit', onPress: () => doSubmit(entries) },
      ]
    );
  };

  const gradeFor = (value) => {
    const numericValue = parseFloat(value);
    if (isNaN(numericValue) || value === '') return null;
    if (isFAExam(selectedExamType)) return getFAGrade(numericValue);
    return null;
  };

  const renderStudent = ({ item, index }) => {
    const studentId = item.studentId || item.id;
    const name = item.studentName || item.name || '';
    const value = marks[studentId] ?? '';
    const numericValue = parseFloat(value);
    const isValid = value === '' || (!isNaN(numericValue) && numericValue >= 0 && numericValue <= maxM);
    const grade = gradeFor(value);
    const isSaved = savedMarkValues.current[studentId] !== undefined;

    const fa1 = faMarks[studentId]?.[precedingFAs[0]];
    const fa2 = faMarks[studentId]?.[precedingFAs[1]];
    const faTotal = (isSA && fa1 !== undefined && fa2 !== undefined) ? (Number(fa1) + Number(fa2)) : null;

    let hyPreview = null;
    if (isSA1 && fa1 !== undefined && fa2 !== undefined && value !== '' && !isNaN(numericValue)) {
      hyPreview = calcHalfYear(fa1, fa2, numericValue).halfYear;
    }

    return (
      <View style={[st.row, index % 2 === 0 ? st.rowEven : {}]}>
        <Text style={st.rowNum}>{index + 1}</Text>
        <Text style={st.rowName} numberOfLines={2}>{name}</Text>

        {isSA && (
          <>
            <View style={st.faCol}>
              <Text style={st.faVal}>{fa1 !== undefined ? fa1 : '—'}</Text>
              <Text style={st.faVal}>{fa2 !== undefined ? fa2 : '—'}</Text>
            </View>
            <Text style={[st.faTotal, { color: faTotal !== null ? '#60a5fa' : C.muted }]}>
              {faTotal !== null ? faTotal : '—'}
            </Text>
          </>
        )}

        <View style={st.inputWrap}>
          {isSaved ? (
            <View style={st.lockedBadge}>
              <Text style={st.lockedVal}>{value}</Text>
              <Text style={st.savedCheck}>✓</Text>
            </View>
          ) : (
            <TextInput
              ref={(ref) => { inputs.current[studentId] = ref; }}
              style={[st.input, !isValid && value !== '' && st.inputErr]}
              value={value}
              onChangeText={(text) => onChangeMark(studentId, text)}
              keyboardType="numeric"
              placeholder="—"
              placeholderTextColor={C.muted}
              maxLength={5}
            />
          )}
        </View>

        {grade && (
          <View style={[st.badge, { backgroundColor: GRADE_BG[grade.grade] || C.border }]}>
            <Text style={st.badgeText}>{grade.grade}</Text>
          </View>
        )}

        {isSA1 && (
          <Text style={[st.hyPrev, { color: hyPreview !== null ? '#22d38a' : C.muted }]}>
            {hyPreview !== null ? hyPreview : '—'}
          </Text>
        )}
      </View>
    );
  };

  const tableHeader = (
    <View>
      <View style={st.headerCard}>
        <Text style={st.headerCardTitle}>{getSubjectLabel(subjectId)} - {className}</Text>
        <Text style={st.headerCardSub}>Academic Year {academicYear}</Text>
        <TouchableOpacity style={st.examPicker} onPress={() => setPickerVisible(true)}>
          <Text style={st.examPickerLabel}>Exam Type</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={st.examPickerValue}>{selectedExamType}</Text>
            <Text style={{ color: C.muted }}>▼</Text>
          </View>
        </TouchableOpacity>
      </View>

      <View style={st.tableHeader}>
        <Text style={[st.th, { width: 28 }]}>#</Text>
        <Text style={[st.th, { flex: 1 }]}>Student</Text>
        {isSA && <Text style={[st.th, { width: 60 }]}>{precedingFAs.join('\n')}</Text>}
        {isSA && <Text style={[st.th, { width: 40 }]}>FA Tot</Text>}
        <Text style={[st.th, { width: 56 }]}>/{maxM}</Text>
        {isFAExam(selectedExamType) && <Text style={[st.th, { width: 36 }]}>Grd</Text>}
        {isSA1 && <Text style={[st.th, { width: 44 }]}>HY</Text>}
      </View>
    </View>
  );

  const listFooter = otherSubjects.length > 0 ? (
    <View style={{ padding: 16, paddingTop: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
        <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700' }}>OTHER SUBJECTS (VIEW ONLY)</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
      </View>
      {otherSubjects.map((subject) => (
        <ViewOnlySubjectCard
          key={subject}
          subjectId={subject}
          academicYear={academicYear}
          classId={classId}
          students={students}
        />
      ))}
    </View>
  ) : null;

  const unsavedCount = getUnsavedEntries().length;
  const reasonValid = editReason.trim().length >= MIN_REASON_LEN;

  return (
    <KeyboardAvoidingView style={st.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={st.header}>
        <TouchableOpacity onPress={onBack} style={st.backBtn}>
          <Text style={{ color: C.white, fontSize: 18 }}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={st.headerTitle}>{getSubjectLabel(subjectId)} - {className}</Text>
          <Text style={{ color: C.muted, fontSize: 12 }}>{selectedExamType} · Max {maxM} · {academicYear}</Text>
        </View>
        <TouchableOpacity onPress={loadAll} style={st.refreshBtn}>
          <Text style={{ color: C.teal, fontSize: 18 }}>↻</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={C.teal} />
          <Text style={{ color: C.muted, marginTop: 12 }}>Loading students...</Text>
        </View>
      ) : students.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 40, marginBottom: 12 }}>🎓</Text>
          <Text style={{ color: C.white, fontWeight: '700' }}>No students found</Text>
          <Text style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>Add students to this class first</Text>
        </View>
      ) : (
        <FlatList
          data={students}
          keyExtractor={(student, index) => student.studentId || student.id || String(index)}
          renderItem={renderStudent}
          ListHeaderComponent={tableHeader}
          ListFooterComponent={listFooter}
          stickyHeaderIndices={[0]}
          contentContainerStyle={{ paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
        />
      )}

      {!loading && students.length > 0 && (
        <View style={st.submitBar}>
          <View>
            <Text style={{ color: C.white, fontSize: 13, fontWeight: '700' }}>
              {unsavedCount > 0 ? `${unsavedCount} unsaved mark${unsavedCount > 1 ? 's' : ''}` : 'All marks saved'}
            </Text>
            <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
              Tap submit to save - edits require a reason
            </Text>
          </View>
          <TouchableOpacity
            style={[st.submitBtn, (unsavedCount === 0 || submitting) && st.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={unsavedCount === 0 || submitting}
          >
            {submitting
              ? <ActivityIndicator size="small" color={C.white} />
              : <Text style={st.submitBtnText}>Submit Marks</Text>}
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <TouchableOpacity style={modal.overlay} activeOpacity={1} onPress={() => setPickerVisible(false)}>
          <View style={modal.sheet}>
            <Text style={modal.title}>Select Exam Type</Text>
            {VALID_EXAM_TYPES.map((examType) => {
              const isSelected = selectedExamType === examType;
              return (
                <TouchableOpacity
                  key={examType}
                  onPress={() => { setSelectedExamType(examType); setPickerVisible(false); }}
                  style={[modal.option, isSelected && { backgroundColor: C.teal + '22' }]}
                >
                  <Text style={{ color: isSelected ? C.teal : C.white, fontWeight: isSelected ? '700' : '500' }}>{examType}</Text>
                  {isSelected ? <Text style={{ color: C.teal }}>✓</Text> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={editModal.visible} transparent animationType="slide" onRequestClose={cancelEdit}>
        <View style={modal.overlay}>
          <View style={modal.sheet}>
            <Text style={modal.title}>Why are you editing this mark?</Text>
            <Text style={modal.subtitle}>
              {getSubjectLabel(subjectId)} · {selectedExamType} · Previous: {editModal.previousValue ?? '—'} → New: {editModal.pendingValue ?? '—'}
            </Text>
            <TextInput
              ref={reasonInputRef}
              style={[modal.input, reasonValid && modal.inputValid]}
              placeholder="Enter reason (min 10 characters)..."
              placeholderTextColor={C.muted}
              value={editReason}
              onChangeText={setEditReason}
              multiline
              numberOfLines={3}
              maxLength={300}
              autoCapitalize="sentences"
            />
            <Text style={[modal.counter, { color: reasonValid ? '#22d38a' : C.muted }]}>
              {editReason.trim().length} / {MIN_REASON_LEN} min characters
            </Text>
            <View style={modal.actions}>
              <TouchableOpacity style={modal.cancelBtn} onPress={cancelEdit} disabled={editSaving}>
                <Text style={modal.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modal.confirmBtn, !reasonValid && modal.confirmDisabled]}
                onPress={confirmEdit}
                disabled={!reasonValid || editSaving}
              >
                {editSaving
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={modal.confirmText}>Confirm Edit</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onHide={() => setToast((prev) => ({ ...prev, visible: false }))}
      />
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.navy },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, paddingTop: 50, backgroundColor: C.navyMid, borderBottomWidth: 1, borderColor: C.border },
  backBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '700', color: C.white },
  refreshBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' },
  headerCard: { backgroundColor: C.card, padding: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  headerCardTitle: { color: C.white, fontSize: 16, fontWeight: '700' },
  headerCardSub: { color: C.muted, fontSize: 12, marginTop: 4, marginBottom: 10 },
  examPicker: { backgroundColor: C.navyMid, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border },
  examPickerLabel: { color: C.muted, fontSize: 11, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase' },
  examPickerValue: { color: C.white, fontSize: 15, fontWeight: '600' },
  tableHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0f2957', padding: 10, paddingHorizontal: 12 },
  th: { fontSize: 10, fontWeight: '700', color: C.muted, textAlign: 'center', textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: C.border + '55' },
  rowEven: { backgroundColor: C.navyMid + '66' },
  rowNum: { width: 28, fontSize: 12, color: C.muted, textAlign: 'center' },
  rowName: { flex: 1, fontSize: 13, color: C.white, fontWeight: '500' },
  faCol: { width: 60, alignItems: 'center' },
  faVal: { fontSize: 11, color: C.muted, textAlign: 'center' },
  faTotal: { width: 40, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  inputWrap: { width: 56, flexDirection: 'row', alignItems: 'center', gap: 2 },
  input: { flex: 1, backgroundColor: C.navyMid, borderRadius: 8, borderWidth: 1.5, borderColor: C.border, color: C.white, fontSize: 14, fontWeight: '700', textAlign: 'center', paddingVertical: 6 },
  inputErr: { borderColor: '#ef4444' },
  lockedBadge: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#14532d44', borderRadius: 8, borderWidth: 1.5, borderColor: '#22d38a55', paddingVertical: 6, gap: 3 },
  lockedVal: { fontSize: 14, fontWeight: '700', color: '#22d38a', textAlign: 'center' },
  savedCheck: { fontSize: 12, color: '#22d38a', fontWeight: '800' },
  badge: { width: 32, borderRadius: 6, paddingVertical: 3, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  hyPrev: { width: 44, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  submitBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, paddingHorizontal: 16, backgroundColor: '#0f2348', borderTopWidth: 1.5, borderColor: C.teal + '55' },
  submitBtn: { backgroundColor: C.teal, paddingVertical: 12, paddingHorizontal: 22, borderRadius: 14, minWidth: 130, alignItems: 'center' },
  submitBtnDisabled: { backgroundColor: '#1a3c5e', opacity: 0.5 },
  submitBtnText: { color: C.white, fontWeight: '800', fontSize: 14 },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0f2348', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  title: { fontSize: 18, fontWeight: '800', color: C.white, marginBottom: 10 },
  subtitle: { fontSize: 13, color: C.muted, marginBottom: 18 },
  input: { backgroundColor: '#162E50', borderWidth: 1.5, borderColor: C.border, borderRadius: 14, padding: 14, color: C.white, fontSize: 14, minHeight: 90, textAlignVertical: 'top' },
  inputValid: { borderColor: '#22d38a' },
  counter: { fontSize: 12, marginTop: 6, marginBottom: 20, textAlign: 'right' },
  actions: { flexDirection: 'row', gap: 12 },
  cancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 14, borderWidth: 1.5, borderColor: C.border, alignItems: 'center' },
  cancelText: { color: C.muted, fontSize: 15, fontWeight: '700' },
  confirmBtn: { flex: 2, paddingVertical: 14, borderRadius: 14, backgroundColor: C.teal, alignItems: 'center' },
  confirmDisabled: { backgroundColor: '#1a3c5e', opacity: 0.6 },
  confirmText: { color: C.white, fontSize: 15, fontWeight: '700' },
  option: {
    minHeight: 48, paddingVertical: 14, paddingHorizontal: 6,
    borderBottomWidth: 1, borderBottomColor: C.border + '55',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
});

const vst = StyleSheet.create({
  card: { backgroundColor: C.navyMid + 'CC', borderRadius: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  icon: { fontSize: 10, color: C.muted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { fontSize: 14, color: C.white, fontWeight: '700', marginTop: 2 },
  tableHead: { flexDirection: 'row', backgroundColor: C.navy, paddingVertical: 8, paddingHorizontal: 10 },
  th: { width: 52, fontSize: 10, fontWeight: '700', color: C.muted, textAlign: 'center' },
  nameW: { width: 120, textAlign: 'left' },
  row: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 10, borderTopWidth: 1, borderColor: C.border + '44' },
  rowEven: { backgroundColor: C.navy + '88' },
  td: { width: 52, fontSize: 12, color: C.white, textAlign: 'center' },
});
