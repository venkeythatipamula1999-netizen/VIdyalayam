import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import { C } from '../../theme/colors';
import { apiFetch } from '../../api/client';
import { VALID_EXAM_TYPES, ACADEMIC_YEARS } from '../../helpers/cceGradingMobile';
import { SUBJECTS, getSubjectLabel } from '../../constants/subjects';

export default function CCEHomeScreen({ onBack, onNavigate, currentUser }) {
  const [assignments, setAssignments] = useState([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);
  const [classes, setClasses] = useState([]);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [academicYear, setAcademicYear] = useState('2025-26');
  const [selectedClass, setSelectedClass] = useState(null);
  const [selectedSubject, setSelectedSubject] = useState('mathematics');
  const [selectedExamType, setSelectedExamType] = useState('FA1');
  const [picker, setPicker] = useState(null);

  const isAdmin = currentUser?.role === 'principal' || currentUser?.role === 'admin' || currentUser?.role === 'staff';

  useEffect(() => {
    if (isAdmin) {
      loadClasses();
    } else {
      loadTeacherAssignments();
    }
  }, [isAdmin, academicYear]);

  const loadClasses = async () => {
    setLoadingClasses(true);
    try {
      const res = await apiFetch('/classes');
      const data = await res.json();
      const list = (data.classes || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setClasses(list);
      if (list.length && !selectedClass) setSelectedClass(list[0]);
    } catch {
      setClasses([]);
    } finally {
      setLoadingClasses(false);
    }
  };

  const loadTeacherAssignments = async () => {
    setLoadingAssignments(true);
    try {
      const res = await apiFetch('/teacher/assignments');
      const data = await res.json();
      const nextAssignments = Array.isArray(data.assignments) ? data.assignments : [];
      const filtered = nextAssignments.filter((item) => !item.academicYear || item.academicYear === academicYear);
      setAssignments(filtered);
    } catch {
      setAssignments([]);
    } finally {
      setLoadingAssignments(false);
    }
  };

  const DropPicker = ({ title, value, options, onSelect, display }) => (
    <TouchableOpacity
      style={st.picker}
      onPress={() => setPicker({ title, value, options, onSelect, display })}
    >
      <Text style={st.pickerLabel}>{title}</Text>
      <View style={st.pickerRow}>
        <Text style={st.pickerVal}>{display ? display(value) : value}</Text>
        <Text style={{ color: C.muted }}>▼</Text>
      </View>
    </TouchableOpacity>
  );

  const navigateToMarkEntry = (assignment) => {
    onNavigate('cce-mark-entry', {
      academicYear,
      classId: assignment.classId,
      className: assignment.className,
      subject: assignment.subject,
      subjectId: assignment.subject,
      examType: assignment.examType || 'FA1',
      isAdmin,
    });
  };

  return (
    <View style={st.container}>
      <View style={st.header}>
        <TouchableOpacity onPress={onBack} style={st.backBtn}>
          <Text style={{ color: C.white, fontSize: 18 }}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={st.headerTitle}>CCE Marks</Text>
          <Text style={{ color: C.muted, fontSize: 12 }}>Continuous Comprehensive Evaluation</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
        <DropPicker
          title="Academic Year"
          value={academicYear}
          options={ACADEMIC_YEARS}
          onSelect={setAcademicYear}
        />

        {isAdmin ? (
          <View style={st.card}>
            <Text style={st.sectionTitle}>Admin Entry</Text>
            {loadingClasses ? (
              <ActivityIndicator size="small" color={C.gold} />
            ) : (
              <>
                <DropPicker
                  title="Class"
                  value={selectedClass}
                  options={classes}
                  onSelect={setSelectedClass}
                  display={(value) => value?.name || 'Select class'}
                />
                <DropPicker
                  title="Subject"
                  value={selectedSubject}
                  options={SUBJECTS.map((subject) => subject.id)}
                  onSelect={setSelectedSubject}
                  display={(value) => getSubjectLabel(value)}
                />
                <DropPicker
                  title="Exam Type"
                  value={selectedExamType}
                  options={VALID_EXAM_TYPES}
                  onSelect={setSelectedExamType}
                />
                <TouchableOpacity
                  style={[st.enterBtn, { opacity: !selectedClass ? 0.5 : 1 }]}
                  disabled={!selectedClass}
                  onPress={() => selectedClass && navigateToMarkEntry({
                    classId: selectedClass.id,
                    className: selectedClass.name,
                    subject: selectedSubject,
                    examType: selectedExamType,
                  })}
                >
                  <Text style={st.enterBtnText}>Enter Marks</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : loadingAssignments ? (
          <View style={st.card}>
            <ActivityIndicator size="small" color={C.gold} />
            <Text style={{ color: C.muted, fontSize: 12, marginTop: 10 }}>Loading your assignments...</Text>
          </View>
        ) : assignments.length === 0 ? (
          <View style={st.emptyCard}>
            <Text style={st.emptyTitle}>No classes assigned yet</Text>
            <Text style={st.emptyText}>Contact admin to assign classes and subjects.</Text>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {assignments.map((assignment, index) => (
              <TouchableOpacity
                key={`${assignment.classId}-${assignment.subject}-${index}`}
                onPress={() => navigateToMarkEntry(assignment)}
                style={st.assignmentCard}
              >
                <View style={st.subjectBadge}>
                  <Text style={st.subjectText}>{getSubjectLabel(assignment.subject)}</Text>
                </View>
                <Text style={st.className}>{assignment.className}</Text>
                <Text style={st.arrow}>Enter Marks →</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {picker && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPicker(null)}>
          <TouchableOpacity style={st.overlay} activeOpacity={1} onPress={() => setPicker(null)}>
            <View style={st.sheet}>
              <Text style={st.sheetTitle}>{picker.title}</Text>
              <ScrollView>
                {picker.options.map((option, index) => {
                  const label = picker.display ? picker.display(option) : option;
                  const isSelected = picker.display
                    ? picker.value?.id === option?.id
                    : picker.value === option;
                  return (
                    <TouchableOpacity
                      key={index}
                      style={[st.sheetItem, isSelected && { backgroundColor: C.teal + '22' }]}
                      onPress={() => { picker.onSelect(option); setPicker(null); }}
                    >
                      <Text style={{ color: isSelected ? C.teal : C.white, fontWeight: isSelected ? '700' : '400' }}>
                        {label}
                      </Text>
                      {isSelected && <Text style={{ color: C.teal }}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.navy },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 20, paddingTop: 52, backgroundColor: C.navyMid, borderBottomWidth: 1, borderColor: C.border },
  backBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.white },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: C.white, marginBottom: 14 },
  picker: { backgroundColor: C.navyMid, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  pickerLabel: { fontSize: 11, color: C.muted, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  pickerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pickerVal: { fontSize: 15, color: C.white, fontWeight: '600' },
  enterBtn: { marginTop: 8, backgroundColor: C.teal, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  enterBtnText: { color: C.white, fontWeight: '700', fontSize: 16 },
  assignmentCard: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border },
  subjectBadge: { alignSelf: 'flex-start', backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, marginBottom: 10 },
  subjectText: { color: C.gold, fontSize: 12, fontWeight: '700' },
  className: { color: C.white, fontSize: 17, fontWeight: '700' },
  arrow: { color: C.teal, marginTop: 10, fontWeight: '700' },
  emptyCard: { backgroundColor: C.card, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  emptyTitle: { color: C.white, fontWeight: '700', fontSize: 15, marginBottom: 6 },
  emptyText: { color: C.muted, fontSize: 12, textAlign: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '70%', borderTopWidth: 1, borderColor: C.border },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 16 },
  sheetItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 10, marginBottom: 2 },
});
