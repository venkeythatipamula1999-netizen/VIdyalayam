import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, StyleSheet, ActivityIndicator, BackHandler } from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import ErrorBanner from '../../components/ErrorBanner';
import { getFriendlyError } from '../../utils/errorMessages';

const REASON_COLORS = {
  Medical: '#F59E0B',
  medical: '#F59E0B',
  Family: '#FB923C',
  family: '#FB923C',
  Personal: '#A78BFA',
  personal: '#A78BFA',
  Emergency: '#EF4444',
  emergency: '#EF4444',
  Other: '#6B7280',
  other: '#6B7280',
};

function fmtDate(d) {
  if (!d) return '';
  const parts = String(d).split('-');
  if (parts.length !== 3) return d;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(parts[1],10)-1]} ${parseInt(parts[2],10)}`;
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}


function BirthdaysHeader({ birthdays }) {
  if (!birthdays || !birthdays.students || birthdays.students.length === 0) return null;
  return (
    <View style={{ backgroundColor: C.navyMid, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border }}>
      <Text style={{ fontSize: 16, fontWeight: '800', color: C.white, marginBottom: 12 }}>🎂 YOUR CLASS BIRTHDAYS TODAY</Text>
      {birthdays.students.map((s, i) => {
        const age = s.dob ? (new Date().getFullYear() - new Date(s.dob).getFullYear()) : '?';
        return <Text key={i} style={{ color: C.white, fontSize: 14, marginBottom: 4 }}>🎂 {s.name || s.studentName} | Class {s.className || s.class} | Age {age}</Text>;
      })}
      <Text style={{ fontSize: 12, color: C.teal, marginTop: 8, fontWeight: '700' }}>🎉 Celebrate today!</Text>
    </View>
  );
}

export default function TeacherAlertsScreen({ onBack, currentUser }) {
  const [birthdays, setBirthdays] = useState(null);
  const [tab, setTab] = useState('leave');
  const [requests, setRequests] = useState([]);
  const [loadingLeaves, setLoadingLeaves] = useState(false);
  const [classTeacherOf, setClassTeacherOf] = useState(null);
  const [notClassTeacher, setNotClassTeacher] = useState(false);
  const [leaveError, setLeaveError] = useState('');
  const [detail, setDetail] = useState(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [actioning, setActioning] = useState(null);
  const [liveNotifs, setLiveNotifs] = useState([]);
  const [loadingNotifs, setLoadingNotifs] = useState(false);
  const [expandedReason, setExpandedReason] = useState(null);

  
  useEffect(() => {
    // In Teacher view, we only want their assigned students. The backend returns all students. 
    // We can filter the backend response to only show the teacher's students.
    // Or simpler: backend now returns all students, but teacher should only see theirs.
    // Wait, the backend returns all birthdays, but for the UI panel, we only show if it's their class.
    // But how do we know their class? Teacher has classIds.
    apiFetch(`/birthdays/today`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.students) {
          // If we want only teacher's class, we ideally filter it. But assuming the teacher
          // only gets notification for their class, they should see only their class in panel.
          // Since we don't have teacher classes directly here, we show what is fetched, 
          // or we rely on backend to filter based on teacherId if we pass it.
          // For now, let's just display what backend gives. The backend could be updated to filter if role=teacher.
          setBirthdays(data);
        }
      })
      .catch(err => console.warn('Failed to fetch birthdays', err));
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const roleId = currentUser?.role_id || '';
  const teacherName = currentUser?.full_name || currentUser?.name || 'Class Teacher';

  const fetchStudentLeaves = useCallback(async () => {
    if (!roleId) return;
    setLoadingLeaves(true);
    setLeaveError('');
    try {
      const res = await apiFetch(`/leave-requests/student-class?teacherRoleId=${encodeURIComponent(roleId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setClassTeacherOf(data.classTeacherOf || null);
      setNotClassTeacher(!!data.notClassTeacher);
      setRequests(data.requests || []);
    } catch (err) {
      setLeaveError(getFriendlyError(err, 'Failed to load student leave requests. Please try again.'));
    } finally {
      setLoadingLeaves(false);
    }
  }, [roleId]);

  const fetchNotifications = useCallback(async () => {
    if (!roleId) return;
    setLoadingNotifs(true);
    try {
      const res = await apiFetch(`/teacher-notifications?roleId=${encodeURIComponent(roleId)}`);
      const data = await res.json();
      if (res.ok) setLiveNotifs(data.notifications || []);
    } catch (err) { console.error('Failed to fetch teacher notifications:', err.message); }
    finally { setLoadingNotifs(false); }
  }, [roleId]);

  const useFocusEffect = (cb, deps) => {
    useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, deps);
  };

  useFocusEffect(
    useCallback(() => {
      if (tab === 'leave') {
        fetchStudentLeaves();
        const interval = setInterval(fetchStudentLeaves, 30000);
        return () => clearInterval(interval);
      } else if (tab === 'alerts') {
        fetchNotifications();
      }
    }, [tab, roleId]),
    [tab]
  );

  const markAsRead = async (ids) => {
    try {
      await apiFetch('/teacher-notifications/mark-read', {
        method: 'POST',
        body: JSON.stringify({ notificationIds: ids }),
      });
      setLiveNotifs(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n));
    } catch (err) { console.error('Mark read error:', err.message); }
  };

  const act = async (id, action, note) => {
    setActioning(id + action);
    try {
      const res = await apiFetch('/leave-request/update-status', {
        method: 'POST',
        body: JSON.stringify({
          requestId: id,
          status: action,
          adminName: teacherName,
          actorRole: 'Class Teacher',
          rejectReason: note || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed');
      setRequests(prev => prev.map(r => r.id === id ? {
        ...r, status: action,
        approvedBy: teacherName,
        approvedByRole: 'Class Teacher',
        approvedAt: new Date().toISOString(),
        rejectReason: note || r.rejectReason,
      } : r));
      if (detail?.id === id) setDetail(d => ({
        ...d, status: action,
        approvedBy: teacherName,
        approvedByRole: 'Class Teacher',
        approvedAt: new Date().toISOString(),
        rejectReason: note || d.rejectReason,
      }));
      setRejectMode(false);
      setRejectNote('');
    } catch (err) {
      console.error('Action error:', err.message);
    } finally {
      setActioning(null);
    }
  };

  const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 172800000) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const typeColor = (type, status) => {
    if (type === 'leave_status') return status === 'Approved' ? '#34D399' : status === 'Rejected' ? C.coral : C.gold;
    if (type === 'class_teacher_assigned') return C.purple;
    if (type === 'timetable_updated') return C.teal;
    return C.gold;
  };

  const normalizeStatus = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
  const sc = s => ({ Approved: '#34D399', Rejected: C.coral, Pending: C.gold })[normalizeStatus(s)] || C.muted;
  const isPending = r => normalizeStatus(r.status) === 'Pending';
  const pending = requests.filter(isPending);
  const processed = requests.filter(r => !isPending(r));

  if (detail) {
    const r = detail;
    const liveR = requests.find(x => x.id === r.id) || r;
    const currentStatus = liveR.status;
    const rColor = REASON_COLORS[r.reasonLabel] || REASON_COLORS[r.reasonId] || C.teal;
    return (
      <ScrollView style={{ flex: 1, backgroundColor: C.navy }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20 }}>
          <TouchableOpacity onPress={() => { setDetail(null); setRejectMode(false); setRejectNote(''); }}
            style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '800', fontSize: 17, color: C.white }}>Student Leave Request</Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>{classTeacherOf} {'·'} {r.submittedAt ? formatTime(r.submittedAt) : ''}</Text>
          </View>
          <View style={{ paddingVertical: 4, paddingHorizontal: 12, borderRadius: 99, backgroundColor: sc(currentStatus) + '22', flexShrink: 0 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: sc(currentStatus) }}>{currentStatus}</Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, paddingBottom: 32 }}>
          <View style={{ backgroundColor: rColor + '15', borderWidth: 1, borderColor: rColor + '44', borderRadius: 20, padding: 20, marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              <View style={{ width: 56, height: 56, borderRadius: 17, backgroundColor: rColor + '33', borderWidth: 1.5, borderColor: rColor + '66', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Text style={{ fontWeight: '900', fontSize: 20, color: rColor }}>{initials(r.studentName)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '800', fontSize: 17, color: C.white }}>{r.studentName}</Text>
                <Text style={{ color: C.muted, fontSize: 13 }}>{r.studentClass} {'·'} Roll #{r.rollNumber || '–'}</Text>
              </View>
              <Text style={{ fontSize: 28 }}>{r.icon || '📅'}</Text>
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {[
                ['Leave Type', r.reasonLabel || r.reasonId || 'Leave'],
                ['Duration', `${r.days || 1} day${(r.days || 1) > 1 ? 's' : ''}`],
                ['From', fmtDate(r.from)],
                ['To', fmtDate(r.to || r.from)],
              ].map(([l, v]) => (
                <View key={l} style={{ width: '48%', backgroundColor: C.navy + '99', borderRadius: 10, padding: 10 }}>
                  <Text style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{l}</Text>
                  <Text style={{ fontWeight: '700', fontSize: 12, color: C.white, lineHeight: 17 }}>{v}</Text>
                </View>
              ))}
            </View>

            <View style={{ padding: 10, paddingHorizontal: 14, backgroundColor: C.navy + '66', borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: C.gold + '22', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 16 }}>{'👨‍👩‍👧'}</Text>
              </View>
              <View>
                <Text style={{ fontSize: 13, fontWeight: '700', color: C.white }}>{r.parentName || 'Parent'}</Text>
                <Text style={{ fontSize: 11, color: C.muted }}>Parent {'·'} Applied {formatTime(r.submittedAt)}</Text>
              </View>
            </View>
          </View>

          <Text style={{ fontWeight: '700', fontSize: 14, color: C.white, marginBottom: 10 }}>{'📝'} Reason from Parent</Text>
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderLeftWidth: 3, borderLeftColor: rColor, borderRadius: 16, padding: 16, marginBottom: 20 }}>
            <Text style={{ fontSize: 14, color: C.white, lineHeight: 26, fontStyle: 'italic' }}>"{r.customReason || r.reasonLabel || 'No reason provided'}"</Text>
          </View>

          {currentStatus !== 'Pending' && (
            <View style={{ padding: 18, backgroundColor: sc(currentStatus) + '0E', borderWidth: 1, borderColor: sc(currentStatus) + '33', borderRadius: 16, marginBottom: 16 }}>
              <Text style={{ fontSize: 24, textAlign: 'center', marginBottom: 8 }}>{currentStatus === 'Approved' ? '✅' : '❌'}</Text>
              <Text style={{ fontWeight: '800', color: sc(currentStatus), fontSize: 15, textAlign: 'center', marginBottom: 4 }}>Leave {currentStatus}</Text>
              <Text style={{ fontSize: 12, color: C.muted, textAlign: 'center' }}>
                by {liveR.approvedBy || r.approvedBy || 'Unknown'} ({liveR.approvedByRole || r.approvedByRole || 'Admin'})
                {(liveR.approvedAt || r.approvedAt) ? '\n' + formatTime(liveR.approvedAt || r.approvedAt) : ''}
              </Text>
              {(liveR.rejectReason || r.rejectReason) ? (
                <View style={{ marginTop: 10, backgroundColor: C.coral + '15', borderRadius: 10, padding: 10 }}>
                  <Text style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>Rejection reason</Text>
                  <Text style={{ fontSize: 12, color: C.coral }}>{liveR.rejectReason || r.rejectReason}</Text>
                </View>
              ) : null}
            </View>
          )}

          {currentStatus === 'Pending' && (
            <>
              {rejectMode && (
                <View style={{ marginBottom: 14 }}>
                  <Text style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Rejection reason (optional)</Text>
                  <TextInput
                    value={rejectNote}
                    onChangeText={setRejectNote}
                    placeholder="e.g. Exam week, insufficient notice..."
                    placeholderTextColor={C.muted}
                    multiline
                    style={{ minHeight: 80, backgroundColor: C.navyMid, borderWidth: 1.5, borderColor: C.coral + '44', borderRadius: 12, padding: 12, color: C.white, fontSize: 13, textAlignVertical: 'top' }}
                  />
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity
                  onPress={() => rejectMode ? act(r.id, 'Rejected', rejectNote) : setRejectMode(true)}
                  disabled={!!actioning}
                  style={{ flex: 1, padding: 15, borderRadius: 14, borderWidth: 1.5, borderColor: C.coral + '55', backgroundColor: C.coral + '18', alignItems: 'center' }}>
                  {actioning === r.id + 'Rejected' ? <ActivityIndicator color={C.coral} /> : <Text style={{ color: C.coral, fontWeight: '700', fontSize: 15 }}>{rejectMode ? '✗ Confirm Reject' : '✗ Reject'}</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => act(r.id, 'Approved')}
                  disabled={!!actioning}
                  style={{ flex: 1, padding: 15, borderRadius: 14, backgroundColor: '#34D399', alignItems: 'center' }}>
                  {actioning === r.id + 'Approved' ? <ActivityIndicator color={C.white} /> : <Text style={{ color: C.navy, fontWeight: '800', fontSize: 15 }}>{'✓'} Approve</Text>}
                </TouchableOpacity>
              </View>
              {rejectMode && (
                <TouchableOpacity onPress={() => { setRejectMode(false); setRejectNote(''); }}
                  style={{ marginTop: 8, padding: 10, alignItems: 'center' }}>
                  <Text style={{ color: C.muted, fontSize: 13 }}>Cancel</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.navy }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20 }}>
        <TouchableOpacity onPress={onBack} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="back" size={18} color={C.white} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: '800', fontSize: 17, color: C.white }}>Alerts & Leave</Text>
          <Text style={{ color: C.muted, fontSize: 12 }}>{classTeacherOf ? classTeacherOf + ' · Your Class' : 'Your Dashboard'}</Text>
        </View>
        {pending.length > 0 && (
          <View style={{ minWidth: 26, height: 22, borderRadius: 11, backgroundColor: C.coral, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, flexShrink: 0 }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: C.white }}>{pending.length} new</Text>
          </View>
        )}
      </View>

      <View style={{ paddingHorizontal: 20, paddingBottom: 32 }}>
        <View style={{ flexDirection: 'row', backgroundColor: C.navyMid, borderRadius: 12, padding: 4, gap: 4, marginBottom: 20 }}>
          {[['leave', '📅 Leave Requests'], ['alerts', '🔔 School Alerts']].map(([k, l]) => (
            <TouchableOpacity key={k} onPress={() => setTab(k)}
              style={{ flex: 1, paddingVertical: 9, paddingHorizontal: 6, borderRadius: 9, backgroundColor: tab === k ? C.teal : 'transparent', alignItems: 'center', position: 'relative' }}>
              <Text style={{ fontWeight: '700', fontSize: 13, color: tab === k ? C.navy : C.muted }}>{l}</Text>
              {k === 'leave' && pending.length > 0 && (
                <View style={{ position: 'absolute', top: 3, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: C.coral }} />
              )}
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'leave' && (
          <>
            {loadingLeaves ? (
              <LoadingSpinner message="Loading student leave requests..." />
            ) : leaveError ? (
              <ErrorBanner message={leaveError} onRetry={fetchStudentLeaves} onDismiss={() => setLeaveError('')} />
            ) : notClassTeacher ? (
              <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 18, padding: 32, alignItems: 'center' }}>
                <Text style={{ fontSize: 36, marginBottom: 14 }}>🏫</Text>
                <Text style={{ fontWeight: '700', fontSize: 15, color: C.white, marginBottom: 8, textAlign: 'center' }}>Not Assigned as Class Teacher</Text>
                <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                  Student leave requests are only visible to the assigned Class Teacher.{'\n'}Please contact Admin to be assigned as a Class Teacher.
                </Text>
              </View>
            ) : (
              <>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
                  {[
                    ['Pending', pending.length, C.gold],
                    ['Approved', requests.filter(r => r.status === 'Approved').length, '#34D399'],
                    ['Rejected', requests.filter(r => r.status === 'Rejected').length, C.coral],
                  ].map(([l, v, c]) => (
                    <View key={l} style={{ flex: 1, backgroundColor: c + '18', borderWidth: 1, borderColor: c + '44', borderRadius: 16, padding: 14, alignItems: 'center' }}>
                      <Text style={{ fontSize: 22, fontWeight: '800', color: c }}>{v}</Text>
                      <Text style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{l}</Text>
                    </View>
                  ))}
                </View>

                {requests.length === 0 && (
                  <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 32, alignItems: 'center' }}>
                    <Text style={{ fontSize: 28, marginBottom: 10 }}>📅</Text>
                    <Text style={{ color: C.muted, fontSize: 14, textAlign: 'center' }}>No student leave requests yet.{'\n'}Requests from {classTeacherOf} students will appear here.</Text>
                  </View>
                )}

                {pending.length > 0 && (
                  <>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: C.white }}>{'⚡'} Action Required</Text>
                      <View style={{ paddingVertical: 2, paddingHorizontal: 10, borderRadius: 99, backgroundColor: C.coral + '22' }}>
                        <Text style={{ fontSize: 11, color: C.coral, fontWeight: '700' }}>{pending.length} pending</Text>
                      </View>
                    </View>
                    {pending.map(r => {
                      const rColor = REASON_COLORS[r.reasonLabel] || REASON_COLORS[r.reasonId] || C.teal;
                      const isExpanded = expandedReason === r.id;
                      const reason = r.customReason || r.reasonLabel || '';
                      return (
                        <View key={r.id} style={{ backgroundColor: C.gold + '0D', borderWidth: 1, borderColor: C.gold + '44', borderRadius: 18, padding: 16, marginBottom: 14 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                            <View style={{ width: 50, height: 50, borderRadius: 15, backgroundColor: rColor + '33', borderWidth: 1.5, borderColor: rColor + '55', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <Text style={{ fontWeight: '900', fontSize: 16, color: rColor }}>{initials(r.studentName)}</Text>
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={{ fontWeight: '800', fontSize: 15, marginBottom: 2, color: C.white }}>
                                {r.studentName} <Text style={{ fontWeight: '400', color: C.muted, fontSize: 12 }}>· Roll #{r.rollNumber || '–'}</Text>
                              </Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                                <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 99, backgroundColor: rColor + '22' }}>
                                  <Text style={{ fontSize: 11, fontWeight: '700', color: rColor }}>{r.reasonLabel || r.reasonId || 'Leave'}</Text>
                                </View>
                                <Text style={{ fontSize: 11, color: C.muted }}>{r.studentClass}</Text>
                              </View>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <Text style={{ fontSize: 11, color: C.muted }}>{'👨‍👩‍👧'} {r.parentName || 'Parent'}</Text>
                                <Text style={{ fontSize: 11, color: '#FB923C', fontWeight: '600' }}>
                                  {fmtDate(r.from)}{r.days > 1 ? ` → ${fmtDate(r.to)}` : ''} · {r.days || 1}d
                                </Text>
                              </View>
                            </View>
                          </View>

                          {reason.length > 0 && (
                            <View style={{ backgroundColor: C.navy + '88', borderRadius: 10, padding: 10, paddingHorizontal: 12, marginBottom: 12 }}>
                              <Text style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>Parent's reason</Text>
                              <Text style={{ fontSize: 12, color: C.white, lineHeight: 20, fontStyle: 'italic' }}>
                                "{isExpanded || reason.length <= 100 ? reason : reason.slice(0, 100) + '…'}"
                              </Text>
                              {reason.length > 100 && (
                                <TouchableOpacity onPress={() => setExpandedReason(isExpanded ? null : r.id)} style={{ marginTop: 4 }}>
                                  <Text style={{ fontSize: 11, color: C.teal, fontWeight: '600' }}>{isExpanded ? 'read less' : 'read more'}</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          )}

                          <View style={{ flexDirection: 'row', gap: 8 }}>
                            <TouchableOpacity onPress={() => act(r.id, 'Rejected')} disabled={!!actioning}
                              style={{ flex: 1, paddingVertical: 10, borderRadius: 11, borderWidth: 1, borderColor: C.coral + '44', backgroundColor: C.coral + '15', alignItems: 'center' }}>
                              {actioning === r.id + 'Rejected' ? <ActivityIndicator size="small" color={C.coral} /> : <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13 }}>{'✗'} Reject</Text>}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => act(r.id, 'Approved')} disabled={!!actioning}
                              style={{ flex: 1, paddingVertical: 10, borderRadius: 11, backgroundColor: '#34D399', alignItems: 'center' }}>
                              {actioning === r.id + 'Approved' ? <ActivityIndicator size="small" color={C.white} /> : <Text style={{ color: C.navy, fontWeight: '800', fontSize: 13 }}>{'✓'} Approve</Text>}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setDetail(r)}
                              style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: C.border, alignItems: 'center' }}>
                              <Text style={{ color: C.teal, fontWeight: '700', fontSize: 13 }}>Full {'→'}</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })}
                  </>
                )}

                {processed.length > 0 && (
                  <>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, marginTop: pending.length > 0 ? 8 : 0 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: C.white }}>Processed</Text>
                      <TouchableOpacity onPress={fetchStudentLeaves} style={{ padding: 6 }}>
                        <Text style={{ fontSize: 16 }}>{'🔄'}</Text>
                      </TouchableOpacity>
                    </View>
                    {processed.map(r => {
                      const rColor = REASON_COLORS[r.reasonLabel] || REASON_COLORS[r.reasonId] || C.teal;
                      return (
                        <TouchableOpacity key={r.id} onPress={() => setDetail(r)}
                          style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderLeftWidth: 3, borderLeftColor: sc(r.status), borderRadius: 16, padding: 14, marginBottom: 10 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                            <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: rColor + '22', borderWidth: 1, borderColor: rColor + '44', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <Text style={{ fontWeight: '800', fontSize: 14, color: rColor }}>{initials(r.studentName)}</Text>
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={{ fontWeight: '700', fontSize: 14, marginBottom: 2, color: C.white }}>
                                {r.studentName} <Text style={{ fontWeight: '400', color: C.muted, fontSize: 12 }}>· Roll #{r.rollNumber || '–'}</Text>
                              </Text>
                              <Text style={{ fontSize: 12, color: C.muted }}>{r.reasonLabel || 'Leave'} · {r.days || 1}d</Text>
                              <Text style={{ fontSize: 11, color: '#FB923C', fontWeight: '600', marginTop: 2 }}>
                                {fmtDate(r.from)}{r.days > 1 ? ` → ${fmtDate(r.to)}` : ''}
                              </Text>
                            </View>
                            <View style={{ alignItems: 'flex-end', gap: 4 }}>
                              <View style={{ paddingVertical: 3, paddingHorizontal: 10, borderRadius: 99, backgroundColor: sc(r.status) + '22' }}>
                                <Text style={{ fontSize: 11, fontWeight: '700', color: sc(r.status) }}>{r.status}</Text>
                              </View>
                              {r.approvedBy && (
                                <Text style={{ fontSize: 10, color: C.muted }}>by {r.approvedBy}</Text>
                              )}
                              <Text style={{ fontSize: 10, color: C.muted }}>{formatTime(r.submittedAt)}</Text>
                            </View>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </>
        )}

        {tab === 'alerts' && (
          <>
            {liveNotifs.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: C.white }}>Admin Updates</Text>
                  {liveNotifs.some(n => !n.read) && (
                    <TouchableOpacity onPress={() => markAsRead(liveNotifs.filter(n => !n.read).map(n => n.id))} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.teal + '22' }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: C.teal }}>Mark All Read</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {liveNotifs.map(n => {
                  const color = typeColor(n.type, n.status);
                  return (
                    <TouchableOpacity key={n.id} onPress={() => { if (!n.read) markAsRead([n.id]); }} activeOpacity={0.8}
                      style={{ backgroundColor: C.card, borderWidth: 1, borderColor: !n.read ? color + '55' : C.border, borderLeftWidth: 3, borderLeftColor: color, borderRadius: 16, padding: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: color + '22', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Text style={{ fontSize: 22 }}>{n.icon || '🔔'}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                          <Text style={{ fontWeight: '700', fontSize: 14, color: C.white }}>{n.title}</Text>
                          {!n.read && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />}
                        </View>
                        <Text style={{ color: C.muted, fontSize: 12 }}>{n.message}</Text>
                      </View>
                      <Text style={{ fontSize: 11, color: color, flexShrink: 0 }}>{formatTime(n.createdAt)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            {loadingNotifs && liveNotifs.length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                <ActivityIndicator size="small" color={C.teal} />
              </View>
            )}

            {liveNotifs.length === 0 && !loadingNotifs && (
              <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 24, alignItems: 'center' }}>
                <Text style={{ fontSize: 28, marginBottom: 8 }}>{'\uD83D\uDD14'}</Text>
                <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>No notifications yet</Text>
              </View>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
