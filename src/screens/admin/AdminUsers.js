import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Modal, Platform, ActivityIndicator, BackHandler, SafeAreaView } from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { LinearGradient } from 'expo-linear-gradient';
import { getFriendlyError } from '../../utils/errorMessages';
import { apiFetch } from '../../api/client';
import { SUBJECTS, getSubjectLabel } from '../../constants/subjects';

export default function AdminUsers({ onBack, onNavigate }) {
  const [tab, setTab] = useState('teachers');
  const [search, setSearch] = useState('');
  const [onboardedUsers, setOnboardedUsers] = useState([]);
  const [logisticsStaff, setLogisticsStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [showCleanerForm, setShowCleanerForm] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [dutyMap, setDutyMap] = useState({});
  const [onboardResult, setOnboardResult] = useState(null);
  const [onboardError, setOnboardError] = useState('');
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedSubjects, setSelectedSubjects] = useState([]);
  const [newRole, setNewRole] = useState('teacher');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [drvName, setDrvName] = useState('');
  const [drvBus, setDrvBus] = useState('');
  const [drvRoute, setDrvRoute] = useState('');
  const [drvPhone, setDrvPhone] = useState('');
  const [drvLicense, setDrvLicense] = useState('');
  const [drvExperience, setDrvExperience] = useState('');
  const [drvEmail, setDrvEmail] = useState('');
  const [newJoinDate, setNewJoinDate] = useState(new Date().toISOString().split('T')[0]);
  const [showSubjectPicker, setShowSubjectPicker] = useState(false);
  const [showJoinDatePicker, setShowJoinDatePicker] = useState(false);
  const today = new Date();
  const [pickerMonth, setPickerMonth] = useState(today.getMonth());
  const [pickerYear, setPickerYear] = useState(today.getFullYear());

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const formatDisplayDate = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}-${m}-${y}`;
  };

  const buildCalendarDays = (year, month) => {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const blanks = Array(firstDay).fill(null);
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    return [...blanks, ...days];
  };
  const [drvJoinDate, setDrvJoinDate] = useState(new Date().toISOString().split('T')[0]);
  const [clnJoinDate, setClnJoinDate] = useState(new Date().toISOString().split('T')[0]);
  const [clnName, setClnName] = useState('');
  const [clnArea, setClnArea] = useState('');
  const [clnPhone, setClnPhone] = useState('');
  const [parentAccounts, setParentAccounts] = useState([]);
  const [parentsLoading, setParentsLoading] = useState(false);
  const [parentAction, setParentAction] = useState(null);
  const [parentActionLoading, setParentActionLoading] = useState(false);

  const [addingStaff, setAddingStaff] = useState(false);
  const [staffResult, setStaffResult] = useState(null);
  const [staffError, setStaffError] = useState('');
  const [staffCopied, setStaffCopied] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [timetableEntries, setTimetableEntries] = useState([]);
  const [savingTimetable, setSavingTimetable] = useState(false);
  const [ttMsg, setTtMsg] = useState('');
  const [ttMsgType, setTtMsgType] = useState('success');
  const [loadingTimetable, setLoadingTimetable] = useState(false);
  const [showAddClass, setShowAddClass] = useState(false);
  const [newClassPick, setNewClassPick] = useState('');
  const [classTeacherOf, setClassTeacherOf] = useState('');
  const [showCtPicker, setShowCtPicker] = useState(false);
  const [savingCt, setSavingCt] = useState(false);
  const [ctMsg, setCtMsg] = useState('');
  const [newClassSubj, setNewClassSubj] = useState('');
  const [newClassDays, setNewClassDays] = useState([]);
  const [newClassStart, setNewClassStart] = useState('');
  const [newClassEnd, setNewClassEnd] = useState('');
  const [newClassRoom, setNewClassRoom] = useState('');

  const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const [availableClasses, setAvailableClasses] = useState([]);
  const [allClassList, setAllClassList] = useState([]);
  const [assignedMap, setAssignedMap] = useState({});
  const [conflictError, setConflictError] = useState('');
  const [checkingConflict, setCheckingConflict] = useState(false);
  const [ctWarning, setCtWarning] = useState('');
  const [showCtConfirm, setShowCtConfirm] = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const SCHOOL_TIMES = [
    '8:00 AM','8:30 AM','9:00 AM','9:30 AM','10:00 AM','10:30 AM',
    '11:00 AM','11:30 AM','12:00 PM','12:30 PM','1:00 PM','1:30 PM',
    '2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM',
    '5:00 PM','5:30 PM','6:00 PM',
  ];

  const parseTime = (t) => {
    if (t === null || t === undefined || t === '') return null;
    const m = t.trim().match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    const p = m[3].toUpperCase();
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  };

  const timesOverlap = (s1, e1, s2, e2) => {
    const a = parseTime(s1), b = parseTime(e1), c = parseTime(s2), d = parseTime(e2);
    if (a === null || b === null || c === null || d === null) return false;
    return a < d && c < b;
  };

  const formatClassName = (name) => {
    if (!name) return '';
    return name.replace(/^Grade\s+/i, '');
  };

  useEffect(() => {
    loadAllData();
    fetchClassesList();
    const dutyInterval = setInterval(fetchDutyStatus, 30000);
    return () => clearInterval(dutyInterval);
  }, []);

  useEffect(() => {
    if (tab === 'parents' && parentAccounts.length === 0) fetchParentAccounts();
  }, [tab]);

  const fetchClassesList = async (currentAssignment) => {
    try {
      const res = await apiFetch('/available-classes?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        const allNames = (data.allClasses || data.classes || []).map(c => c.name);
        setAllClassList(allNames);
        setAssignedMap(data.assignedMap || {});
        const availNames = (data.classes || []).map(c => c.name);
        const assigned = currentAssignment !== undefined ? currentAssignment : classTeacherOf;
        if (assigned && !availNames.includes(assigned)) availNames.push(assigned);
        availNames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        setAvailableClasses(availNames);
      }
    } catch (err) {
      console.error('Fetch classes error:', err);
    }
  };

  const loadAllData = async () => {
    setLoading(true);
    await Promise.all([fetchOnboardedUsers(), fetchLogisticsStaff(), fetchDutyStatus()]);
    setLoading(false);
  };

  const fetchDutyStatus = async () => {
    try {
      const res = await apiFetch('/duty/all-staff?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.staff) {
        const map = {};
        data.staff.forEach(s => { map[s.roleId] = s; });
        setDutyMap(map);
      }
    } catch (err) {
      console.error('Failed to fetch duty status:', err.message);
    }
  };

  const fetchOnboardedUsers = async () => {
    try {
      const res = await apiFetch('/onboarded-users?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.users) {
        const activeUsers = data.users.filter(u => u.status !== 'inactive');
        setOnboardedUsers(activeUsers);
        
        // If a user is currently selected, update their data from the fresh list
        if (selectedUser) {
          const updatedUser = activeUsers.find(u => 
            (u.role_id && u.role_id === selectedUser.role_id) || 
            (u.staff_id && u.staff_id === selectedUser.staff_id)
          );
          if (updatedUser) {
            setSelectedUser(updatedUser);
            setClassTeacherOf(updatedUser.classTeacherOf || '');
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch onboarded users:', err.message);
    }
  };

  const fetchLogisticsStaff = async () => {
    try {
      const res = await apiFetch('/logistics-staff?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.staff) setLogisticsStaff(data.staff.filter(s => s.status !== 'inactive'));
    } catch (err) {
      console.error('Failed to fetch logistics staff:', err.message);
    }
  };

  const fetchParentAccounts = async () => {
    setParentsLoading(true);
    try {
      const res = await apiFetch('/admin/parent-accounts?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.parents) setParentAccounts(data.parents);
    } catch (err) {
      console.error('Failed to fetch parent accounts:', err.message);
    } finally {
      setParentsLoading(false);
    }
  };

  const handleParentStatusChange = async (uid, action) => {
    setParentActionLoading(true);
    try {
      const res = await apiFetch(`/admin/parent-accounts/${uid}/status`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      if (res.ok) await fetchParentAccounts();
    } catch {}
    finally { setParentActionLoading(false); setParentAction(null); }
  };

  const teachers = onboardedUsers.filter(u => u.role === 'teacher' || u.role === 'staff');
  const drivers = logisticsStaff.filter(s => s.type === 'driver');
  const cleaners = logisticsStaff.filter(s => s.type === 'cleaner');

  const getFilteredList = () => {
    const q = search.toLowerCase();
    if (tab === 'teachers') return teachers.filter(u => u.full_name?.toLowerCase().includes(q) || u.role_id?.toLowerCase().includes(q));
    if (tab === 'drivers') return drivers.filter(s => s.full_name?.toLowerCase().includes(q) || s.staff_id?.toLowerCase().includes(q));
    if (tab === 'parents') return [];
    return cleaners.filter(s => s.full_name?.toLowerCase().includes(q) || s.staff_id?.toLowerCase().includes(q));
  };

  const filteredList = getFilteredList();

  const getUserStatus = (u) => {
    if (u.profileCompleted) return 'Active';
    if (u.status === 'onboarded') return 'Active';
    return 'Pending';
  };

  const getStatusColor = (status) => {
    return status === 'Active' ? '#22d38a' : C.gold;
  };

  const handleDelete = async (roleId, isLogistics) => {
    setDeleting(roleId);
    try {
      const resp = await apiFetch('/delete-user', {
        method: 'POST',
        body: JSON.stringify({ roleId, collection: isLogistics ? 'logistics_staff' : 'users' }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to remove');
      if (isLogistics) {
        setLogisticsStaff(prev => prev.filter(s => s.staff_id !== roleId));
      } else {
        setOnboardedUsers(prev => prev.filter(u => u.role_id !== roleId));
      }
      setSelectedUser(null);
    } catch (err) {
      console.error('Delete error:', err.message);
    } finally {
      setDeleting(null);
    }
  };

  const fetchTeacherTimetable = async (roleId) => {
    if (!roleId) return;
    setLoadingTimetable(true);
    setTtMsg('');
    try {
      const res = await apiFetch(`/teacher-timetable?roleId=${encodeURIComponent(roleId)}`);
      const data = await res.json();
      if (res.ok) setTimetableEntries(data.timetable || []);
    } catch (err) {
      console.error('Failed to fetch teacher timetable:', err.message);
    } finally {
      setLoadingTimetable(false);
    }
  };


  const handleSaveClassTeacher = async (roleId, grade) => {
    setSavingCt(true);
    setCtMsg('');
    try {
      const res = await apiFetch('/set-class-teacher', {
        method: 'POST',
        body: JSON.stringify({ roleId, grade: grade || null }),
      });
      const data = await res.json();
      if (res.ok) {
        setCtMsg('Class Teacher assignment saved!');
        setCtWarning('');
        setClassTeacherOf(grade || '');
        setSelectedUser(prev => prev ? { ...prev, classTeacherOf: grade || null } : prev);
        Promise.all([fetchOnboardedUsers(), fetchClassesList(grade || '')]);
        setTimeout(() => setCtMsg(''), 3000);
      } else {
        setCtMsg(data.error || 'Failed to save');
      }
    } catch (err) {
      setCtMsg(getFriendlyError(err, 'Failed to save class teacher'));
    } finally {
      setSavingCt(false);
    }
  };

  const handleAddClassEntry = async () => {
    if (!newClassPick || !newClassSubj.trim() || newClassDays.length === 0 || !newClassStart || !newClassEnd) return;
    setConflictError('');

    const startMin = parseTime(newClassStart);
    const endMin = parseTime(newClassEnd);

    if (startMin === null || endMin === null) {
      setConflictError('Please select valid school-hour times from the time pickers.');
      return;
    }
    if (endMin <= startMin) {
      setConflictError('End Time must be after Start Time. Please select a later end time.');
      return;
    }

    const selfConflict = timetableEntries.find(entry => {
      const shared = entry.days.filter(d => newClassDays.includes(d));
      if (!shared.length) return false;
      return timesOverlap(newClassStart, newClassEnd, entry.startTime, entry.endTime);
    });
    if (selfConflict) {
      const overlappingDays = selfConflict.days.filter(d => newClassDays.includes(d));
      const dayStr = overlappingDays.map(d => ({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' }[d] || d)).join(', ');
      setConflictError(`Conflict: This teacher already has Grade ${formatClassName(selfConflict.className)} (${selfConflict.subject}) scheduled on ${dayStr} from ${selfConflict.startTime} – ${selfConflict.endTime}. Please choose a different time or day.`);
      return;
    }

    setCheckingConflict(true);
    try {
      const roleId = selectedUser?.role_id;
      const res = await apiFetch('/check-timetable-conflict', {
        method: 'POST',
        body: JSON.stringify({ className: newClassPick, days: newClassDays, startTime: newClassStart, endTime: newClassEnd, excludeRoleId: roleId }),
      });
      const data = await res.json();
      if (data.conflicts && data.conflicts.length > 0) {
        const c = data.conflicts[0];
        const overlappingDays = c.days.filter(d => newClassDays.includes(d));
        const dayStr = overlappingDays.map(d => ({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' }[d] || d)).join(', ');
        setConflictError(`Conflict: Grade ${formatClassName(newClassPick)} is already occupied by ${c.teacherName} (${c.subject}) on ${dayStr} from ${c.startTime} – ${c.endTime}. Two teachers cannot be in the same class at the same time.`);
        setCheckingConflict(false);
        return;
      }
    } catch (err) {
      console.error('Conflict check failed:', err);
    }
    setCheckingConflict(false);

    const cleanName = formatClassName(newClassPick);
    const entry = { className: cleanName, subject: newClassSubj.trim(), days: [...newClassDays], startTime: newClassStart, endTime: newClassEnd, room: newClassRoom.trim() || '' };
    setTimetableEntries(prev => [...prev, entry]);
    setNewClassPick(''); setNewClassSubj(''); setNewClassDays([]); setNewClassStart(''); setNewClassEnd(''); setNewClassRoom('');
    setConflictError('');
    setShowAddClass(false);
  };

  const handleRemoveClassEntry = (idx) => {
    setTimetableEntries(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleDay = (day) => {
    setNewClassDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  };

  const handleSaveTimetable = async (roleId, teacherName) => {
    setSavingTimetable(true);
    setTtMsg('');
    try {
      const resp = await apiFetch('/save-timetable', {
        method: 'POST',
        body: JSON.stringify({ roleId, teacherName, timetable: timetableEntries }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to save');
      const parts = [];
      if (data.generated > 0) parts.push(`${data.generated} calendar events generated`);
      if (data.removedClasses > 0) parts.push(`${data.removedClasses} class(es) removed`);
      if (data.sheetSync) parts.push('synced to Master Timetable sheet');
      setTtMsg(parts.length > 0 ? 'Saved! ' + parts.join(', ') : 'Timetable saved successfully!');
      setTtMsgType('success');
    } catch (err) {
      setTtMsg(getFriendlyError(err, 'Failed to save timetable'));
      setTtMsgType('error');
    } finally {
      setSavingTimetable(false);
    }
  };

  const toggleSubject = (subjectId) => {
    setSelectedSubjects((prev) =>
      prev.includes(subjectId)
        ? prev.filter((item) => item !== subjectId)
        : [...prev, subjectId]
    );
  };

  const removeSubject = (subjectId) => {
    setSelectedSubjects((prev) => prev.filter((item) => item !== subjectId));
  };

  const handleOnboard = async () => {
    if (!newName.trim()) { setOnboardError('Please provide Full Name to continue.'); return; }
    if (!newPhone.trim() || !/^[6-9]\d{9}$/.test(newPhone.replace(/\s/g, ''))) { setOnboardError('Please provide Mobile Number to continue.'); return; }
    if (!newEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) { setOnboardError('Please provide Email to continue.'); return; }
    if (selectedSubjects.length === 0) { setOnboardError('Please select at least one subject to continue.'); return; }
    setOnboarding(true);
    setOnboardError('');
    try {
      const resp = await apiFetch('/onboard-teacher', {
        method: 'POST',
        body: JSON.stringify({
          fullName: newName.trim(),
          role: newRole,
          subjects: selectedSubjects,
          email: newEmail.trim(),
          phone: newPhone.replace(/\s/g, ''),
          joinDate: newJoinDate,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Onboarding failed');
      setOnboardResult(data);
      setNewName(''); setSelectedSubjects([]); setNewEmail(''); setNewPhone(''); setNewRole('teacher'); setNewJoinDate(new Date().toISOString().split('T')[0]);
      setShowForm(false);
      fetchOnboardedUsers();
    } catch (err) {
      setOnboardError(getFriendlyError(err, 'Failed to onboard. Try again.'));
    } finally {
      setOnboarding(false);
    }
  };

  const handleAddDriver = async () => {
    if (!drvName.trim()) { setStaffError('Please provide Full Name to continue.'); return; }
    if (!drvPhone.trim() || !/^[6-9]\d{9}$/.test(drvPhone.replace(/\s/g, ''))) { setStaffError('Please provide Mobile Number to continue.'); return; }
    if (!drvLicense.trim()) { setStaffError('Please provide License Number to continue.'); return; }
    if (!drvExperience.trim() || !/^\d+$/.test(drvExperience.trim())) { setStaffError('Please provide Experience to continue.'); return; }
    setAddingStaff(true); setStaffError('');
    try {
      const resp = await apiFetch('/add-logistics-staff', {
        method: 'POST',
        body: JSON.stringify({ fullName: drvName.trim(), type: 'driver', busNumber: drvBus.trim(), route: drvRoute.trim(), phone: drvPhone.replace(/\s/g, ''), license: drvLicense.trim(), experience: drvExperience.trim(), email: drvEmail.trim(), joinDate: drvJoinDate }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to add driver');
      setStaffResult(data);
      setDrvName(''); setDrvBus(''); setDrvRoute(''); setDrvPhone(''); setDrvLicense(''); setDrvExperience(''); setDrvEmail(''); setDrvJoinDate(new Date().toISOString().split('T')[0]);
      setShowDriverForm(false);
      fetchLogisticsStaff();
    } catch (err) { setStaffError(getFriendlyError(err, 'Failed to add driver')); }
    finally { setAddingStaff(false); }
  };

  const handleAddCleaner = async () => {
    if (!clnName.trim()) { setStaffError('Please provide Full Name to continue.'); return; }
    if (!clnPhone.trim() || !/^[6-9]\d{9}$/.test(clnPhone.replace(/\s/g, ''))) { setStaffError('Please provide Mobile Number to continue.'); return; }
    setAddingStaff(true); setStaffError('');
    try {
      const resp = await apiFetch('/add-logistics-staff', {
        method: 'POST',
        body: JSON.stringify({ fullName: clnName.trim(), type: 'cleaner', assignedArea: clnArea.trim(), phone: clnPhone.replace(/\s/g, ''), joinDate: clnJoinDate }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to add cleaner');
      setStaffResult(data);
      setClnName(''); setClnArea(''); setClnPhone(''); setClnJoinDate(new Date().toISOString().split('T')[0]);
      setShowCleanerForm(false);
      fetchLogisticsStaff();
    } catch (err) { setStaffError(getFriendlyError(err, 'Failed to add cleaner')); }
    finally { setAddingStaff(false); }
  };

  const handleCopyId = () => {
    const id = onboardResult?.teacherId;
    if (id && Platform.OS === 'web' && navigator.clipboard) {
      navigator.clipboard.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
    } else { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const handleCopyStaffId = () => {
    if (staffResult?.staffId && Platform.OS === 'web' && navigator.clipboard) {
      navigator.clipboard.writeText(staffResult.staffId).then(() => { setStaffCopied(true); setTimeout(() => setStaffCopied(false), 2000); });
    } else { setStaffCopied(true); setTimeout(() => setStaffCopied(false), 2000); }
  };

  const closeOnboardPopup = () => { setOnboardResult(null); setOnboardError(''); setCopied(false); };
  const closeStaffPopup = () => { setStaffResult(null); setStaffError(''); setStaffCopied(false); };

  if (selectedUser) {
    const u = selectedUser;
    const isTeacher = u._type === 'teacher';
    const isDriver = u._type === 'driver';
    const isCleaner = u._type === 'cleaner';
    const roleId = isTeacher ? u.role_id : u.staff_id;
    const name = u.full_name || '';
    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const accentColor = isTeacher ? C.purple : isDriver ? C.teal : C.gold;
    const status = getUserStatus(u);
    const statusColor = getStatusColor(status);

    return (
      <ScrollView style={st.container}>
        <View style={st.header}>
          <TouchableOpacity onPress={() => setSelectedUser(null)} style={st.backBtn}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <View>
            <Text style={{ fontWeight: '700', fontSize: 18, color: C.white }}>
              {isTeacher ? 'Teacher' : isDriver ? 'Driver' : 'Cleaner'} Profile
            </Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>{roleId}</Text>
                          ))}
                        </View>
        </View>
        <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          <LinearGradient colors={[accentColor + '22', C.navyMid]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderWidth: 1, borderColor: accentColor + '44', borderRadius: 22, padding: 20, marginBottom: 18 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 16 }}>
              <LinearGradient colors={[accentColor, accentColor + '88']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 68, height: 68, borderRadius: 22, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: accentColor + '66' }}>
                <Text style={{ fontSize: 22, fontWeight: '800', color: C.white }}>{initials}</Text>
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', fontSize: 19, color: C.white }}>{name}</Text>
                <Text style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>
                  {isTeacher
                    ? ((u.subjects || []).length
                      ? u.subjects.map(getSubjectLabel).join(', ')
                      : (u.subject || 'Teacher'))
                    : isDriver ? 'Bus Driver' : 'Cleaner / Attender'}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <View style={{ paddingVertical: 3, paddingHorizontal: 10, borderRadius: 20, backgroundColor: statusColor + '22', borderWidth: 1, borderColor: statusColor + '44' }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor }}>{status}</Text>
                  </View>
                  {isTeacher && classTeacherOf ? (
                    <View style={{ paddingVertical: 3, paddingHorizontal: 10, borderRadius: 20, backgroundColor: 'rgba(0,184,169,0.2)', borderWidth: 1, borderColor: 'rgba(0,184,169,0.5)' }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: C.teal }}>{'\uD83C\uDFEB'} CT: {classTeacherOf}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </LinearGradient>

          <View style={st.secHead}><Text style={st.secTitle}>Details</Text></View>
          <View style={[st.card, { marginBottom: 16 }]}>
            {[
              ['\uD83C\uDD94', 'System ID', roleId],
              ['\uD83D\uDCE7', 'Email', u.email || '—'],
              ['\uD83D\uDCDE', 'Phone', u.phone || u.mobile || '—'],
              ['\uD83E\uDE78', 'Blood Group', u.blood_group || '—'],
              ['\uD83D\uDCDE', 'Emergency Contact', u.emergency_contact || '—'],
              ['\uD83C\uDF82', 'Date of Birth', u.date_of_birth || '—'],
              ['\uD83D\uDCC5', 'Date of Joining', u.join_date || u.joined_date || '—'],
              ...(isTeacher ? [['\uD83D\uDCDA', 'Subjects', (u.subjects || []).length ? u.subjects.map(getSubjectLabel).join(', ') : (u.subject || '—')]] : []),
              ...(isDriver ? [
                ['\uD83D\uDE8C', 'Bus Number', u.bus_number || '—'],
                ['\uD83D\uDDFA\uFE0F', 'Route', u.route || '—'],
                ['\uD83D\uDCC4', 'License', u.license || '—'],
                ['\u23F1\uFE0F', 'Experience', u.experience ? u.experience + ' years' : '—'],
              ] : []),
              ...(isCleaner ? [['\uD83D\uDCCD', 'Assigned Area', u.assigned_area || '—']] : []),
            ].map(([ic, lbl, val], i, arr) => (
              <View key={lbl} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingBottom: i < arr.length - 1 ? 12 : 0, marginBottom: i < arr.length - 1 ? 12 : 0, borderBottomWidth: i < arr.length - 1 ? 1 : 0, borderBottomColor: C.border }}>
                <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: C.navyMid, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 16 }}>{ic}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 10, color: C.muted }}>{lbl}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: C.white, marginTop: 1 }}>{val}</Text>
                </View>
              </View>
            ))}
          </View>

          {isTeacher && (
            <View>
              <View style={st.secHead}><Text style={st.secTitle}>{'\uD83C\uDFEB'} Class Teacher Assignment</Text></View>

              {classTeacherOf ? (
                <View style={{ backgroundColor: 'rgba(0,184,169,0.1)', borderWidth: 1.5, borderColor: 'rgba(0,184,169,0.4)', borderRadius: 16, padding: 16, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(0,184,169,0.2)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 22 }}>{'\uD83C\uDFEB'}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10, color: C.teal, fontWeight: '700', letterSpacing: 0.5, marginBottom: 2 }}>CURRENTLY ASSIGNED AS CLASS TEACHER</Text>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: C.white }}>Grade {classTeacherOf}</Text>
                  </View>
                </View>
              ) : null}

              <View style={[st.card, { marginBottom: 16 }]}>
                <Text style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>Assign this teacher as the Class Teacher of a specific grade. The Class Teacher can mark attendance and send fee notifications for their class.</Text>
                <Text style={st.label}>Is Class Teacher of</Text>
                <TouchableOpacity onPress={() => setShowCtPicker(!showCtPicker)} style={[st.input, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
                  <Text style={{ color: classTeacherOf ? C.white : C.muted, fontSize: 15 }}>{classTeacherOf ? `Grade ${classTeacherOf}` : 'Not assigned (Subject Teacher only)'}</Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{showCtPicker ? '\u25B2' : '\u25BC'}</Text>
                </TouchableOpacity>
                {showCtPicker && (
                  <View style={{ backgroundColor: C.navyMid, borderRadius: 12, marginTop: 6, borderWidth: 1, borderColor: C.border, maxHeight: 200 }}>
                    <ScrollView nestedScrollEnabled>
                      <TouchableOpacity onPress={() => { setClassTeacherOf(''); setCtWarning(''); setShowCtPicker(false); }} style={{ paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.border }}>
                        <Text style={{ color: !classTeacherOf ? C.gold : C.muted, fontSize: 13, fontWeight: !classTeacherOf ? '700' : '400' }}>None (Subject Teacher only)</Text>
                      </TouchableOpacity>
                      {allClassList.map(cls => {
                        const existingCt = assignedMap[cls];
                        const isCurrent = classTeacherOf === cls;
                        const isTaken = existingCt && existingCt.role_id !== roleId;
                        return (
                          <TouchableOpacity key={cls} onPress={() => {
                            setClassTeacherOf(cls);
                            setShowCtPicker(false);
                            if (isTaken) setCtWarning(`Grade ${cls} already has ${existingCt.full_name || existingCt.role_id} as Class Teacher. Saving will remove their assignment.`);
                            else setCtWarning('');
                          }} style={{ paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Text style={{ color: isCurrent ? C.gold : C.white, fontSize: 13, fontWeight: isCurrent ? '700' : '400' }}>Grade {cls}</Text>
                            {isTaken ? <Text style={{ fontSize: 10, color: C.coral, fontWeight: '600' }}>⚠ Taken</Text> : null}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}
                {ctWarning ? (
                  <View style={{ backgroundColor: C.coral + '18', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, padding: 10, marginTop: 10 }}>
                    <Text style={{ color: C.coral, fontSize: 11, fontWeight: '600' }}>{'⚠️'} {ctWarning}</Text>
                  </View>
                ) : null}
                {ctMsg ? (
                  <View style={{ backgroundColor: '#22d38a22', borderWidth: 1, borderColor: '#22d38a44', borderRadius: 10, padding: 8, marginTop: 10 }}>
                    <Text style={{ color: '#22d38a', fontSize: 11, fontWeight: '600' }}>{'\u2705'} {ctMsg}</Text>
                  </View>
                ) : null}
                <TouchableOpacity onPress={() => handleSaveClassTeacher(roleId, classTeacherOf)} disabled={savingCt} style={{ backgroundColor: ctWarning ? C.coral : C.purple, borderRadius: 12, padding: 12, alignItems: 'center', marginTop: 12, opacity: savingCt ? 0.6 : 1 }}>
                  {savingCt ? (
                    <ActivityIndicator size="small" color={C.white} />
                  ) : (
                    <Text style={{ color: C.white, fontWeight: '700', fontSize: 13 }}>{ctWarning ? '⚠️ Override & Save' : 'Save Class Teacher Assignment'}</Text>
                  )}
                </TouchableOpacity>
              </View>

              <View style={st.secHead}>
                <Text style={st.secTitle}>{'\uD83D\uDCC5'} Academic Scheduler</Text>
                <Text style={{ fontSize: 11, color: C.muted }}>{timetableEntries.length} class{timetableEntries.length !== 1 ? 'es' : ''}</Text>
              </View>
              <View style={[st.card, { marginBottom: 16 }]}>
                {loadingTimetable ? (
                  <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <ActivityIndicator size="small" color={C.teal} />
                    <Text style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>Loading timetable...</Text>
                  </View>
                ) : (
                  <View>
                    {timetableEntries.length === 0 && !showAddClass && (
                      <View style={{ alignItems: 'center', paddingVertical: 16, marginBottom: 12 }}>
                        <Text style={{ fontSize: 28, marginBottom: 8 }}>{'\uD83D\uDCDA'}</Text>
                        <Text style={{ color: C.muted, fontSize: 12 }}>No classes assigned yet</Text>
                      </View>
                    )}

                    {timetableEntries.map((entry, idx) => (
                      <View key={idx} style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderLeftWidth: 3, borderLeftColor: C.teal, borderRadius: 14, padding: 12, marginBottom: 10 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontWeight: '700', fontSize: 14, color: C.white }}>Grade {formatClassName(entry.className)}</Text>
                            <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{entry.subject}{entry.room ? ' · ' + entry.room : ''}</Text>
                          </View>
                          <TouchableOpacity onPress={() => handleRemoveClassEntry(idx)} style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: C.coral + '22', alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ color: C.coral, fontSize: 14, fontWeight: '700' }}>{'×'}</Text>
                          </TouchableOpacity>
                        </View>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                          {entry.days.map(d => (
                            <View key={d} style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, backgroundColor: C.teal + '22' }}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: C.teal }}>{d}</Text>
                            </View>
                          ))}
                        </View>
                        <Text style={{ fontSize: 11, color: C.gold, fontWeight: '600' }}>{'⏰'} {entry.startTime} {'–'} {entry.endTime}</Text>
                      </View>
                    ))}

                    {timetableEntries.length > 0 && !showAddClass && (() => {
                      const daySlots = ALL_DAYS.reduce((acc, day) => {
                        const slots = timetableEntries.filter(e => e.days.includes(day)).sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));
                        if (slots.length > 0) acc[day] = slots;
                        return acc;
                      }, {});
                      const dayKeys = ALL_DAYS.filter(d => daySlots[d]);
                      if (dayKeys.length === 0) return null;
                      return (
                        <View style={{ backgroundColor: C.navyMid, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 12 }}>
                          <Text style={{ fontWeight: '700', fontSize: 12, color: C.muted, marginBottom: 10, letterSpacing: 0.5 }}>{'📅'} WEEKLY VIEW</Text>
                          {dayKeys.map(day => (
                            <View key={day} style={{ marginBottom: 10 }}>
                              <Text style={{ fontSize: 11, fontWeight: '800', color: C.gold, marginBottom: 5 }}>{day}</Text>
                              {daySlots[day].map((slot, i) => (
                                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingHorizontal: 8, backgroundColor: C.navy + '88', borderRadius: 8, marginBottom: 3 }}>
                                  <Text style={{ fontSize: 10, color: C.muted, width: 90 }}>{slot.startTime} {'–'} {slot.endTime}</Text>
                                  <Text style={{ fontSize: 12, fontWeight: '700', color: C.white, flex: 1 }}>Gr. {formatClassName(slot.className)}</Text>
                                  <Text style={{ fontSize: 11, color: C.teal }}>{slot.subject}</Text>
                                </View>
                              ))}
                            </View>
                          ))}
                        </View>
                      );
                    })()}

                    {showAddClass ? (
                      <View style={{ backgroundColor: C.navy, borderWidth: 1.5, borderColor: C.teal + '55', borderRadius: 16, padding: 14, marginBottom: 12 }}>
                        <Text style={{ fontWeight: '700', fontSize: 13, color: C.white, marginBottom: 12 }}>{'\u2795'} Add Class Assignment</Text>

                        <Text style={st.label}>Class *</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                          <View style={{ flexDirection: 'row', gap: 6 }}>
                            {(allClassList.length > 0 ? allClassList : []).map(cls => (
                              <TouchableOpacity key={cls} onPress={() => { setNewClassPick(cls); setConflictError(''); }} style={{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, backgroundColor: newClassPick === cls ? C.teal + '22' : C.navyMid, borderWidth: 1.5, borderColor: newClassPick === cls ? C.teal : C.border }}>
                                <Text style={{ fontSize: 11, fontWeight: '700', color: newClassPick === cls ? C.teal : C.muted }}>{cls}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </ScrollView>

                        <Text style={st.label}>Subject *</Text>
                        <TextInput style={[st.input, { marginBottom: 10 }]} placeholder="e.g. Mathematics" placeholderTextColor={C.muted} value={newClassSubj} onChangeText={setNewClassSubj} />

                        <Text style={st.label}>Days *</Text>
                        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                          {ALL_DAYS.map(d => (
                            <TouchableOpacity key={d} onPress={() => toggleDay(d)} style={{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, backgroundColor: newClassDays.includes(d) ? C.gold + '22' : C.navyMid, borderWidth: 1.5, borderColor: newClassDays.includes(d) ? C.gold : C.border }}>
                              <Text style={{ fontSize: 11, fontWeight: '700', color: newClassDays.includes(d) ? C.gold : C.muted }}>{newClassDays.includes(d) ? '\u2713 ' : ''}{d}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={st.label}>Start Time *</Text>
                            <TouchableOpacity onPress={() => { setShowStartPicker(p => !p); setShowEndPicker(false); }} style={[st.input, { justifyContent: 'center' }]}>
                              <Text style={{ color: newClassStart ? C.white : C.muted, fontSize: 13 }}>{newClassStart || '8:00 AM'}</Text>
                            </TouchableOpacity>
                            {showStartPicker && (
                              <View style={{ position: 'absolute', top: 60, left: 0, right: 0, zIndex: 100, backgroundColor: C.navyMid, borderRadius: 10, borderWidth: 1, borderColor: C.teal, maxHeight: 180 }}>
                                <ScrollView nestedScrollEnabled>
                                  {SCHOOL_TIMES.map(t => (
                                    <TouchableOpacity key={t} onPress={() => { setNewClassStart(t); setShowStartPicker(false); setConflictError(''); }} style={{ paddingVertical: 9, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.border + '44' }}>
                                      <Text style={{ color: newClassStart === t ? C.teal : C.white, fontWeight: newClassStart === t ? '700' : '400', fontSize: 13 }}>{t}</Text>
                                    </TouchableOpacity>
                                  ))}
                                </ScrollView>
                              </View>
                            )}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={st.label}>End Time *</Text>
                            <TouchableOpacity onPress={() => { setShowEndPicker(p => !p); setShowStartPicker(false); }} style={[st.input, { justifyContent: 'center' }]}>
                              <Text style={{ color: newClassEnd ? C.white : C.muted, fontSize: 13 }}>{newClassEnd || '9:00 AM'}</Text>
                            </TouchableOpacity>
                            {showEndPicker && (
                              <View style={{ position: 'absolute', top: 60, left: 0, right: 0, zIndex: 100, backgroundColor: C.navyMid, borderRadius: 10, borderWidth: 1, borderColor: C.teal, maxHeight: 180 }}>
                                <ScrollView nestedScrollEnabled>
                                  {SCHOOL_TIMES.filter(t => !newClassStart || parseTime(t) > parseTime(newClassStart)).map(t => (
                                    <TouchableOpacity key={t} onPress={() => { setNewClassEnd(t); setShowEndPicker(false); setConflictError(''); }} style={{ paddingVertical: 9, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.border + '44' }}>
                                      <Text style={{ color: newClassEnd === t ? C.teal : C.white, fontWeight: newClassEnd === t ? '700' : '400', fontSize: 13 }}>{t}</Text>
                                    </TouchableOpacity>
                                  ))}
                                </ScrollView>
                              </View>
                            )}
                          </View>
                        </View>

                        <Text style={st.label}>Room (optional)</Text>
                        <TextInput style={[st.input, { marginBottom: 12 }]} placeholder="e.g. Room 201" placeholderTextColor={C.muted} value={newClassRoom} onChangeText={setNewClassRoom} />

                        {conflictError ? (
                          <View style={{ backgroundColor: C.coral + '18', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, padding: 10, marginBottom: 10 }}>
                            <Text style={{ color: C.coral, fontSize: 11, fontWeight: '600' }}>{'🚫'} {conflictError}</Text>
                          </View>
                        ) : null}

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <TouchableOpacity onPress={() => { setShowAddClass(false); setNewClassPick(''); setNewClassSubj(''); setNewClassDays([]); setNewClassStart(''); setNewClassEnd(''); setNewClassRoom(''); setConflictError(''); setShowStartPicker(false); setShowEndPicker(false); }} style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 10, alignItems: 'center' }}>
                            <Text style={{ color: C.muted, fontWeight: '600', fontSize: 12 }}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={handleAddClassEntry} disabled={checkingConflict || !newClassPick || !newClassSubj.trim() || newClassDays.length === 0 || !newClassStart || !newClassEnd} style={{ flex: 1, backgroundColor: C.teal, borderRadius: 10, padding: 10, alignItems: 'center', opacity: (checkingConflict || !newClassPick || !newClassSubj.trim() || newClassDays.length === 0 || !newClassStart || !newClassEnd) ? 0.5 : 1 }}>
                            {checkingConflict ? <ActivityIndicator size="small" color={C.white} /> : <Text style={{ color: C.white, fontWeight: '700', fontSize: 12 }}>{'\u2713'} Add Class</Text>}
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <TouchableOpacity onPress={() => setShowAddClass(true)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, backgroundColor: C.teal + '15', borderWidth: 1, borderColor: C.teal + '33', marginBottom: 12 }}>
                        <Text style={{ color: C.teal, fontWeight: '700', fontSize: 13 }}>{'\u2795'} Add Class</Text>
                      </TouchableOpacity>
                    )}

                    {ttMsg ? (
                      <View style={{ backgroundColor: (ttMsgType === 'success' ? '#22d38a' : C.coral) + '22', borderWidth: 1, borderColor: (ttMsgType === 'success' ? '#22d38a' : C.coral) + '44', borderRadius: 10, padding: 10, marginBottom: 12 }}>
                        <Text style={{ color: ttMsgType === 'success' ? '#22d38a' : C.coral, fontSize: 11, fontWeight: '600' }}>{ttMsgType === 'success' ? '\u2705 ' : '\u26A0\uFE0F '}{ttMsg}</Text>
                      </View>
                    ) : null}

                    <TouchableOpacity onPress={() => handleSaveTimetable(roleId, name)} disabled={savingTimetable} style={{ backgroundColor: C.purple, borderRadius: 12, padding: 12, alignItems: 'center', opacity: savingTimetable ? 0.6 : 1 }}>
                      {savingTimetable ? (
                        <ActivityIndicator size="small" color={C.white} />
                      ) : (
                        <Text style={{ color: C.white, fontWeight: '700', fontSize: 13 }}>{'\uD83D\uDCC5'} Save Timetable & Generate Calendar</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
          )}

          <TouchableOpacity
            onPress={() => handleDelete(roleId, !isTeacher)}
            disabled={deleting === roleId}
            style={{ backgroundColor: C.coral + '11', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 14, padding: 13, alignItems: 'center', opacity: deleting === roleId ? 0.5 : 1 }}
          >
            {deleting === roleId ? (
              <ActivityIndicator size="small" color={C.coral} />
            ) : (
              <Text style={{ color: C.coral, fontSize: 13, fontWeight: '700' }}>{'\uD83D\uDDD1'} Remove User</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={st.container}>
      <View style={st.header}>
        <TouchableOpacity onPress={onBack} style={st.backBtn}>
          <Icon name="back" size={18} color={C.white} />
        </TouchableOpacity>
        <Text style={{ fontWeight: '700', fontSize: 18, color: C.white }}>Manage Users</Text>
      </View>

      <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
        <View style={{ flexDirection: 'row', backgroundColor: C.navyMid, borderRadius: 12, padding: 4, gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
          {[['teachers', 'Teachers'], ['drivers', 'Drivers'], ['cleaners', 'Cleaners'], ['parents', 'Parents'], ['students', 'Students']].map(([id, lbl]) => (
            <TouchableOpacity key={id} onPress={() => { setTab(id); setSearch(''); }} style={{ flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center', backgroundColor: tab === id ? C.gold : 'transparent', minWidth: 64 }}>
              <Text style={{ fontSize: 11, fontWeight: '600', color: tab === id ? C.navy : C.muted }}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ marginBottom: 14 }}>
          <View style={{ position: 'absolute', left: 12, top: 16, zIndex: 1 }}>
            <Icon name="search" size={15} color={C.muted} />
          </View>
          <TextInput
            style={[st.input, { paddingLeft: 36 }]}
            placeholder="Search by name or ID..."
            placeholderTextColor={C.muted}
            value={search}
            onChangeText={setSearch}
          />
        </View>

        {loading ? (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={C.gold} />
            <Text style={{ color: C.muted, fontSize: 13, marginTop: 12 }}>Loading staff...</Text>
          </View>
        ) : (
          <View>
            {tab === 'students' && (
              <View>
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                  <TouchableOpacity
                    onPress={() => onNavigate && onNavigate('student-import')}
                    style={{ flex: 1, backgroundColor: C.teal, borderRadius: 12, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                  >
                    <Text style={{ fontSize: 18 }}>📥</Text>
                    <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Import Students</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  onPress={() => onNavigate && onNavigate('student-list')}
                  style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.navyMid, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border }}
                >
                  <Text style={{ fontSize: 20, marginRight: 12 }}>🎓</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>View All Students</Text>
                    <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>Browse students and QR codes by class</Text>
                  </View>
                  <Text style={{ color: C.muted, fontSize: 18 }}>›</Text>
                </TouchableOpacity>
                <View style={{ backgroundColor: C.navyMid, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>How to import:</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>1. Download the CSV template</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>2. Fill in student details (admission number, name, class...)</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>3. Upload via Import Students</Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}>4. QR codes are auto-generated for each student</Text>
                </View>
              </View>
            )}

            {tab !== 'parents' && tab !== 'students' && (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ color: C.muted, fontSize: 12 }}>
                  {filteredList.length} {tab === 'teachers' ? 'teacher' : tab === 'drivers' ? 'driver' : 'cleaner'}{filteredList.length !== 1 ? 's' : ''} onboarded
                </Text>
                <TouchableOpacity onPress={loadAllData} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontSize: 11, color: C.muted, fontWeight: '600' }}>{'\u21BB'} Refresh</Text>
                </TouchableOpacity>
              </View>
            )}

            {tab !== 'parents' && tab !== 'students' && filteredList.length === 0 && !loading && (
              <View style={[st.card, { alignItems: 'center', paddingVertical: 28, marginBottom: 14 }]}>
                <Text style={{ fontSize: 36, marginBottom: 10 }}>
                  {tab === 'teachers' ? '\uD83D\uDC69\u200D\uD83C\uDFEB' : tab === 'drivers' ? '\uD83D\uDE8C' : '\uD83E\uDDF9'}
                </Text>
                <Text style={{ fontWeight: '600', fontSize: 14, color: C.white, marginBottom: 4 }}>
                  No {tab === 'teachers' ? 'Teachers' : tab === 'drivers' ? 'Drivers' : 'Cleaners'} Found
                </Text>
                <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>
                  {search ? 'Try a different search term' : `Add ${tab === 'teachers' ? 'teachers' : tab === 'drivers' ? 'drivers' : 'cleaners'} using the button below`}
                </Text>
              </View>
            )}

            {tab !== 'students' && filteredList.map(u => {
              const isTeacher = tab === 'teachers';
              const roleId = isTeacher ? u.role_id : u.staff_id;
              const name = u.full_name || '';
              const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
              const status = getUserStatus(u);
              const statusColor = getStatusColor(status);
              const accentColor = isTeacher ? C.purple : tab === 'drivers' ? C.teal : C.gold;
              const subtitle = isTeacher ? (u.subject || u.role || '') : tab === 'drivers' ? (u.bus_number || 'Driver') : (u.assigned_area || 'General Staff');
              const duty = dutyMap[roleId];
              const isOnDuty = duty?.onDuty === true;
              const dutyStatus = duty?.currentStatus || 'Off Duty';
              const dutyDotColor = isOnDuty ? '#34D399' : C.coral;

              return (
                <View key={roleId} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <View style={{ position: 'relative', flexShrink: 0 }}>
                    <LinearGradient colors={[accentColor + '44', accentColor + '22']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: accentColor + '33' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: accentColor }}>{initials || '?'}</Text>
                    </LinearGradient>
                    <View style={{ position: 'absolute', top: -2, right: -2, width: 12, height: 12, borderRadius: 6, backgroundColor: dutyDotColor, borderWidth: 2, borderColor: C.navy }} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '700', fontSize: 13, color: C.white }}>{name}</Text>
                    <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{roleId} {'·'} {subtitle}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', marginTop: 2, color: isOnDuty ? '#34D399' : C.muted }}>{dutyStatus}{duty?.clockIn ? ` · ${duty.clockIn}` : ''}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                    <View style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 20, backgroundColor: statusColor + '22', borderWidth: 1, borderColor: statusColor + '44' }}>
                      <Text style={{ fontSize: 9, fontWeight: '700', color: statusColor }}>{status}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        const typed = { ...u, _type: tab === 'teachers' ? 'teacher' : tab === 'drivers' ? 'driver' : 'cleaner' };
                        setSelectedUser(typed);
                        setTimetableEntries([]);
                        setTtMsg('');
                        const ct = u.classTeacherOf || '';
                        setClassTeacherOf(ct);
                        setCtMsg('');
                        setCtWarning('');
                        setConflictError('');
                        setShowCtPicker(false);
                        setShowAddClass(false);
                        if (tab === 'teachers' && u.role_id) {
                          fetchTeacherTimetable(u.role_id);
                          fetchClassesList(ct);
                        }
                      }}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: accentColor + '18', borderWidth: 1, borderColor: accentColor + '33' }}
                    >
                      <Text style={{ fontSize: 10, fontWeight: '700', color: accentColor }}>View Profile</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}

            {tab === 'teachers' && (
              <View style={{ marginTop: 12 }}>
                {showForm ? (
                  <View style={[st.card, { marginBottom: 12 }]}>
                    <Text style={{ fontWeight: '700', marginBottom: 12, color: C.white }}>Onboard New Teacher</Text>
                    <Text style={st.label}>Full Name *</Text>
                    <TextInput style={st.input} placeholder="e.g. Dr. Sanjay Kumar" placeholderTextColor={C.muted} value={newName} onChangeText={setNewName} />
                    <Text style={[st.label, { marginTop: 10 }]}>Mobile Number *</Text>
                    <TextInput style={st.input} placeholder="e.g. 9876543210" placeholderTextColor={C.muted} value={newPhone} onChangeText={(t) => setNewPhone(t.replace(/[^0-9]/g, '').slice(0, 10))} keyboardType="phone-pad" maxLength={10} />
                    <Text style={[st.label, { marginTop: 10 }]}>Email *</Text>
                    <TextInput style={st.input} placeholder="e.g. teacher@venkeys.edu" placeholderTextColor={C.muted} value={newEmail} onChangeText={setNewEmail} keyboardType="email-address" autoCapitalize="none" />
                    <Text style={[st.label, { marginTop: 10 }]}>Assigned Subjects *</Text>
                    <TouchableOpacity onPress={() => setShowSubjectPicker(true)} style={[st.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.cardAlt || '#1a2f4a', borderRadius: 10, borderWidth: 1, borderColor: C.border }]}>
                      <Text style={{ color: selectedSubjects.length ? C.white : C.muted, fontSize: 14 }}>
                        {selectedSubjects.length ? `${selectedSubjects.length} subject(s) selected` : 'Select Subjects'}
                      </Text>
                      <Text style={{ color: C.muted, fontSize: 12 }}>▾</Text>
                    </TouchableOpacity>
                    {selectedSubjects.length > 0 ? (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                        {selectedSubjects.map((subjectId) => (
                          <View key={subjectId} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 12 }}>
                            <Text style={{ color: C.white, fontSize: 12, fontWeight: '600' }}>{getSubjectLabel(subjectId)}</Text>
                            <TouchableOpacity onPress={() => removeSubject(subjectId)}>
                              <Text style={{ color: C.gold, fontSize: 12, fontWeight: '700' }}>✕</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <Text style={[st.label, { marginTop: 10 }]}>Date of Joining *</Text>
                    <TouchableOpacity
                      onPress={() => {
                        const [y, m] = newJoinDate.split('-');
                        setPickerYear(parseInt(y, 10));
                        setPickerMonth(parseInt(m, 10) - 1);
                        setShowJoinDatePicker(true);
                      }}
                      style={[st.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
                    >
                      <Text style={{ color: C.white, fontSize: 14 }}>{formatDisplayDate(newJoinDate)}</Text>
                      <Text style={{ fontSize: 16 }}>📅</Text>
                    </TouchableOpacity>
                    {onboardError ? (
                      <View style={{ backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, padding: 10, marginTop: 12 }}>
                        <Text style={{ color: C.coral, fontSize: 12, fontWeight: '600' }}>{onboardError}</Text>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                      <TouchableOpacity onPress={() => { setShowForm(false); setOnboardError(''); setSelectedSubjects([]); }} style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 10, alignItems: 'center' }}>
                        <Text style={{ color: C.muted, fontWeight: '700' }}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={handleOnboard} disabled={onboarding || selectedSubjects.length === 0} style={{ flex: 1, backgroundColor: C.teal, borderRadius: 12, padding: 10, alignItems: 'center', opacity: (onboarding || selectedSubjects.length === 0) ? 0.5 : 1 }}>
                        {onboarding ? <ActivityIndicator size="small" color={C.navy} /> : <Text style={{ color: C.navy, fontWeight: '700' }}>Generate & Onboard</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => setShowForm(true)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.teal, borderRadius: 14, paddingVertical: 14 }}>
                    <Icon name="users" size={16} color={C.navy} />
                    <Text style={{ color: C.navy, fontWeight: '600', fontSize: 15 }}>+ Add New Teacher</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {tab === 'drivers' && (
              <View style={{ marginTop: 12 }}>
                {showDriverForm ? (
                  <View style={[st.card, { marginBottom: 12 }]}>
                    <Text style={{ fontWeight: '700', marginBottom: 14, color: C.white, fontSize: 15 }}>{'\uD83D\uDE8C'} Add New Bus Driver</Text>
                    <Text style={st.label}>Full Name *</Text>
                    <TextInput style={st.input} placeholder="e.g. Rajan Kumar" placeholderTextColor={C.muted} value={drvName} onChangeText={setDrvName} />
                    <Text style={[st.label, { marginTop: 12 }]}>Mobile Number *</Text>
                    <TextInput style={st.input} placeholder="e.g. 9876543210" placeholderTextColor={C.muted} value={drvPhone} onChangeText={(t) => setDrvPhone(t.replace(/[^0-9]/g, '').slice(0, 10))} keyboardType="phone-pad" maxLength={10} />
                    <Text style={[st.label, { marginTop: 12 }]}>License Number *</Text>
                    <TextInput style={st.input} placeholder="e.g. TN-0920210003456" placeholderTextColor={C.muted} value={drvLicense} onChangeText={setDrvLicense} />
                    <Text style={[st.label, { marginTop: 12 }]}>Years of Experience *</Text>
                    <TextInput style={st.input} placeholder="e.g. 5" placeholderTextColor={C.muted} value={drvExperience} onChangeText={(t) => setDrvExperience(t.replace(/[^0-9]/g, ''))} keyboardType="number-pad" />
                    <Text style={[st.label, { marginTop: 12 }]}>Email (optional)</Text>
                    <TextInput style={st.input} placeholder="e.g. driver@email.com" placeholderTextColor={C.muted} value={drvEmail} onChangeText={setDrvEmail} keyboardType="email-address" autoCapitalize="none" />
                    <Text style={[st.label, { marginTop: 12 }]}>Bus Number</Text>
                    <TextInput style={st.input} placeholder="e.g. TN 01 AB 4521" placeholderTextColor={C.muted} value={drvBus} onChangeText={setDrvBus} />
                    <Text style={[st.label, { marginTop: 12 }]}>Route</Text>
                    <TextInput style={st.input} placeholder="e.g. Route 7 – Velachery \u2194 School" placeholderTextColor={C.muted} value={drvRoute} onChangeText={setDrvRoute} />
                    <Text style={[st.label, { marginTop: 12 }]}>Date of Joining *</Text>
                    <TextInput style={st.input} placeholder="YYYY-MM-DD" placeholderTextColor={C.muted} value={drvJoinDate} onChangeText={setDrvJoinDate} />
                    {staffError ? (
                      <View style={{ backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, padding: 10, marginTop: 12 }}>
                        <Text style={{ color: C.coral, fontSize: 12, fontWeight: '600' }}>{staffError}</Text>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                      <TouchableOpacity onPress={() => { setShowDriverForm(false); setStaffError(''); }} style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 10, alignItems: 'center' }}>
                        <Text style={{ color: C.muted, fontWeight: '700' }}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={handleAddDriver} disabled={addingStaff} style={{ flex: 1, backgroundColor: C.teal, borderRadius: 12, padding: 10, alignItems: 'center', opacity: addingStaff ? 0.6 : 1 }}>
                        {addingStaff ? <ActivityIndicator size="small" color={C.white} /> : <Text style={{ color: C.white, fontWeight: '700' }}>Add Driver</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => { setShowDriverForm(true); setStaffError(''); }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.teal, borderRadius: 14, paddingVertical: 14 }}>
                    <Text style={{ fontSize: 18 }}>{'\uD83D\uDE8C'}</Text>
                    <Text style={{ color: C.white, fontWeight: '600', fontSize: 15 }}>+ Add Bus Driver</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {tab === 'parents' && (
              <View style={{ marginTop: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{parentAccounts.length} parent account{parentAccounts.length !== 1 ? 's' : ''} registered</Text>
                  <TouchableOpacity onPress={fetchParentAccounts} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border }}>
                    <Text style={{ fontSize: 11, color: C.muted, fontWeight: '600' }}>{'\u21BB'} Refresh</Text>
                  </TouchableOpacity>
                </View>
                {parentsLoading ? (
                  <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                    <ActivityIndicator size="large" color={C.gold} />
                    <Text style={{ color: C.muted, fontSize: 13, marginTop: 12 }}>Loading parent accounts...</Text>
                  </View>
                ) : parentAccounts.length === 0 ? (
                  <View style={[st.card, { alignItems: 'center', paddingVertical: 28 }]}>
                    <Text style={{ fontSize: 36, marginBottom: 10 }}>{'👨‍👩‍👧'}</Text>
                    <Text style={{ fontWeight: '600', fontSize: 14, color: C.white, marginBottom: 4 }}>No Parent Accounts Yet</Text>
                    <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>Parents who register via the Parent Portal will appear here.</Text>
                  </View>
                ) : (
                  parentAccounts
                    .filter(p => {
                      const q = search.toLowerCase();
                      return !q || p.parentName?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q);
                    })
                    .map((p, i) => {
                      const status = p.accountStatus || 'active';
                      const statusColor = status === 'active' ? '#22d38a' : status === 'disabled' ? C.coral : C.gold;
                      const isLocked = p.lockUntil && new Date(p.lockUntil) > new Date();
                      return (
                        <View key={p.uid || i} style={[st.card, { marginBottom: 12 }]}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                            <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: statusColor + '22', borderWidth: 1, borderColor: statusColor + '44', alignItems: 'center', justifyContent: 'center' }}>
                              <Text style={{ fontSize: 20 }}>{'👤'}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontWeight: '700', fontSize: 14, color: C.white }}>{p.parentName || 'Unknown'}</Text>
                              <Text style={{ fontSize: 12, color: C.muted }}>{p.email}</Text>
                            </View>
                            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, backgroundColor: statusColor + '22', borderWidth: 1, borderColor: statusColor + '44' }}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor, textTransform: 'uppercase' }}>{status}</Text>
                            </View>
                          </View>

                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                            {[
                              { label: 'Phone', value: p.phone || 'N/A' },
                              { label: 'Children', value: (p.studentIds || []).length + ' linked' },
                              { label: 'PIN', value: p.hasPIN ? 'Set' : 'None' },
                              { label: 'Attempts', value: p.failedAttempts || 0 },
                            ].map(d => (
                              <View key={d.label} style={{ backgroundColor: C.navyMid, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 }}>
                                <Text style={{ fontSize: 10, color: C.muted }}>{d.label}</Text>
                                <Text style={{ fontSize: 12, fontWeight: '600', color: C.white }}>{d.value}</Text>
                              </View>
                            ))}
                          </View>

                          {isLocked && (
                            <View style={{ backgroundColor: C.coral + '22', borderRadius: 8, padding: 8, marginBottom: 10, borderWidth: 1, borderColor: C.coral + '44' }}>
                              <Text style={{ fontSize: 11, color: C.coral }}>{'🔒'} Account locked until {new Date(p.lockUntil).toLocaleTimeString()}</Text>
                            </View>
                          )}

                          {p.createdAt && (
                            <Text style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
                              Registered: {new Date(p.createdAt._seconds ? p.createdAt._seconds * 1000 : p.createdAt).toLocaleDateString()}
                            </Text>
                          )}

                          <View style={{ flexDirection: 'row', gap: 8 }}>
                            {status === 'active' ? (
                              <TouchableOpacity
                                onPress={() => handleParentStatusChange(p.uid, 'disable')}
                                disabled={parentActionLoading}
                                style={{ flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', alignItems: 'center', opacity: parentActionLoading ? 0.5 : 1 }}
                              >
                                <Text style={{ fontSize: 12, fontWeight: '700', color: C.coral }}>Disable</Text>
                              </TouchableOpacity>
                            ) : (
                              <TouchableOpacity
                                onPress={() => handleParentStatusChange(p.uid, 'activate')}
                                disabled={parentActionLoading}
                                style={{ flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: '#22d38a' + '22', borderWidth: 1, borderColor: '#22d38a' + '44', alignItems: 'center', opacity: parentActionLoading ? 0.5 : 1 }}
                              >
                                <Text style={{ fontSize: 12, fontWeight: '700', color: '#22d38a' }}>Activate</Text>
                              </TouchableOpacity>
                            )}
                            {(isLocked || (p.failedAttempts || 0) > 0) && (
                              <TouchableOpacity
                                onPress={() => handleParentStatusChange(p.uid, 'reset-attempts')}
                                disabled={parentActionLoading}
                                style={{ flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold + '44', alignItems: 'center', opacity: parentActionLoading ? 0.5 : 1 }}
                              >
                                <Text style={{ fontSize: 12, fontWeight: '700', color: C.gold }}>Reset Lockout</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>
                      );
                    })
                )}
              </View>
            )}

            {tab === 'cleaners' && (
              <View style={{ marginTop: 12 }}>
                {showCleanerForm ? (
                  <View style={[st.card, { marginBottom: 12 }]}>
                    <Text style={{ fontWeight: '700', marginBottom: 14, color: C.white, fontSize: 15 }}>{'\uD83E\uDDF9'} Add New Cleaner / General Staff</Text>
                    <Text style={st.label}>Full Name *</Text>
                    <TextInput style={st.input} placeholder="e.g. Muthu S." placeholderTextColor={C.muted} value={clnName} onChangeText={setClnName} />
                    <Text style={[st.label, { marginTop: 12 }]}>Mobile Number *</Text>
                    <TextInput style={st.input} placeholder="e.g. 8765432109" placeholderTextColor={C.muted} value={clnPhone} onChangeText={(t) => setClnPhone(t.replace(/[^0-9]/g, '').slice(0, 10))} keyboardType="phone-pad" maxLength={10} />
                    <Text style={[st.label, { marginTop: 12 }]}>Assigned Area / Bus (optional)</Text>
                    <TextInput style={st.input} placeholder="e.g. Bus 07 or Ground Floor" placeholderTextColor={C.muted} value={clnArea} onChangeText={setClnArea} />
                    <Text style={[st.label, { marginTop: 12 }]}>Date of Joining *</Text>
                    <TextInput style={st.input} placeholder="YYYY-MM-DD" placeholderTextColor={C.muted} value={clnJoinDate} onChangeText={setClnJoinDate} />
                    {staffError ? (
                      <View style={{ backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, padding: 10, marginTop: 12 }}>
                        <Text style={{ color: C.coral, fontSize: 12, fontWeight: '600' }}>{staffError}</Text>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                      <TouchableOpacity onPress={() => { setShowCleanerForm(false); setStaffError(''); }} style={{ flex: 1, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 10, alignItems: 'center' }}>
                        <Text style={{ color: C.muted, fontWeight: '700' }}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={handleAddCleaner} disabled={addingStaff} style={{ flex: 1, backgroundColor: C.purple, borderRadius: 12, padding: 10, alignItems: 'center', opacity: addingStaff ? 0.6 : 1 }}>
                        {addingStaff ? <ActivityIndicator size="small" color={C.white} /> : <Text style={{ color: C.white, fontWeight: '700' }}>Add Cleaner</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => { setShowCleanerForm(true); setStaffError(''); }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.purple, borderRadius: 14, paddingVertical: 14 }}>
                    <Text style={{ fontSize: 18 }}>{'\uD83E\uDDF9'}</Text>
                    <Text style={{ color: C.white, fontWeight: '600', fontSize: 15 }}>+ Add Cleaner / Attender</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        )}
      </View>

      <Modal visible={showSubjectPicker} transparent animationType="fade" onRequestClose={() => setShowSubjectPicker(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }} activeOpacity={1} onPress={() => setShowSubjectPicker(false)}>
          <View style={{ backgroundColor: C.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingBottom: 30 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 18, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontWeight: '700', fontSize: 16, color: C.white }}>Select Subjects</Text>
              <TouchableOpacity onPress={() => setShowSubjectPicker(false)}>
                <Text style={{ color: C.muted, fontSize: 14 }}>✕</Text>
              </TouchableOpacity>
            </View>
            {SUBJECTS.map((subj) => {
              const isSelected = selectedSubjects.includes(subj.id);
              return (
                <TouchableOpacity
                  key={subj.id}
                  onPress={() => toggleSubject(subj.id)}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: C.border + '55' }}
                >
                <Text style={{ fontSize: 15, color: isSelected ? C.teal : C.white, fontWeight: isSelected ? '700' : '400' }}>{subj.label}</Text>
                {isSelected && <Text style={{ color: C.teal, fontSize: 16 }}>✓</Text>}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity onPress={() => setShowSubjectPicker(false)} style={{ marginHorizontal: 20, marginTop: 18, backgroundColor: C.teal, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: C.navy, fontWeight: '700' }}>Done</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showJoinDatePicker} transparent animationType="fade" onRequestClose={() => setShowJoinDatePicker(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 22, padding: 20, width: '100%', maxWidth: 360 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Text style={{ fontWeight: '700', fontSize: 16, color: C.white }}>Select Date of Joining</Text>
              <TouchableOpacity onPress={() => setShowJoinDatePicker(false)}>
                <Text style={{ color: C.muted, fontSize: 14 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <TouchableOpacity onPress={() => { let m = pickerMonth - 1; let y = pickerYear; if (m < 0) { m = 11; y -= 1; } setPickerMonth(m); setPickerYear(y); }} style={{ padding: 8 }}>
                <Text style={{ color: C.gold, fontSize: 18, fontWeight: '700' }}>‹</Text>
              </TouchableOpacity>
              <Text style={{ fontWeight: '700', fontSize: 15, color: C.white }}>{MONTH_NAMES[pickerMonth]} {pickerYear}</Text>
              <TouchableOpacity onPress={() => { let m = pickerMonth + 1; let y = pickerYear; if (m > 11) { m = 0; y += 1; } setPickerMonth(m); setPickerYear(y); }} style={{ padding: 8 }}>
                <Text style={{ color: C.gold, fontSize: 18, fontWeight: '700' }}>›</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', marginBottom: 6 }}>
              {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
                <View key={d} style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, color: C.muted, fontWeight: '600' }}>{d}</Text>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {buildCalendarDays(pickerYear, pickerMonth).map((day, idx) => {
                if (!day) return <View key={`b-${idx}`} style={{ width: '14.28%', aspectRatio: 1 }} />;
                const isoStr = `${pickerYear}-${String(pickerMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const isSelected = newJoinDate === isoStr;
                const isToday = isoStr === new Date().toISOString().split('T')[0];
                return (
                  <TouchableOpacity
                    key={isoStr}
                    onPress={() => { setNewJoinDate(isoStr); setShowJoinDatePicker(false); }}
                    style={{ width: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: isSelected ? C.teal : isToday ? C.gold + '33' : 'transparent', alignItems: 'center', justifyContent: 'center', borderWidth: isToday && !isSelected ? 1 : 0, borderColor: C.gold }}>
                      <Text style={{ fontSize: 13, fontWeight: isSelected || isToday ? '700' : '400', color: isSelected ? C.navy : isToday ? C.gold : C.white }}>{day}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity onPress={() => setShowJoinDatePicker(false)} style={{ marginTop: 16, backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: C.muted, fontWeight: '700' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!staffResult} transparent animationType="fade" onRequestClose={closeStaffPopup}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 22, padding: 24, width: '100%', maxWidth: 380, alignItems: 'center' }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.teal + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Text style={{ fontSize: 30 }}>{staffResult?.staff?.type === 'driver' ? '\uD83D\uDE8C' : '\uD83E\uDDF9'}</Text>
            </View>
            <Text style={{ fontWeight: '800', fontSize: 20, color: C.white, marginBottom: 6, textAlign: 'center' }}>
              {staffResult?.staff?.type === 'driver' ? 'Driver Added!' : 'Cleaner Added!'}
            </Text>
            <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center', marginBottom: 20 }}>
              {staffResult?.staff?.full_name || 'Staff member'} has been registered. {staffResult?.defaultPassword ? 'They can log in with the credentials below.' : 'Share the ID below so they can use it to sign up.'}
            </Text>
            <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', marginBottom: 6 }}>STAFF ID</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.navy, borderWidth: 1.5, borderColor: C.teal + '66', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18, marginBottom: 8, width: '100%' }}>
              <Text style={{ flex: 1, fontWeight: '800', fontSize: 20, color: C.teal, letterSpacing: 1, textAlign: 'center' }}>{staffResult?.staffId || ''}</Text>
            </View>
            {staffResult?.defaultPassword ? (
              <View style={{ width: '100%', marginBottom: 8 }}>
                <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', marginBottom: 6 }}>DEFAULT PASSWORD</Text>
                <View style={{ backgroundColor: C.navy, borderWidth: 1.5, borderColor: '#f59e0b66', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18 }}>
                  <Text style={{ fontWeight: '800', fontSize: 18, color: '#f59e0b', letterSpacing: 1, textAlign: 'center' }}>{staffResult.defaultPassword}</Text>
                </View>
              </View>
            ) : null}
            <TouchableOpacity onPress={handleCopyStaffId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: staffCopied ? '#22d38a' : C.teal, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, width: '100%', marginBottom: 16 }}>
              <Text style={{ fontWeight: '700', fontSize: 14, color: C.white }}>{staffCopied ? '\u2713 Copied!' : '\uD83D\uDCCB Copy ID'}</Text>
            </TouchableOpacity>
            {staffResult?.sheetSync ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 12, color: '#22d38a' }}>{'\u2705'} Synced to Google Sheets</Text>
              </View>
            ) : staffResult?.sheetSync === false ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 12, color: C.coral }}>{'\u26A0\uFE0F'} Sheet sync pending</Text>
              </View>
            ) : null}
            <TouchableOpacity onPress={closeStaffPopup} style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, width: '100%', alignItems: 'center' }}>
              <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!onboardResult} transparent animationType="fade" onRequestClose={closeOnboardPopup}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 22, padding: 24, width: '100%', maxWidth: 380, alignItems: 'center' }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#22d38a22', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="check" size={32} color="#22d38a" />
            </View>
            <Text style={{ fontWeight: '800', fontSize: 20, color: C.white, marginBottom: 6, textAlign: 'center' }}>Teacher Onboarded!</Text>
            <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center', marginBottom: 20 }}>
              {onboardResult?.fullName || 'Staff member'} has been registered. {onboardResult?.defaultPassword ? 'They can log in with the credentials below.' : 'Share the ID below so they can use it to sign up.'}
            </Text>
            <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', marginBottom: 6 }}>SYSTEM ID</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.navy, borderWidth: 1.5, borderColor: '#22d38a66', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18, marginBottom: 8, width: '100%' }}>
              <Text style={{ flex: 1, fontWeight: '800', fontSize: 20, color: '#22d38a', letterSpacing: 1, textAlign: 'center' }}>{onboardResult?.teacherId || ''}</Text>
            </View>
            {onboardResult?.defaultPassword ? (
              <View style={{ width: '100%', marginBottom: 8 }}>
                <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', marginBottom: 6 }}>DEFAULT PASSWORD</Text>
                <View style={{ backgroundColor: C.navy, borderWidth: 1.5, borderColor: '#f59e0b66', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18 }}>
                  <Text style={{ fontWeight: '800', fontSize: 18, color: '#f59e0b', letterSpacing: 1, textAlign: 'center' }}>{onboardResult.defaultPassword}</Text>
                </View>
              </View>
            ) : null}
            <TouchableOpacity onPress={handleCopyId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: copied ? '#22d38a' : C.teal, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, width: '100%', marginBottom: 16 }}>
              <Text style={{ fontWeight: '700', fontSize: 14, color: C.white }}>{copied ? '\u2713 Copied!' : '\uD83D\uDCCB Copy ID'}</Text>
            </TouchableOpacity>
            {onboardResult?.sheetSync ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 12, color: '#22d38a' }}>{'\u2705'} Synced to Google Sheets</Text>
              </View>
            ) : onboardResult?.sheetSync === false ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 12, color: C.coral }}>{'\u26A0\uFE0F'} Sheet sync pending</Text>
              </View>
            ) : null}
            <TouchableOpacity onPress={closeOnboardPopup} style={{ backgroundColor: C.navyMid, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, width: '100%', alignItems: 'center' }}>
              <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.navy },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, paddingHorizontal: 20, paddingBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 18, padding: 16 },
  secHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  secTitle: { fontSize: 15, fontWeight: '600', color: C.white },
  input: { width: '100%', padding: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.navyMid, borderWidth: 1.5, borderColor: C.border, color: C.white, fontSize: 14 },
  label: { fontSize: 12, fontWeight: '500', color: C.muted, marginBottom: 6 },
});
