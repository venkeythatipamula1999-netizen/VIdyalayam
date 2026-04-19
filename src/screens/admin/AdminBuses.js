import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  Modal, ActivityIndicator, TextInput, BackHandler,
} from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Toast from '../../components/Toast';
import { getFriendlyError } from '../../utils/errorMessages';

function getIstTodayKey() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}

function getStudentId(student) {
  return String(student?.studentId || student?.id || '');
}

function getStudentName(student) {
  return student?.name || student?.studentName || 'Student';
}

function getStudentClass(student) {
  return student?.className || student?.class || student?.studentClass || '—';
}

function isDateWithin(dateKey, fromDate, toDate) {
  if (!dateKey || !fromDate) return false;
  const start = String(fromDate).slice(0, 10);
  const end = String(toDate || fromDate).slice(0, 10);
  return dateKey >= start && dateKey <= end;
}

function isApprovedLeaveToday(leave, dateKey) {
  return String(leave?.status || '').toLowerCase() === 'approved'
    && isDateWithin(dateKey, leave?.from || leave?.startDate, leave?.to || leave?.endDate);
}

function formatScanTimestamp(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export default function AdminBuses({ onBack, currentUser }) {
  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('manage');
  const [selectedBus, setSelectedBus] = useState(null);
  const [onboardStudents, setOnboardStudents] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [showOnboardModal, setShowOnboardModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const emptyForm = { busNumber: '', route: '', driverId: '', driverName: '', cleanerId: '', cleanerName: '' };
  const [form, setForm] = useState(emptyForm);

  const [drivers, setDrivers] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [showDriverPicker, setShowDriverPicker] = useState(false);
  const [showCleanerPicker, setShowCleanerPicker] = useState(false);

  const [allStudents, setAllStudents] = useState([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [busSummaryLoading, setBusSummaryLoading] = useState(true);
  const [busSummaryError, setBusSummaryError] = useState('');
  const [busSummaries, setBusSummaries] = useState([]);
  const [selectedBusSummary, setSelectedBusSummary] = useState(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const showToast = (msg, type = 'success') => setToast({ visible: true, message: msg, type });

  const fetchBuses = async () => {
    try {
      const res = await apiFetch('/admin/buses');
      const data = await res.json();
      if (data.success) setBuses(data.buses || []);
    } catch (e) {
      console.error('Failed to load buses:', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchBuses(); }, []);

  const fetchBusSummaries = useCallback(async (showLoader = true) => {
    if (showLoader) setBusSummaryLoading(true);
    setBusSummaryError('');
    try {
      const todayKey = getIstTodayKey();
      const [busesRes, leavesRes] = await Promise.all([
        apiFetch('/admin/buses?t=' + Date.now(), { cache: 'no-store' }),
        apiFetch('/leave-requests/students?t=' + Date.now(), { cache: 'no-store' }),
      ]);

      const [busesData, leavesData] = await Promise.all([busesRes.json(), leavesRes.json()]);
      const summaryBuses = busesData.buses || [];
      const leaveRequests = leavesData.requests || leavesData.leaves || [];
      const approvedLeavesToday = leaveRequests.filter(req => isApprovedLeaveToday(req, todayKey));

      const summaries = await Promise.all(
        summaryBuses.map(async (bus) => {
          const busId = bus.busId || bus.id || '';
          const busNumber = bus.busNumber || busId;
          const [passengersRes, scansRes] = await Promise.all([
            apiFetch(`/bus/passengers?busId=${encodeURIComponent(busId)}&t=${Date.now()}`, { cache: 'no-store' }),
            apiFetch(`/trip/scans?busNumber=${encodeURIComponent(busNumber)}&t=${Date.now()}`, { cache: 'no-store' }),
          ]);

          const [passengersData, scansData] = await Promise.all([passengersRes.json(), scansRes.json()]);
          const passengers = passengersData.passengers || [];
          const scans = scansData.scans || [];

          const boardedScanMap = {};
          scans
            .filter(scan => scan.type === 'board')
            .sort((a, b) => (a.timestamp || a.createdAt || '').localeCompare(b.timestamp || b.createdAt || ''))
            .forEach((scan) => {
              boardedScanMap[String(scan.studentId || '')] = scan;
            });

          const leaveStudentMap = {};
          approvedLeavesToday.forEach((leave) => {
            const leaveStudentId = String(leave.studentId || '');
            if (!leaveStudentId) return;
            if (!passengers.some(student => getStudentId(student) === leaveStudentId)) return;
            const matchedStudent = passengers.find(student => getStudentId(student) === leaveStudentId);
            leaveStudentMap[leaveStudentId] = {
              studentId: leaveStudentId,
              studentName: leave.studentName || getStudentName(matchedStudent),
              className: leave.studentClass || getStudentClass(matchedStudent),
            };
          });

          const boardedStudents = passengers
            .filter(student => boardedScanMap[getStudentId(student)])
            .map(student => {
              const scan = boardedScanMap[getStudentId(student)];
              return {
                studentId: getStudentId(student),
                studentName: scan?.studentName || getStudentName(student),
                className: scan?.className || getStudentClass(student),
                scanTime: scan?.timestamp || scan?.createdAt || '',
              };
            })
            .sort((a, b) => (a.scanTime || '').localeCompare(b.scanTime || ''));

          const onLeaveStudents = Object.values(leaveStudentMap).sort((a, b) => a.studentName.localeCompare(b.studentName));

          const notBoardedStudents = passengers
            .filter(student => {
              const studentId = getStudentId(student);
              return !boardedScanMap[studentId] && !leaveStudentMap[studentId];
            })
            .map(student => ({
              studentId: getStudentId(student),
              studentName: getStudentName(student),
              className: getStudentClass(student),
            }))
            .sort((a, b) => a.studentName.localeCompare(b.studentName));

          const recentScans = scans
            .slice()
            .sort((a, b) => (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || ''))
            .map(scan => ({
              id: scan.id || `${scan.studentId}_${scan.timestamp}`,
              studentName: scan.studentName || 'Student',
              className: scan.className || '—',
              timestamp: scan.timestamp || scan.createdAt || '',
              type: scan.type || '',
            }));

          return {
            id: busId || busNumber,
            busId,
            busNumber,
            studentsAllotted: passengers.length,
            boardedToday: boardedStudents.length,
            absent: notBoardedStudents.length,
            boardedStudents,
            notBoardedStudents,
            onLeaveStudents,
            recentScans,
          };
        })
      );

      setBusSummaries(summaries.sort((a, b) => String(a.busNumber).localeCompare(String(b.busNumber), undefined, { numeric: true })));
      setSelectedBusSummary(prev => prev ? summaries.find(bus => bus.id === prev.id) || prev : null);
    } catch (err) {
      const message = getFriendlyError(err, 'Failed to load bus summary');
      setBusSummaryError(message);
      showToast(message, 'error');
    } finally {
      if (showLoader) setBusSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBusSummaries(true);
    const interval = setInterval(() => fetchBusSummaries(false), 30000);
    return () => clearInterval(interval);
  }, [fetchBusSummaries]);

  const fetchStaff = async () => {
    setStaffLoading(true);
    try {
      const res = await apiFetch('/logistics-staff');
      const data = await res.json();
      const staff = data.staff || [];
      setDrivers(staff.filter(s => s.type === 'driver'));
      setCleaners(staff.filter(s => s.type === 'cleaner'));
    } catch (e) {
      console.error('Failed to load staff:', e.message);
    } finally {
      setStaffLoading(false);
    }
  };

  const openAddModal = () => {
    setForm(emptyForm);
    setShowDriverPicker(false);
    setShowCleanerPicker(false);
    setShowAddModal(true);
    fetchStaff();
  };

  const selectDriver = (driver) => {
    setForm(f => ({ ...f, driverName: driver.full_name, driverId: driver.staff_id || driver.id }));
    setShowDriverPicker(false);
  };

  const selectCleaner = (cleaner) => {
    setForm(f => ({ ...f, cleanerName: cleaner.full_name, cleanerId: cleaner.staff_id || cleaner.id }));
    setShowCleanerPicker(false);
  };

  const handleAddBus = async () => {
    if (!form.busNumber.trim()) {
      showToast('Vehicle Number is required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        busNumber: form.busNumber.trim(),
        route: form.route.trim(),
        driverId: form.driverId,
        driverName: form.driverName,
        cleanerId: form.cleanerId,
        cleanerName: form.cleanerName,
      };
      const res = await apiFetch('/admin/buses/add', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create bus');
      setShowAddModal(false);
      setForm(emptyForm);
      fetchBuses();
      showToast(`Bus created! Bus ID: ${data.busId || data.id || ''}`, 'success');
    } catch (err) {
      showToast(getFriendlyError(err, 'Failed to create bus.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const openOnboardModal = async (bus) => {
    setSelectedBus(bus);
    setShowOnboardModal(true);
    setModalLoading(true);
    try {
      const res = await apiFetch(`/bus/onboard-students?busId=${encodeURIComponent(bus.busId || bus.id)}`);
      const data = await res.json();
      if (data.success) setOnboardStudents(data.students || []);
    } catch (err) {
      console.error('Failed to fetch onboard students:', err.message);
    } finally {
      setModalLoading(false);
    }
  };

  const openAssignModal = async (bus) => {
    setSelectedBus(bus);
    setSelectedStudentIds(bus.assignedStudents || bus.studentIds || []);
    setShowAssignModal(true);
    setStudentsLoading(true);
    try {
      const classRes = await apiFetch('/classes');
      const classData = await classRes.json();
      const classes = classData.classes || classData || [];
      let allS = [];
      for (const cls of classes) {
        const sRes = await apiFetch(`/students/${encodeURIComponent(cls.id || cls.name)}`);
        const sData = await sRes.json();
        const students = sData.students || sData || [];
        allS = allS.concat(students.map(s => ({ ...s, className: cls.name })));
      }
      setAllStudents(allS);
    } catch (err) {
      console.error('Failed to load students:', err.message);
    } finally {
      setStudentsLoading(false);
    }
  };

  const handleAssignStudents = async () => {
    if (!selectedBus) return;
    setSaving(true);
    try {
      const res = await apiFetch('/admin/buses/assign-students', {
        method: 'POST',
        body: JSON.stringify({
          busId: selectedBus.busId || selectedBus.id,
          studentIds: selectedStudentIds
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to assign students');
      setShowAssignModal(false);
      showToast(`${data.count} students assigned`, 'success');
      fetchBuses();
    } catch (err) {
      showToast(getFriendlyError(err, 'Failed to assign students.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleStudent = (studentId) => {
    setSelectedStudentIds(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    );
  };

  const filteredStudents = allStudents.filter(s =>
    !searchText || (s.name || '').toLowerCase().includes(searchText.toLowerCase()) ||
    (s.className || '').toLowerCase().includes(searchText.toLowerCase())
  );

  const inputStyle = {
    backgroundColor: C.navyMid || '#0d2137',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    color: C.white,
    padding: 12,
    fontSize: 14,
    marginBottom: 10,
  };

  const pickerButtonStyle = {
    backgroundColor: C.navyMid || '#0d2137',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    marginBottom: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  };

  const nextRouteNumber = String(buses.length + 1).padStart(3, '0');

  return (
    <View style={{ flex: 1, backgroundColor: C.navy }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <TouchableOpacity onPress={onBack} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border }}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <View>
            <Text style={{ color: C.white, fontWeight: '700', fontSize: 18 }}>Bus Management</Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>{buses.length} buses registered</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={activeTab === 'manage' ? openAddModal : () => fetchBusSummaries(true)}
          style={{ backgroundColor: C.teal, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Text style={{ color: C.white, fontWeight: '700', fontSize: 13 }}>{activeTab === 'manage' ? '+ Add Bus' : 'Refresh'}</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingBottom: 16 }}>
        {[
          { key: 'manage', label: 'Manage Buses' },
          { key: 'summary', label: 'Bus Summary' },
        ].map(tab => (
          <TouchableOpacity
            key={tab.key}
            onPress={() => setActiveTab(tab.key)}
            style={{
              flex: 1,
              backgroundColor: activeTab === tab.key ? C.teal : C.card,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: activeTab === tab.key ? C.teal : C.border,
              paddingVertical: 12,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: activeTab === tab.key ? C.white : C.muted, fontWeight: '700', fontSize: 13 }}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Bus List */}
      {activeTab === 'manage' ? (
      loading ? (
        <ActivityIndicator size="large" color={C.teal} style={{ marginTop: 40 }} />
      ) : buses.length === 0 ? (
        <View style={{ alignItems: 'center', marginTop: 60, paddingHorizontal: 32 }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🚌</Text>
          <Text style={{ color: C.white, fontWeight: '700', fontSize: 16, marginBottom: 8 }}>No Buses Yet</Text>
          <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>Tap "+ Add Bus" to register your first school bus</Text>
        </View>
      ) : (
        <ScrollView style={{ paddingHorizontal: 20 }}>
          {buses.map((bus, i) => (
            <View key={i} style={{ backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.border }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.white, fontWeight: '700', fontSize: 15 }}>🚌 {bus.busNumber || bus.vehicleNo || 'Bus ' + (i + 1)}</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>ID: {bus.busId || bus.id}</Text>
                  {bus.route ? <Text style={{ color: C.muted, fontSize: 12 }}>Route: {bus.route}</Text> : null}
                  {bus.driverName ? <Text style={{ color: C.muted, fontSize: 12 }}>Driver: {bus.driverName}</Text> : null}
                  <Text style={{ color: C.teal, fontSize: 12, marginTop: 4 }}>
                    {(bus.assignedStudents || bus.studentIds || []).length} students assigned
                  </Text>
                </View>
                <View style={{ backgroundColor: bus.status === 'active' ? C.teal + '22' : C.muted + '22', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 }}>
                  <Text style={{ color: bus.status === 'active' ? C.teal : C.muted, fontSize: 11 }}>
                    {bus.status === 'active' ? '🟢 Active' : '⚪ Inactive'}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <TouchableOpacity
                  onPress={() => openOnboardModal(bus)}
                  style={{ flex: 1, backgroundColor: C.teal + '22', borderRadius: 10, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: C.teal + '44' }}
                >
                  <Text style={{ color: C.teal, fontSize: 12, fontWeight: '600' }}>👁 View Onboard</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => openAssignModal(bus)}
                  style={{ flex: 1, backgroundColor: C.gold + '22', borderRadius: 10, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: C.gold + '44' }}
                >
                  <Text style={{ color: C.gold, fontSize: 12, fontWeight: '600' }}>👥 Assign Students</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
          <View style={{ height: 40 }} />
        </ScrollView>
      )) : (
        busSummaryLoading ? (
          <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20 }}>
            <LoadingSpinner message="Loading bus summary..." />
          </View>
        ) : busSummaryError ? (
          <View style={{ marginHorizontal: 20, marginTop: 20, backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.coral + '44', padding: 16 }}>
            <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load bus summary</Text>
            <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{busSummaryError}</Text>
            <TouchableOpacity onPress={() => fetchBusSummaries(true)} style={{ alignSelf: 'flex-start', backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 }}>
              <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView style={{ paddingHorizontal: 20 }}>
            <View style={{ backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden', marginBottom: 24 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, backgroundColor: C.navyMid, borderBottomWidth: 1, borderBottomColor: C.border }}>
                <Text style={{ flex: 1.2, color: C.white, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>Bus Number</Text>
                <Text style={{ flex: 1, color: C.white, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>Students Allotted</Text>
                <Text style={{ flex: 1, color: C.white, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>Boarded Today</Text>
                <Text style={{ flex: 1, color: C.white, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>Absent</Text>
              </View>

              {busSummaries.length === 0 ? (
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <Text style={{ color: C.muted, fontSize: 13 }}>No buses found yet.</Text>
                </View>
              ) : (
                <>
                  {busSummaries.map((bus, index) => (
                    <TouchableOpacity
                      key={bus.id}
                      onPress={() => setSelectedBusSummary(bus)}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: index === busSummaries.length - 1 ? C.border : C.border }}
                    >
                      <Text style={{ flex: 1.2, color: C.white, fontSize: 12, fontWeight: '700', textAlign: 'center' }}>{bus.busNumber || '—'}</Text>
                      <Text style={{ flex: 1, color: C.muted, fontSize: 12, textAlign: 'center' }}>{bus.studentsAllotted}</Text>
                      <Text style={{ flex: 1, color: C.teal, fontSize: 12, fontWeight: '700', textAlign: 'center' }}>{bus.boardedToday}</Text>
                      <Text style={{ flex: 1, color: C.coral, fontSize: 12, fontWeight: '700', textAlign: 'center' }}>{bus.absent}</Text>
                    </TouchableOpacity>
                  ))}
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 14, backgroundColor: C.navyMid, borderTopWidth: 1, borderTopColor: C.border }}>
                    <Text style={{ flex: 1.2, color: C.white, fontSize: 12, fontWeight: '800', textAlign: 'center' }}>Total</Text>
                    <Text style={{ flex: 1, color: C.white, fontSize: 12, fontWeight: '800', textAlign: 'center' }}>{busSummaries.reduce((sum, bus) => sum + bus.studentsAllotted, 0)}</Text>
                    <Text style={{ flex: 1, color: C.teal, fontSize: 12, fontWeight: '800', textAlign: 'center' }}>{busSummaries.reduce((sum, bus) => sum + bus.boardedToday, 0)}</Text>
                    <Text style={{ flex: 1, color: C.coral, fontSize: 12, fontWeight: '800', textAlign: 'center' }}>{busSummaries.reduce((sum, bus) => sum + bus.absent, 0)}</Text>
                  </View>
                </>
              )}
            </View>
          </ScrollView>
        )
      )}

      {/* ── ADD BUS MODAL ── */}
      <Modal visible={!!selectedBusSummary} transparent animationType="slide" onRequestClose={() => setSelectedBusSummary(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.navy, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '84%', borderWidth: 1, borderColor: C.border, borderBottomWidth: 0 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ color: C.white, fontSize: 18, fontWeight: '800' }}>{'\uD83D\uDE8C'} {selectedBusSummary?.busNumber || 'Bus Detail'}</Text>
                <Text style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
                  {selectedBusSummary ? `${selectedBusSummary.studentsAllotted} allotted · ${selectedBusSummary.boardedToday} boarded · ${selectedBusSummary.absent} absent` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedBusSummary(null)} style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: C.muted, fontSize: 18 }}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ marginBottom: 18 }}>
                <Text style={{ color: C.white, fontSize: 15, fontWeight: '700', marginBottom: 10 }}>{'\u2705'} Boarded</Text>
                {selectedBusSummary?.boardedStudents.length ? selectedBusSummary.boardedStudents.map((student) => (
                  <View key={`boarded-${student.studentId}`} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, marginBottom: 8, gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.white, fontSize: 13, fontWeight: '700' }}>{student.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{student.className}</Text>
                    </View>
                    <Text style={{ color: C.teal, fontSize: 11, fontWeight: '700' }}>{formatScanTimestamp(student.scanTime)}</Text>
                  </View>
                )) : <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>No boarded students yet.</Text>}
              </View>

              <View style={{ marginBottom: 18 }}>
                <Text style={{ color: C.white, fontSize: 15, fontWeight: '700', marginBottom: 10 }}>{'\u274C'} Not Boarded</Text>
                {selectedBusSummary?.notBoardedStudents.length ? selectedBusSummary.notBoardedStudents.map((student) => (
                  <View key={`absent-${student.studentId}`} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, marginBottom: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.white, fontSize: 13, fontWeight: '700' }}>{student.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{student.className}</Text>
                    </View>
                  </View>
                )) : <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>No absent students right now.</Text>}
              </View>

              <View style={{ marginBottom: 18 }}>
                <Text style={{ color: C.white, fontSize: 15, fontWeight: '700', marginBottom: 10 }}>{'\uD83D\uDFE1'} On Leave</Text>
                {selectedBusSummary?.onLeaveStudents.length ? selectedBusSummary.onLeaveStudents.map((student) => (
                  <View key={`leave-${student.studentId}`} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, marginBottom: 8, gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.white, fontSize: 13, fontWeight: '700' }}>{student.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{student.className}</Text>
                    </View>
                    <View style={{ backgroundColor: C.gold + '22', borderRadius: 99, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.gold + '44' }}>
                      <Text style={{ color: C.gold, fontSize: 11, fontWeight: '700' }}>Skip Stop</Text>
                    </View>
                  </View>
                )) : <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>No approved leave students today.</Text>}
              </View>

              <View style={{ marginBottom: 8 }}>
                <Text style={{ color: C.white, fontSize: 15, fontWeight: '700', marginBottom: 10 }}>Recent Scans</Text>
                {selectedBusSummary?.recentScans.length ? selectedBusSummary.recentScans.map((scan) => (
                  <View key={`scan-${scan.id}`} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, marginBottom: 8, gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.white, fontSize: 13, fontWeight: '700' }}>{scan.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{scan.className}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: scan.type === 'board' ? C.teal : C.gold, fontSize: 11, fontWeight: '700' }}>{scan.type === 'board' ? 'Boarded' : 'Arrived'}</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{formatScanTimestamp(scan.timestamp)}</Text>
                    </View>
                  </View>
                )) : <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>No scans recorded today.</Text>}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={showAddModal} transparent animationType="slide" onRequestClose={() => setShowAddModal(false)}>
        <View style={{ flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.navy, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '92%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ color: C.white, fontWeight: '700', fontSize: 17 }}>🚌 Add New Bus</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <Text style={{ color: C.muted, fontSize: 22 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">

              {/* Vehicle Number */}
              <Text style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>VEHICLE NUMBER *</Text>
              <TextInput
                style={inputStyle}
                placeholder="e.g. TN-07-1234"
                placeholderTextColor={C.muted}
                value={form.busNumber}
                onChangeText={t => setForm(f => ({ ...f, busNumber: t }))}
              />

              {/* Bus ID preview (read-only) */}
              <View style={{ backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.teal + '66', padding: 12, marginBottom: 14 }}>
                <Text style={{ color: C.muted, fontSize: 10, marginBottom: 2 }}>BUS ID (AUTO-GENERATED)</Text>
                <Text style={{ color: C.teal, fontWeight: '700', fontSize: 15 }}>
                  SG-Route-{String(buses.length + 1).padStart(3, '0')}
                </Text>
                <Text style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>Assigned automatically by server</Text>
              </View>

              {/* Route Name + Route ID preview */}
              <Text style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>ROUTE NAME</Text>
              <TextInput
                style={inputStyle}
                placeholder="e.g. Route 7 - OMR"
                placeholderTextColor={C.muted}
                value={form.route}
                onChangeText={t => setForm(f => ({ ...f, route: t }))}
              />
              <Text style={{ color: C.teal, fontSize: 11, marginTop: -6, marginBottom: 12 }}>
                Route ID will be: auto-generated (e.g. SG-Route-{nextRouteNumber})
              </Text>

              {/* Driver Dropdown */}
              <Text style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>DRIVER</Text>
              <TouchableOpacity
                style={pickerButtonStyle}
                onPress={() => { setShowDriverPicker(v => !v); setShowCleanerPicker(false); }}
              >
                <Text style={{ color: form.driverName ? C.white : C.muted, fontSize: 14 }}>
                  {form.driverName || (staffLoading ? 'Loading drivers...' : 'Select a driver')}
                </Text>
                <Text style={{ color: C.muted, fontSize: 12 }}>{showDriverPicker ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {showDriverPicker && (
                <View style={{ backgroundColor: C.navyMid || '#0d2137', borderRadius: 10, borderWidth: 1, borderColor: C.border, marginBottom: 10, maxHeight: 180 }}>
                  <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                    {drivers.length === 0 ? (
                      <Text style={{ color: C.muted, padding: 12, fontSize: 13 }}>
                        {staffLoading ? 'Loading...' : 'No drivers found'}
                      </Text>
                    ) : drivers.map((d, i) => (
                      <TouchableOpacity
                        key={i}
                        onPress={() => selectDriver(d)}
                        style={{ padding: 12, borderBottomWidth: i < drivers.length - 1 ? 1 : 0, borderBottomColor: C.border }}
                      >
                        <Text style={{ color: C.white, fontSize: 14 }}>{d.full_name}</Text>
                        {d.staff_id ? <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>ID: {d.staff_id}</Text> : null}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
              {form.driverId ? (
                <Text style={{ color: C.muted, fontSize: 11, marginTop: -6, marginBottom: 10 }}>Driver ID: {form.driverId}</Text>
              ) : null}

              {/* Cleaner Dropdown */}
              <Text style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>CLEANER</Text>
              <TouchableOpacity
                style={pickerButtonStyle}
                onPress={() => { setShowCleanerPicker(v => !v); setShowDriverPicker(false); }}
              >
                <Text style={{ color: form.cleanerName ? C.white : C.muted, fontSize: 14 }}>
                  {form.cleanerName || (staffLoading ? 'Loading cleaners...' : 'Select a cleaner')}
                </Text>
                <Text style={{ color: C.muted, fontSize: 12 }}>{showCleanerPicker ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {showCleanerPicker && (
                <View style={{ backgroundColor: C.navyMid || '#0d2137', borderRadius: 10, borderWidth: 1, borderColor: C.border, marginBottom: 10, maxHeight: 180 }}>
                  <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                    {cleaners.length === 0 ? (
                      <Text style={{ color: C.muted, padding: 12, fontSize: 13 }}>
                        {staffLoading ? 'Loading...' : 'No cleaners found'}
                      </Text>
                    ) : cleaners.map((c, i) => (
                      <TouchableOpacity
                        key={i}
                        onPress={() => selectCleaner(c)}
                        style={{ padding: 12, borderBottomWidth: i < cleaners.length - 1 ? 1 : 0, borderBottomColor: C.border }}
                      >
                        <Text style={{ color: C.white, fontSize: 14 }}>{c.full_name}</Text>
                        {c.staff_id ? <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>ID: {c.staff_id}</Text> : null}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
              {form.cleanerId ? (
                <Text style={{ color: C.muted, fontSize: 11, marginTop: -6, marginBottom: 10 }}>Cleaner ID: {form.cleanerId}</Text>
              ) : null}

              <TouchableOpacity
                onPress={handleAddBus}
                disabled={saving}
                style={{ backgroundColor: C.teal, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8, marginBottom: 24, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? <ActivityIndicator color={C.white} /> : <Text style={{ color: C.white, fontWeight: '700', fontSize: 15 }}>Create Bus</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── ASSIGN STUDENTS MODAL ── */}
      <Modal visible={showAssignModal} transparent animationType="slide" onRequestClose={() => setShowAssignModal(false)}>
        <View style={{ flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.navy, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '90%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <View>
                <Text style={{ color: C.white, fontWeight: '700', fontSize: 17 }}>👥 Assign Students</Text>
                <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                  {selectedBus?.busNumber} · {selectedStudentIds.length} selected
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowAssignModal(false)}>
                <Text style={{ color: C.muted, fontSize: 22 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={{ ...inputStyle, marginBottom: 12 }}
              placeholder="Search students..."
              placeholderTextColor={C.muted}
              value={searchText}
              onChangeText={setSearchText}
            />
            {studentsLoading ? (
              <ActivityIndicator size="large" color={C.teal} style={{ marginVertical: 30 }} />
            ) : (
              <ScrollView style={{ maxHeight: 340 }}>
                {filteredStudents.map((student, i) => {
                  const isSelected = selectedStudentIds.includes(student.studentId);
                  return (
                    <TouchableOpacity
                      key={i}
                      onPress={() => toggleStudent(student.studentId)}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 }}
                    >
                      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: isSelected ? C.teal : C.border, backgroundColor: isSelected ? C.teal : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                        {isSelected && <Text style={{ color: C.white, fontSize: 13, fontWeight: '700' }}>✓</Text>}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: C.white, fontSize: 13, fontWeight: '600' }}>{student.name}</Text>
                        <Text style={{ color: C.muted, fontSize: 11 }}>{student.className} · Roll {student.rollNumber}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              onPress={handleAssignStudents}
              disabled={saving}
              style={{ backgroundColor: C.gold, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 16, opacity: saving ? 0.6 : 1 }}
            >
              {saving
                ? <ActivityIndicator color={C.navy} />
                : <Text style={{ color: C.navy, fontWeight: '700', fontSize: 15 }}>Save — {selectedStudentIds.length} Students</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Toast {...toast} onHide={() => setToast(t => ({ ...t, visible: false }))} />

      {/* ── ONBOARD STUDENTS MODAL ── */}
      <Modal visible={showOnboardModal} transparent animationType="slide" onRequestClose={() => setShowOnboardModal(false)}>
        <View style={{ flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.navy, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '80%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <View>
                <Text style={{ color: C.white, fontWeight: '700', fontSize: 17 }}>
                  🚌 {selectedBus?.busNumber} — Today's Onboard
                </Text>
                <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                  {onboardStudents.length} students scanned today
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowOnboardModal(false)}>
                <Text style={{ color: C.muted, fontSize: 22 }}>✕</Text>
              </TouchableOpacity>
            </View>
            {modalLoading ? (
              <ActivityIndicator size="large" color={C.teal} style={{ marginVertical: 30 }} />
            ) : onboardStudents.length === 0 ? (
              <Text style={{ color: C.muted, textAlign: 'center', marginVertical: 30 }}>No students scanned today</Text>
            ) : (
              <ScrollView>
                {onboardStudents.map((student, i) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: i < onboardStudents.length - 1 ? 1 : 0, borderBottomColor: C.border }}>
                    <View>
                      <Text style={{ color: C.white, fontWeight: '600', fontSize: 14 }}>{student.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                        {student.status === 'Onboard' ? '🚌 On the bus' : '🏫 Arrived at school'}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <View style={{ backgroundColor: student.status === 'Onboard' ? C.teal + '22' : C.gold + '22', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99 }}>
                        <Text style={{ color: student.status === 'Onboard' ? C.teal : C.gold, fontSize: 11, fontWeight: '600' }}>{student.status}</Text>
                      </View>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>
                        {new Date(student.lastScan).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
