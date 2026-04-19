import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Animated,
} from 'react-native';
import { C } from '../../theme/colors';
import { apiFetch } from '../../api/client';
import { db } from '../../config';
import {
  collection, query, where, orderBy, limit,
  onSnapshot, doc, updateDoc, writeBatch,
} from 'firebase/firestore';

function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)  return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)   return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7)    return `${diffD}d ago`;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

function typeInfo(type) {
  if (type === 'MARKS_SUBMITTED') return { icon: '📝', label: 'Marks Submitted', color: '#22d38a', bg: '#14532d' };
  if (type === 'MARKS_EDITED')    return { icon: '✏️', label: 'Marks Edited',    color: '#60a5fa', bg: '#1e3a5f' };
  if (type === 'ATTENDANCE')      return { icon: '📋', label: 'Attendance',      color: '#f59e0b', bg: '#78350f' };
  if (type === 'BUS_ALERT')       return { icon: '🚌', label: 'Bus Alert',       color: '#06b6d4', bg: '#164e63' };
  if (type === 'FEE_UPDATE')      return { icon: '💰', label: 'Fee Update',      color: '#a78bfa', bg: '#4c1d95' };
  return                                   { icon: '🔔', label: 'Notification',   color: C.gold,   bg: C.card   };
}

function NotifCard({ notif, onPress, isNew }) {
  const { icon, label, color, bg } = typeInfo(notif.type);
  const isUnread = !notif.read;
  const fadeAnim = useRef(new Animated.Value(isNew ? 0 : 1)).current;

  useEffect(() => {
    if (isNew) {
      Animated.spring(fadeAnim, {
        toValue: 1, useNativeDriver: true,
        tension: 80, friction: 8,
      }).start();
    }
  }, [isNew]);

  return (
    <Animated.View style={{ opacity: fadeAnim, transform: [{ scale: fadeAnim }] }}>
      <TouchableOpacity
        onPress={() => onPress(notif)}
        activeOpacity={0.75}
        style={[
          st.card,
          isUnread && st.cardUnread,
          { borderLeftColor: isUnread ? color : 'transparent' },
        ]}
      >
        <View style={[st.iconWrap, { backgroundColor: bg }]}>
          <Text style={st.iconText}>{icon}</Text>
        </View>

        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <View style={{ flex: 1 }}>
              <Text style={[st.typeLabel, { color }]}>{label}</Text>
              <Text style={st.teacher}>
                {notif.teacherName || 'Teacher'}{notif.className ? ` · Class ${notif.className}` : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={st.time}>{fmtTime(notif.createdAt || notif.timestamp)}</Text>
              {isUnread && <View style={st.unreadDot} />}
            </View>
          </View>

          {notif.subjectName ? (
            <Text style={st.detail}>
              {notif.subjectName}
              {notif.examType ? ` · ${notif.examType}` : ''}
              {notif.studentCount > 1 ? ` · ${notif.studentCount} students` : ''}
            </Text>
          ) : null}

          {notif.type === 'MARKS_EDITED' && (
            <View style={{ marginTop: 6 }}>
              {notif.studentName ? (
                <Text style={st.detail}>Student: {notif.studentName}</Text>
              ) : null}
              {notif.previousMarks !== undefined && notif.updatedMarks !== undefined ? (
                <View style={st.marksChange}>
                  <Text style={[st.detail, { color: '#ef4444', fontWeight: '700' }]}>
                    {notif.previousMarks}
                  </Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}> → </Text>
                  <Text style={[st.detail, { color: '#22d38a', fontWeight: '700' }]}>
                    {notif.updatedMarks} marks
                  </Text>
                </View>
              ) : null}
              {notif.reason ? (
                <View style={st.reasonBox}>
                  <Text style={st.reasonLabel}>Reason:</Text>
                  <Text style={st.reasonText}>"{notif.reason}"</Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}


function BirthdaysHeader({ birthdays }) {
  if (!birthdays) return null;
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <View style={{ backgroundColor: C.navyMid, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border }}>
      <Text style={{ fontSize: 16, fontWeight: '800', color: C.white, marginBottom: 12 }}>🎂 TODAY'S BIRTHDAYS — {dateStr}</Text>
      <View style={{ height: 1, backgroundColor: C.border, marginBottom: 12 }} />
      
      {birthdays.students && birthdays.students.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.teal, marginBottom: 8, textTransform: 'uppercase' }}>👨‍🎓 STUDENTS</Text>
          {birthdays.students.map((s, i) => {
            const age = s.dob ? (new Date().getFullYear() - new Date(s.dob).getFullYear()) : '?';
            return <Text key={i} style={{ color: C.white, fontSize: 14, marginBottom: 4 }}>🎂 {s.name || s.studentName} | Class {s.className || s.class} | Age {age}</Text>;
          })}
        </View>
      )}

      {birthdays.staff && birthdays.staff.length > 0 && (
        <View>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.gold, marginBottom: 8, textTransform: 'uppercase' }}>👤 STAFF</Text>
          {birthdays.staff.map((s, i) => (
            <Text key={i} style={{ color: C.white, fontSize: 14, marginBottom: 4 }}>🎂 {s.name} | {s.role || 'Staff'}</Text>
          ))}
        </View>
      )}
      <View style={{ height: 1, backgroundColor: C.border, marginTop: 8 }} />
    </View>
  );
}

