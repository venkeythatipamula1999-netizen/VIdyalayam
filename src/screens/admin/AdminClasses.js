import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator, Platform, Modal, SafeAreaView,
} from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { LinearGradient } from 'expo-linear-gradient';
import { apiFetch } from '../../api/client';
import AdminStudents from './AdminStudents';
import Toast from '../../components/Toast';
import { getFriendlyError } from '../../utils/errorMessages';
import QRSheetModal from '../../components/QRSheetModal';
import { getSubjectLabel } from '../../constants/subjects';

function AdminClasses({ onBack, currentUser, onNavigate }) {
  const [classes, setClasses] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [qrSheet, setQrSheet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedClass, setSelectedClass] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [newClassName, setNewClassName] = useState('');
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [assignmentClass, setAssignmentClass] = useState(null);
  const [selectedTeacher, setSelectedTeacher] = useState(null);
  const [availableSubjects, setAvailableSubjects] = useState([]);
  const [selectedSubject, setSelectedSubject] = useState('');
  const [picker, setPicker] = useState(null);

  const showToast = (msg, type = 'success') => setToast({ visible: true, message: msg, type });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    await Promise.all([fetchClasses(), fetchTeachers()]);
    setLoading(false);
  };

  const fetchClasses = async () => {
    try {
      const res = await apiFetch('/classes?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (data.success && data.classes) {
        const sorted = [...data.classes].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setClasses(sorted);
      } else {
        setClasses([]);
      }
    } catch {
      setClasses([]);
    }
  };

  const fetchTeachers = async () => {
    try {
      const res = await apiFetch('/onboarded-users?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.users) {
        const teacherList = data.users
          .filter((user) => user.role === 'teacher' || user.role === 'staff')
          .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        setTeachers(teacherList);
      } else {
        setTeachers([]);
      }
    } catch {
      setTeachers([]);
    }
  };

  const handleAddClass = async () => {
    if (!newClassName.trim()) return;
    setSaving(true);
    try {
      const name = newClassName.trim();
      const res = await apiFetch('/classes/add', {
        method: 'POST',
        body: JSON.stringify({ className: name }),
      });
      const data = await res.json();
      if (!data.success) {
        showToast(data.error || 'Failed to add class', 'error');
        return;
      }
      setNewClassName('');
      setShowAddModal(false);
      await fetchClasses();
      showToast('Class created successfully');
    } catch (err) {
      showToast(getFriendlyError(err, 'Error adding class.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClass = async (id) => {
    setClasses((prev) => prev.filter((cls) => cls.id !== id));
    try {
      const res = await apiFetch(`/classes/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) fetchClasses();
    } catch {
      fetchClasses();
    }
  };

  const openAssignModal = (cls) => {
    setAssignmentClass(cls);
    setSelectedTeacher(null);
    setAvailableSubjects([]);
    setSelectedSubject('');
    setShowAssignModal(true);
  };

  const handleTeacherSelect = async (teacher) => {
    setSelectedTeacher(teacher);
    setSelectedSubject('');
    setLoadingSubjects(true);
    try {
      const res = await apiFetch(`/teacher/subjects?roleId=${encodeURIComponent(teacher.role_id)}`);
      const data = await res.json();
      const subjects = Array.isArray(data.subjects) ? data.subjects : [];
      setAvailableSubjects(subjects);
    } catch {
      setAvailableSubjects([]);
    } finally {
      setLoadingSubjects(false);
      setPicker(null);
    }
  };

  const handleSaveAssignment = async () => {
    if (!assignmentClass || !selectedTeacher || !selectedSubject) {
      showToast('Select class, teacher, and subject', 'error');
      return;
    }

    setAssigning(true);
    try {
      const res = await apiFetch('/assign-classes', {
        method: 'POST',
        body: JSON.stringify({
          teacherId: selectedTeacher.role_id,
          classId: assignmentClass.id,
          className: assignmentClass.name,
          subject: selectedSubject,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save assignment');
      }
      setShowAssignModal(false);
      showToast(`${selectedTeacher.full_name} assigned to ${assignmentClass.name} for ${getSubjectLabel(selectedSubject)}`);
      await fetchClasses();
      await fetchTeachers();
    } catch (err) {
      showToast(getFriendlyError(err, 'Failed to assign teacher'), 'error');
    } finally {
      setAssigning(false);
    }
  };

  const teacherOptions = useMemo(
    () => teachers.map((teacher) => ({ ...teacher, label: teacher.full_name || teacher.role_id })),
    [teachers]
  );

  if (selectedClass) {
    return (
      <AdminStudents
        onBack={() => { setSelectedClass(null); fetchClasses(); }}
        classItem={selectedClass}
      />
    );
  }

  return (
    <View style={st.container}>
      <View style={st.header}>
        <TouchableOpacity onPress={onBack} style={st.backBtn}>
          <Icon name="back" size={20} color={C.white} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>Class Management</Text>
        <TouchableOpacity
          onPress={() => onNavigate && onNavigate('admin-student-qr')}
          style={st.headerChip}
        >
          <Text style={st.headerChipText}>QR Codes</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowAddModal(true)} style={st.addBtn}>
          <Text style={{ color: C.navy, fontWeight: '700' }}>+ Add Class</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={{ flex: 1, padding: 20 }}>
        {loading ? (
          <ActivityIndicator size="large" color={C.gold} style={{ marginTop: 50 }} />
        ) : classes.length === 0 ? (
          <View style={{ alignItems: 'center', marginTop: 60, paddingHorizontal: 30 }}>
            <Text style={{ fontSize: 40, marginBottom: 14 }}>{'\uD83C\uDFEB'}</Text>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 8 }}>
              No Classes Available
            </Text>
            <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center', lineHeight: 20 }}>
              Tap "+ Add Class" above to create your first class and section.
            </Text>
          </View>
        ) : (
          <View style={st.classGrid}>
            {classes.map((cls) => (
              <View key={cls.id} style={{ width: '47%' }}>
                <TouchableOpacity
                  onPress={() => setSelectedClass(cls)}
                  style={{ height: 170, borderRadius: 18, overflow: 'hidden' }}
                >
                  <LinearGradient colors={[C.navyLt, C.navyMid]} style={st.classGradient}>
                    <Text style={st.className}>{cls.name}</Text>
                    <Text style={st.classDetail}>{cls.studentCount || 0} Students</Text>
                    <View style={st.manageTag}>
                      <Text style={st.manageTagText}>Manage Students</Text>
                    </View>
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation && e.stopPropagation();
                        handleDeleteClass(cls.id);
                      }}
                      style={{ position: 'absolute', top: 10, right: 10 }}
                    >
                      <Icon name="close" size={14} color={C.coral} />
                    </TouchableOpacity>
                  </LinearGradient>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => openAssignModal(cls)}
                  style={st.assignBtn}
                >
                  <Text style={st.assignBtnText}>Assign Teacher</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setQrSheet({ classId: cls.id, className: cls.name })}
                  style={st.qrBtn}
                >
                  <Text style={st.qrBtnText}>Download QR Sheet</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <Toast {...toast} onHide={() => setToast((t) => ({ ...t, visible: false }))} />

      <QRSheetModal
        visible={!!qrSheet}
        classId={qrSheet?.classId}
        className={qrSheet?.className}
        onClose={() => setQrSheet(null)}
      />

      {showAddModal && (
        <View style={st.modalOverlay}>
          <View style={st.modalContent}>
            <Text style={st.modalTitle}>Add New Class</Text>
            <TextInput
              style={st.input}
              placeholder="e.g. 10-C"
              placeholderTextColor={C.muted}
              value={newClassName}
              onChangeText={setNewClassName}
              autoFocus
            />
            <View style={st.modalButtons}>
              <TouchableOpacity
                onPress={() => { setShowAddModal(false); setNewClassName(''); }}
                style={[st.modalBtn, { backgroundColor: C.border }]}
              >
                <Text style={{ color: C.white }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleAddClass}
                disabled={saving}
                style={[st.modalBtn, { backgroundColor: C.gold }]}
              >
                {saving
                  ? <ActivityIndicator size="small" color={C.navy} />
                  : <Text style={{ color: C.navy, fontWeight: '700' }}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      <Modal visible={showAssignModal} animationType="slide" onRequestClose={() => setShowAssignModal(false)}>
        <SafeAreaView style={st.assignScreen}>
          <View style={st.assignHeader}>
            <TouchableOpacity onPress={() => setShowAssignModal(false)} style={st.backBtn}>
              <Icon name="back" size={18} color={C.white} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={st.headerTitle}>Assign Teacher</Text>
              <Text style={{ color: C.muted, fontSize: 12 }}>{assignmentClass?.name || ''}</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <View style={st.card}>
              <Text style={st.label}>Selected Class</Text>
              <View style={st.staticField}>
                <Text style={st.staticFieldText}>{assignmentClass?.name || 'Select class'}</Text>
              </View>

              <Text style={[st.label, { marginTop: 14 }]}>Select Teacher</Text>
              <TouchableOpacity
                onPress={() => setPicker({ type: 'teacher' })}
                style={st.dropdownButton}
              >
                <Text style={st.dropdownText}>
                  {selectedTeacher?.full_name || 'Select Teacher'}
                </Text>
                <Text style={{ color: C.muted }}>▼</Text>
              </TouchableOpacity>

              <Text style={[st.label, { marginTop: 14 }]}>Select Subject</Text>
              <TouchableOpacity
                onPress={() => selectedTeacher && availableSubjects.length > 0 && setPicker({ type: 'subject' })}
                style={[st.dropdownButton, !selectedTeacher && st.disabledButton]}
                disabled={!selectedTeacher}
              >
                <Text style={st.dropdownText}>
                  {selectedSubject
                    ? getSubjectLabel(selectedSubject)
                    : selectedTeacher
                      ? 'Select Subject'
                      : 'Select teacher first'}
                </Text>
                <Text style={{ color: C.muted }}>▼</Text>
              </TouchableOpacity>

              {loadingSubjects ? (
                <View style={st.infoBox}>
                  <ActivityIndicator size="small" color={C.gold} />
                  <Text style={{ color: C.muted, fontSize: 12 }}>Loading teacher subjects...</Text>
                </View>
              ) : selectedTeacher && availableSubjects.length === 0 ? (
                <View style={st.infoBox}>
                  <Text style={{ color: C.gold, fontWeight: '700' }}>No subjects assigned to this teacher</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
                    Onboard or update the teacher with subjects first.
                  </Text>
                </View>
              ) : null}

              <View style={st.modalButtons}>
                <TouchableOpacity
                  onPress={() => setShowAssignModal(false)}
                  style={[st.modalBtn, { backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border }]}
                >
                  <Text style={{ color: C.white, fontWeight: '700' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleSaveAssignment}
                  disabled={assigning || !selectedTeacher || !selectedSubject}
                  style={[st.modalBtn, { backgroundColor: C.gold, opacity: assigning || !selectedTeacher || !selectedSubject ? 0.5 : 1 }]}
                >
                  {assigning
                    ? <ActivityIndicator size="small" color={C.navy} />
                    : <Text style={{ color: C.navy, fontWeight: '700' }}>Save Assignment</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {picker && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPicker(null)}>
          <TouchableOpacity style={st.modalOverlay} activeOpacity={1} onPress={() => setPicker(null)}>
            <View style={[st.modalContent, { padding: 0, maxHeight: '70%' }]}>
              <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: C.border }}>
                <Text style={st.modalTitle}>{picker.type === 'teacher' ? 'Select Teacher' : 'Select Subject'}</Text>
              </View>
              <ScrollView>
                {(picker.type === 'teacher' ? teacherOptions : availableSubjects).map((item, index) => {
                  const key = picker.type === 'teacher' ? item.role_id : item;
                  const label = picker.type === 'teacher' ? item.label : getSubjectLabel(item);
                  const isSelected = picker.type === 'teacher'
                    ? selectedTeacher?.role_id === item.role_id
                    : selectedSubject === item;

                  return (
                    <TouchableOpacity
                      key={key || index}
                      onPress={() => {
                        if (picker.type === 'teacher') {
                          handleTeacherSelect(item);
                        } else {
                          setSelectedSubject(item);
                          setPicker(null);
                        }
                      }}
                      style={[st.optionRow, isSelected && { backgroundColor: C.gold + '15' }]}
                    >
                      <Text style={{ color: isSelected ? C.gold : C.white, fontWeight: isSelected ? '700' : '500' }}>
                        {label}
                      </Text>
                      {isSelected ? <Text style={{ color: C.gold }}>✓</Text> : null}
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
  header: {
    flexDirection: 'row', alignItems: 'center', padding: 20,
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    backgroundColor: C.navyMid, gap: 12,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: C.white, flex: 1 },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center',
  },
  headerChip: {
    backgroundColor: C.teal + '22', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: C.teal + '44',
  },
  headerChipText: { color: C.teal, fontWeight: '600', fontSize: 13 },
  addBtn: { backgroundColor: C.gold, paddingHorizontal: 15, paddingVertical: 8, borderRadius: 10 },
  classGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 15 },
  classGradient: { flex: 1, padding: 15, justifyContent: 'center', alignItems: 'center' },
  className: { fontSize: 22, fontWeight: '800', color: C.white, textAlign: 'center' },
  classDetail: { fontSize: 12, color: C.muted, marginTop: 4 },
  manageTag: {
    marginTop: 10, backgroundColor: C.gold + '22',
    borderWidth: 1, borderColor: C.gold + '55',
    borderRadius: 8, paddingVertical: 4, paddingHorizontal: 10,
  },
  manageTagText: { fontSize: 11, color: C.gold, fontWeight: '600' },
  assignBtn: {
    marginTop: 8, backgroundColor: C.cardAlt || '#1a2f4a', borderRadius: 10,
    borderWidth: 1, borderColor: C.border, paddingVertical: 10, alignItems: 'center',
  },
  assignBtnText: { color: C.white, fontWeight: '700', fontSize: 12 },
  qrBtn: {
    marginTop: 6, backgroundColor: C.teal + '18', borderRadius: 8,
    paddingVertical: 7, borderWidth: 1, borderColor: C.teal + '44', alignItems: 'center',
  },
  qrBtnText: { color: C.teal, fontSize: 11, fontWeight: '700' },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center', alignItems: 'center', padding: 20,
  },
  modalContent: {
    backgroundColor: C.navyMid, width: '100%',
    borderRadius: 20, padding: 25, borderWidth: 1, borderColor: C.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: C.white, marginBottom: 0 },
  input: {
    backgroundColor: C.navy, borderRadius: 12, padding: 15,
    color: C.white, fontSize: 16, marginBottom: 20, borderWidth: 1, borderColor: C.border,
  },
  modalButtons: { flexDirection: 'row', gap: 12, marginTop: 20 },
  modalBtn: { flex: 1, padding: 15, borderRadius: 12, alignItems: 'center' },
  assignScreen: { flex: 1, backgroundColor: C.navy },
  assignHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20,
    paddingVertical: 16, backgroundColor: C.navyMid, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 18, padding: 16 },
  label: { fontSize: 12, fontWeight: '500', color: C.muted, marginBottom: 6 },
  staticField: {
    width: '100%', padding: 12, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: C.navyMid, borderWidth: 1.5, borderColor: C.border,
  },
  staticFieldText: { color: C.white, fontSize: 14, fontWeight: '600' },
  dropdownButton: {
    width: '100%', padding: 12, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: C.cardAlt || '#1a2f4a', borderWidth: 1, borderColor: C.border,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  dropdownText: { color: C.white, fontSize: 14, fontWeight: '600' },
  disabledButton: { opacity: 0.5 },
  infoBox: {
    marginTop: 12, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border,
    borderRadius: 12, padding: 12, gap: 6,
  },
  optionRow: {
    minHeight: 48, paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.border + '55',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
});

export default AdminClasses;
