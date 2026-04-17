import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator, Platform, BackHandler,
} from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import { getFriendlyError } from '../../utils/errorMessages';

export default function AdminStudents({ onBack, classItem }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);

  const [name, setName] = useState('');
  const [rollNumber, setRollNumber] = useState('');
  const [parentPhone, setParentPhone] = useState('');

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const fileInputRef = useRef(null);

  useEffect(() => {
    fetchStudents();
  }, []);

  const fetchStudents = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/students/${classItem.id}?t=` + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      setStudents(data.success ? (data.students || []) : []);
    } catch (e) {
      setStudents([]);
      setErrorMsg(getFriendlyError(e, 'Failed to load students'));
    } finally {
      setLoading(false);
    }
  };

  const showSuccess = (msg) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 4000);
  };

  const resetForm = () => {
    setName('');
    setRollNumber('');
    setParentPhone('');
    setErrorMsg('');
  };

  const handleAddStudent = async () => {
    setErrorMsg('');
    if (!name.trim()) { setErrorMsg('Student name is required'); return; }
    if (!rollNumber.trim()) { setErrorMsg('Roll number is required'); return; }
    if (isNaN(Number(rollNumber)) || Number(rollNumber) <= 0) {
      setErrorMsg('Roll number must be a positive number'); return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/students', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          rollNumber: Number(rollNumber),
          classId: classItem.id,
          className: classItem.name,
          parentPhone: parentPhone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) { setErrorMsg(data.error || 'Failed to add student'); return; }
      resetForm();
      setShowForm(false);
      showSuccess(`${name.trim()} added successfully!`);
      fetchStudents();
    } catch (e) {
      setErrorMsg(getFriendlyError(e, 'Network error. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStudent = async (student) => {
    setDeleting(student.id);
    try {
      const res = await apiFetch(`/students/${student.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setStudents(prev => prev.filter(s => s.id !== student.id));
        showSuccess(`${student.name} removed.`);
      }
    } catch (e) {
      setErrorMsg(getFriendlyError(e, 'Failed to delete student'));
    } finally { setDeleting(null); }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    const ext = file.name.toLowerCase().split('.').pop();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      setErrorMsg('Please select a .csv or .xlsx file');
      return;
    }

    setUploading(true);
    setErrorMsg('');
    setUploadResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('className', classItem.name);

    try {
      const res = await apiFetch(`/students/bulk-upload/${classItem.id}`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMsg(data.error || 'Upload failed');
        return;
      }
      setUploadResult(data);
      const parts = [`${data.studentsCreated} Student${data.studentsCreated !== 1 ? 's' : ''} Added`];
      if (data.marksCreated > 0) parts.push(`${data.marksCreated} Marks Records Created`);
      showSuccess(parts.join(', '));
      fetchStudents();
    } catch (e) {
      setErrorMsg(getFriendlyError(e, 'Network error during upload. Please try again.'));
    } finally {
      setUploading(false);
    }
  };

  const triggerFileInput = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const avatarColors = [C.teal, C.gold, C.purple, C.coral, '#34D399', '#60A5FA'];

  return (
    <View style={st.container}>
      {successMsg ? (
        <View style={st.successBanner}>
          <Icon name="check" size={16} color={C.white} />
          <Text style={st.successText}>{successMsg}</Text>
        </View>
      ) : null}

      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      )}

      <View style={st.header}>
        <TouchableOpacity onPress={onBack} style={st.backBtn}>
          <Icon name="back" size={20} color={C.white} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={st.headerTitle}>Grade {classItem.name}</Text>
          <Text style={st.headerSub}>{students.length} student{students.length !== 1 ? 's' : ''}</Text>
        </View>
        <TouchableOpacity
          onPress={triggerFileInput}
          disabled={uploading}
          style={[st.uploadBtn, uploading && { opacity: 0.6 }]}
        >
          {uploading
            ? <ActivityIndicator size="small" color={C.white} />
            : <Text style={{ color: C.white, fontWeight: '700', fontSize: 12 }}>📂 Import</Text>
          }
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { setShowForm(!showForm); setErrorMsg(''); setUploadResult(null); }}
          style={st.addBtn}
        >
          <Text style={{ color: C.navy, fontWeight: '700', fontSize: 13 }}>
            {showForm ? 'Cancel' : '+ Add'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>

        <View style={st.importCard}>
          <Text style={st.importTitle}>📊 Bulk Import via CSV / Excel</Text>
          <Text style={st.importDesc}>
            Upload a .csv or .xlsx file. Required:{' '}
            <Text style={{ color: C.gold, fontWeight: '600' }}>name</Text>,{' '}
            <Text style={{ color: C.gold, fontWeight: '600' }}>rollNumber</Text>.{' '}
            Optional: <Text style={{ color: C.teal }}>parentPhone</Text>{'\n'}
            Add marks columns as{' '}
            <Text style={{ color: C.teal, fontWeight: '600' }}>FA1_Maths</Text>,{' '}
            <Text style={{ color: C.teal, fontWeight: '600' }}>FA2_Science</Text>, etc.
          </Text>
          <View style={st.importFormat}>
            <Text style={st.importFormatRow}>name, rollNumber, parentPhone, FA1_Maths, FA2_Maths, FA1_Science</Text>
            <Text style={st.importFormatRow}>Arjun Kumar, 1, 9876543210, 18, 16, 19</Text>
            <Text style={st.importFormatRow}>Priya Nair, 2, 9876543211, 20, 17,</Text>
          </View>
          <TouchableOpacity
            onPress={triggerFileInput}
            disabled={uploading}
            style={[st.importBtn, uploading && { opacity: 0.6 }]}
          >
            {uploading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator size="small" color={C.navy} />
                <Text style={st.importBtnText}>Importing...</Text>
              </View>
            ) : (
              <Text style={st.importBtnText}>Choose CSV / Excel File</Text>
            )}
          </TouchableOpacity>

          {uploadResult && (
            <View style={st.uploadResult}>
              <View style={st.uploadResultRow}>
                <View style={[st.uploadBadge, { backgroundColor: '#34D399' + '22', borderColor: '#34D399' + '55' }]}>
                  <Text style={{ color: '#34D399', fontWeight: '800', fontSize: 18 }}>{uploadResult.studentsCreated}</Text>
                  <Text style={{ color: '#34D399', fontSize: 11 }}>Students Added</Text>
                </View>
                {uploadResult.marksCreated > 0 && (
                  <View style={[st.uploadBadge, { backgroundColor: C.teal + '22', borderColor: C.teal + '55' }]}>
                    <Text style={{ color: C.teal, fontWeight: '800', fontSize: 18 }}>{uploadResult.marksCreated}</Text>
                    <Text style={{ color: C.teal, fontSize: 11 }}>Marks Added</Text>
                  </View>
                )}
                <View style={[st.uploadBadge, { backgroundColor: C.gold + '22', borderColor: C.gold + '55' }]}>
                  <Text style={{ color: C.gold, fontWeight: '800', fontSize: 18 }}>{uploadResult.skipped}</Text>
                  <Text style={{ color: C.gold, fontSize: 11 }}>Skipped</Text>
                </View>
              </View>
              {uploadResult.errors && uploadResult.errors.length > 0 && (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ color: C.coral, fontSize: 11, fontWeight: '600', marginBottom: 4 }}>Issues:</Text>
                  {uploadResult.errors.slice(0, 5).map((e, i) => (
                    <Text key={i} style={{ color: C.coral, fontSize: 11, marginBottom: 2 }}>• {e}</Text>
                  ))}
                  {uploadResult.errors.length > 5 && (
                    <Text style={{ color: C.muted, fontSize: 11 }}>...and {uploadResult.errors.length - 5} more</Text>
                  )}
                </View>
              )}
            </View>
          )}
        </View>

        {errorMsg ? (
          <View style={st.errorBox}>
            <Text style={st.errorText}>{errorMsg}</Text>
          </View>
        ) : null}

        {showForm && (
          <View style={st.formCard}>
            <Text style={st.formTitle}>Add Single Student</Text>
            <Text style={st.label}>Full Name *</Text>
            <TextInput
              style={st.input}
              placeholder="e.g. Arjun Kumar"
              placeholderTextColor={C.muted}
              value={name}
              onChangeText={setName}
            />
            <Text style={st.label}>Roll Number *</Text>
            <TextInput
              style={st.input}
              placeholder="e.g. 1"
              placeholderTextColor={C.muted}
              value={rollNumber}
              onChangeText={setRollNumber}
              keyboardType="numeric"
            />
            <Text style={st.label}>Parent Phone</Text>
            <TextInput
              style={st.input}
              placeholder="e.g. 9876543210"
              placeholderTextColor={C.muted}
              value={parentPhone}
              onChangeText={setParentPhone}
              keyboardType="phone-pad"
            />
            <TouchableOpacity
              onPress={handleAddStudent}
              disabled={saving}
              style={[st.submitBtn, saving && { opacity: 0.6 }]}
            >
              {saving
                ? <ActivityIndicator size="small" color={C.navy} />
                : <Text style={st.submitBtnText}>Save Student</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {loading ? (
          <ActivityIndicator size="large" color={C.gold} style={{ marginTop: 40 }} />
        ) : students.length === 0 ? (
          <View style={st.emptyState}>
            <Text style={{ fontSize: 44, marginBottom: 14 }}>{'👨‍🎓'}</Text>
            <Text style={st.emptyTitle}>No Students Yet</Text>
            <Text style={st.emptySubtitle}>
              Import a CSV/Excel file or tap "+ Add" to enroll students in Grade {classItem.name}.
            </Text>
          </View>
        ) : (
          <View>
            <View style={st.listHeader}>
              <Text style={[st.listHeaderText, { width: 44 }]}>ROLL</Text>
              <Text style={[st.listHeaderText, { flex: 1 }]}>NAME</Text>
              <Text style={[st.listHeaderText, { width: 110 }]}>PHONE</Text>
              <Text style={[st.listHeaderText, { width: 36 }]}></Text>
            </View>
            {students.map((s, idx) => {
              const color = avatarColors[idx % avatarColors.length];
              return (
                <View key={s.id} style={st.studentRow}>
                  <View style={[st.rollBadge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
                    <Text style={[st.rollText, { color }]}>{s.rollNumber}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={st.studentName}>{s.name}</Text>
                    <Text style={st.studentId}>ID: {s.studentId}</Text>
                  </View>
                  <Text style={st.phoneText}>{s.parentPhone || '—'}</Text>
                  <TouchableOpacity
                    onPress={() => handleDeleteStudent(s)}
                    disabled={deleting === s.id}
                    style={st.deleteBtn}
                  >
                    {deleting === s.id
                      ? <ActivityIndicator size="small" color={C.coral} />
                      : <Icon name="close" size={14} color={C.coral} />
                    }
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.navy },
  successBanner: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
    backgroundColor: '#34D399', flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingHorizontal: 20, paddingVertical: 12,
  },
  successText: { color: C.white, fontWeight: '600', fontSize: 13 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 20, paddingTop: Platform.OS === 'ios' ? 50 : 20,
    backgroundColor: C.navyMid,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.white },
  headerSub: { fontSize: 12, color: C.muted, marginTop: 2 },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center',
  },
  uploadBtn: {
    backgroundColor: C.teal, paddingHorizontal: 12,
    paddingVertical: 9, borderRadius: 10, minWidth: 70, alignItems: 'center',
  },
  addBtn: {
    backgroundColor: C.gold, paddingHorizontal: 14,
    paddingVertical: 9, borderRadius: 10,
  },
  importCard: {
    backgroundColor: C.navyMid, borderRadius: 18, padding: 18,
    marginBottom: 20, borderWidth: 1, borderColor: C.border,
  },
  importTitle: { fontSize: 14, fontWeight: '700', color: C.white, marginBottom: 8 },
  importDesc: { fontSize: 12, color: C.muted, lineHeight: 18, marginBottom: 12 },
  importFormat: {
    backgroundColor: C.navy, borderRadius: 10, padding: 12,
    marginBottom: 14, borderWidth: 1, borderColor: C.border,
  },
  importFormatRow: { fontSize: 11, color: C.muted, fontFamily: 'monospace', marginBottom: 3 },
  importBtn: {
    backgroundColor: C.teal, borderRadius: 12, padding: 13,
    alignItems: 'center',
  },
  importBtnText: { color: C.white, fontWeight: '700', fontSize: 14 },
  uploadResult: {
    marginTop: 14, padding: 14, backgroundColor: C.navy,
    borderRadius: 12, borderWidth: 1, borderColor: C.border,
  },
  uploadResultRow: { flexDirection: 'row', gap: 12 },
  uploadBadge: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: 10, borderWidth: 1,
  },
  errorBox: {
    backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '55',
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: C.coral, fontSize: 13, fontWeight: '600' },
  formCard: {
    backgroundColor: C.navyMid, borderRadius: 18, padding: 20,
    marginBottom: 24, borderWidth: 1, borderColor: C.border,
  },
  formTitle: { fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 16 },
  label: { fontSize: 11, fontWeight: '600', color: C.muted, marginBottom: 6, letterSpacing: 0.5 },
  input: {
    backgroundColor: C.navy, borderRadius: 12, padding: 14,
    color: C.white, fontSize: 15, marginBottom: 14,
    borderWidth: 1, borderColor: C.border,
  },
  submitBtn: {
    backgroundColor: C.gold, borderRadius: 12, padding: 14,
    alignItems: 'center', marginTop: 4,
  },
  submitBtnText: { color: C.navy, fontWeight: '700', fontSize: 15 },
  emptyState: { alignItems: 'center', marginTop: 40, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 8 },
  emptySubtitle: { fontSize: 13, color: C.muted, textAlign: 'center', lineHeight: 20 },
  listHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 4, paddingBottom: 10, marginBottom: 4,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  listHeaderText: { fontSize: 10, fontWeight: '700', color: C.muted, letterSpacing: 0.5 },
  studentRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.navyMid, borderRadius: 14, padding: 14,
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  rollBadge: {
    width: 40, height: 40, borderRadius: 10, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  rollText: { fontWeight: '800', fontSize: 14 },
  studentName: { fontSize: 14, fontWeight: '600', color: C.white },
  studentId: { fontSize: 11, color: C.muted, marginTop: 2 },
  phoneText: { fontSize: 12, color: C.muted, width: 110, textAlign: 'right' },
  deleteBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