export default function AdminNotificationsScreen({ onBack, schoolId }) {
  const [birthdays, setBirthdays]   = useState(null);
  const [notifs, setNotifs]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const [newIds, setNewIds]         = useState(new Set());
  const isFirstLoad                 = useRef(true);

  const unreadCount = notifs.filter(n => !n.read).length;

  // ── Real-time Firestore listener ───────────────────────────────
  
  useEffect(() => {
    apiFetch(`/birthdays/today?schoolId=${schoolId}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && (data.students?.length > 0 || data.staff?.length > 0)) {
          setBirthdays(data);
        }
      })
      .catch(err => console.warn('Failed to fetch birthdays', err));
  }, [schoolId]);

  useEffect(() => {
    if (!db || !schoolId) {
      // Fallback to polling if no schoolId or Firestore not available
      fetchFallback();
      return;
    }

    const notifRef = collection(db, 'schools', schoolId, 'notifications');
    const q = query(notifRef, orderBy('createdAt', 'desc'), limit(60));

    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        _source: 'firestore',
      }));

      // Detect truly new docs (not first load)
      if (!isFirstLoad.current) {
        const addedIds = new Set();
        snap.docChanges().forEach(change => {
          if (change.type === 'added') addedIds.add(change.doc.id);
        });
        if (addedIds.size > 0) {
          setNewIds(prev => new Set([...prev, ...addedIds]));
          // Clear "new" flag after animation
          setTimeout(() => {
            setNewIds(prev => {
              const next = new Set(prev);
              addedIds.forEach(id => next.delete(id));
              return next;
            });
          }, 2000);
        }
      }
      isFirstLoad.current = false;
      setNotifs(docs);
      setLoading(false);
    }, (err) => {
      console.warn('[AdminNotif] Firestore listener error:', err.message);
      fetchFallback();
    });

    return () => unsub();
  }, [schoolId]);

  const fetchFallback = useCallback(async () => {
    setLoading(true);
    try {
      const [res1, res2] = await Promise.all([
        apiFetch('/school-notifications'),
        apiFetch('/admin/notifications').catch(() => ({ json: () => ({ notifications: [] }) })),
      ]);
      const data1 = await res1.json();
      const data2 = await res2.json();
      const schoolNotifs = (data1.notifications || []).map(n => ({ ...n, _source: 'school' }));
      const adminNotifs = (data2.notifications || []).map(n => ({
        ...n, _source: 'admin',
        type: n.type || 'ATTENDANCE',
        teacherName: n.teacherName || n.markedBy || '',
        className: n.className || '',
      }));
      const merged = [...schoolNotifs, ...adminNotifs].sort((a, b) => {
        const ta = a.createdAt || a.timestamp || '';
        const tb = b.createdAt || b.timestamp || '';
        return new Date(tb) - new Date(ta);
      });
      setNotifs(merged);
    } catch (e) {
      console.warn('AdminNotificationsScreen fetch error', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Mark a single notification as read ────────────────────────
  const markRead = async (notif) => {
    if (notif.read) return;
    setNotifs(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));

    if (notif._source === 'firestore' && db && schoolId) {
      try {
        await updateDoc(
          doc(db, 'schools', schoolId, 'notifications', notif.id),
          { read: true }
        );
      } catch (_) {}
    } else {
      const endpoint = notif._source === 'admin'
        ? '/admin/notifications/mark-read'
        : '/school-notifications/mark-read';
      apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ ids: [notif.id] }),
      }).catch(() => {});
    }
  };

  // ── Mark all as read ──────────────────────────────────────────
  const markAllRead = async () => {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    try {
      const unread = notifs.filter(n => !n.read);

      if (db && schoolId) {
        // Batch update Firestore
        const batch = writeBatch(db);
        unread
          .filter(n => n._source === 'firestore')
          .forEach(n => {
            batch.update(doc(db, 'schools', schoolId, 'notifications', n.id), { read: true });
          });
        await batch.commit();
      }

      // Also hit legacy endpoints
      await Promise.allSettled([
        apiFetch('/school-notifications/mark-read', { method: 'POST', body: JSON.stringify({ ids: [] }) }),
        apiFetch('/admin/notifications/mark-read', { method: 'POST', body: JSON.stringify({ ids: [] }) }),
      ]);

      setNotifs(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {
      console.warn('Mark all read error', e.message);
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <View style={st.container}>
      <View style={st.header}>
        <TouchableOpacity onPress={onBack} style={st.backBtn}>
          <Text style={{ color: C.white, fontSize: 18 }}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={st.title}>Notifications</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            {/* Live indicator dot */}
            <View style={st.liveDot} />
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {unreadCount > 0 ? `${unreadCount} unread · ` : ''}Live
            </Text>
          </View>
        </View>
        {unreadCount > 0 && (
          <TouchableOpacity onPress={markAllRead} disabled={markingAll} style={st.markAllBtn}>
            {markingAll
              ? <ActivityIndicator size="small" color={C.teal} />
              : <Text style={st.markAllText}>Mark all read</Text>
            }
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={C.teal} />
          <Text style={{ color: C.muted, marginTop: 12 }}>Loading notifications...</Text>
        </View>
      ) : notifs.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <Text style={{ fontSize: 48 }}>📭</Text>
          <Text style={{ color: C.white, fontWeight: '700', fontSize: 16 }}>No notifications yet</Text>
          <Text style={{ color: C.muted, fontSize: 13 }}>Mark submissions will appear here</Text>
        </View>
      ) : (
        <FlatList
          data={notifs}
          keyExtractor={n => n.id}
          renderItem={({ item }) => (
            <NotifCard
              notif={item}
              onPress={markRead}
              isNew={newIds.has(item.id)}
            />
          )}
          ListHeaderComponent={<BirthdaysHeader birthdays={birthdays} />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container:   { flex: 1, backgroundColor: C.navy },
  header:      { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, paddingTop: 50, backgroundColor: C.navyMid, borderBottomWidth: 1, borderColor: C.border },
  backBtn:     { width: 36, height: 36, borderRadius: 10, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' },
  title:       { fontSize: 18, fontWeight: '800', color: C.white },
  markAllBtn:  { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.teal + '66', minWidth: 90, alignItems: 'center' },
  markAllText: { color: C.teal, fontSize: 12, fontWeight: '700' },
  liveDot:     { width: 7, height: 7, borderRadius: 4, backgroundColor: '#22d38a' },
  card:        { flexDirection: 'row', gap: 12, backgroundColor: C.navyMid, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.border, borderLeftWidth: 4 },
  cardUnread:  { backgroundColor: '#0f2348' },
  iconWrap:    { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  iconText:    { fontSize: 20 },
  typeLabel:   { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  teacher:     { fontSize: 14, color: C.white, fontWeight: '600', marginTop: 2 },
  time:        { fontSize: 11, color: C.muted },
  unreadDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: C.teal },
  detail:      { fontSize: 12, color: C.muted, marginTop: 2 },
  marksChange: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  reasonBox:   { backgroundColor: '#162E50', borderRadius: 8, padding: 8, marginTop: 6, borderLeftWidth: 3, borderLeftColor: '#60a5fa' },
  reasonLabel: { fontSize: 10, fontWeight: '800', color: '#60a5fa', textTransform: 'uppercase', marginBottom: 2, letterSpacing: 0.5 },
  reasonText:  { fontSize: 12, color: '#93c5fd', fontStyle: 'italic' },
});
