import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Toast from '../../components/Toast';
import { getFriendlyError } from '../../utils/errorMessages';
import SideDrawer from '../../components/SideDrawer';
import Svg, { Circle, Polyline } from 'react-native-svg';
import DonutRing from '../../components/DonutRing';

const CLASS_COLORS = [C.teal, C.gold, C.purple, C.coral, '#60A5FA', '#F472B6', '#34D399', '#FB923C'];

function parseTimeMins(t) {
  if (!t) return null;
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function getTodayDay() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function getNowMins() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function getMonthYearParts(date = new Date()) {
  return {
    month: String(date.getMonth() + 1).padStart(2, '0'),
    year: String(date.getFullYear()),
  };
}

function getEventStartTime(ev) {
  return ev?.startTime || ev?.time || '';
}

function getEventType(ev) {
  const raw = String(ev?.type || ev?.category || '').trim().toLowerCase();
  if (raw.includes('holiday')) return 'holiday';
  if (raw.includes('meeting') || raw.includes('cultural')) return 'meeting';
  return 'meeting';
}

function getEventIcon(type) {
  if (type === 'holiday') return '🔴';
  if (type === 'meeting') return '👥';
  return '📚';
}

function getEventTitle(ev) {
  return ev?.title || ev?.name || ev?.subject || 'School Event';
}

function buildTodayScheduleItems(timetable, calendarEvents, todayDay, todayKey) {
  const holidayEvent = calendarEvents.find((ev) => ev.date === todayKey && getEventType(ev) === 'holiday');
  if (holidayEvent) {
    return [{
      id: `holiday-${holidayEvent.id || holidayEvent.date}`,
      kind: 'holiday',
      icon: '🔴',
      time: 'Full Day',
      className: 'Holiday',
      subject: getEventTitle(holidayEvent),
      sortKey: -1,
    }];
  }

  const classItems = timetable
    .filter((entry) => (entry.days || []).includes(todayDay))
    .map((entry, index) => ({
      id: `class-${entry.id || index}-${entry.className}-${entry.subject}`,
      kind: 'class',
      icon: '📚',
      time: formatTimeRange(entry.startTime, entry.endTime),
      className: `Grade ${entry.className}`,
      subject: entry.subject || 'Class',
      sortKey: parseTimeMins(entry.startTime) ?? (index + 1) * 1000,
    }));

  const eventItems = calendarEvents
    .filter((ev) => ev.date === todayKey && getEventType(ev) !== 'holiday')
    .map((ev, index) => {
      const eventType = getEventType(ev);
      const startTime = getEventStartTime(ev);
      return {
        id: `event-${ev.id || index}-${ev.date}-${eventType}`,
        kind: eventType,
        icon: getEventIcon(eventType),
        time: startTime || 'School Hours',
        className: 'Staff Event',
        subject: getEventTitle(ev),
        sortKey: parseTimeMins(startTime) ?? (2000 + index),
      };
    });

  return [...classItems, ...eventItems].sort((a, b) => a.sortKey - b.sortKey);
}

function getClassStatus(entry) {
  const start = parseTimeMins(entry.startTime);
  const end = parseTimeMins(entry.endTime);
  const now = getNowMins();
  if (start === null || end === null) return 'upcoming';
  if (now >= end) return 'completed';
  if (now >= start && now < end) return 'ongoing';
  return 'upcoming';
}

function formatTimeRange(startTime, endTime) {
  return `${startTime || '?'} – ${endTime || '?'}`;
}

function formatDays(days) {
  if (!days || days.length === 0) return '';
  return days.join(' · ');
}

function TodayClassesSheet({ onClose, onNavigate, todayClasses, classData, attendanceStats }) {
  const statusMeta = {
    completed: { label: 'Done', color: '#34D399', bg: '#34D39922' },
    ongoing: { label: 'Now \u26A1', color: C.gold, bg: C.gold + '22' },
    upcoming: { label: 'Upcoming', color: C.muted, bg: C.border },
  };

  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const statuses = todayClasses.map(e => getClassStatus(e));
  const doneCount = statuses.filter(s => s === 'completed').length;
  const nowCount = statuses.filter(s => s === 'ongoing').length;
  const upCount = statuses.filter(s => s === 'upcoming').length;
  const totalStudents = todayClasses.reduce((sum, e) => {
    const cd = classData[e.className];
    return sum + (cd ? cd.studentCount : 0);
  }, 0);

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.modalSheet}>
          <View style={{ alignItems: 'center', paddingTop: 14, paddingBottom: 6 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: C.border }} />
          </View>

          <ScrollView style={{ paddingHorizontal: 20 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.white }}>Today's Classes</Text>
              <TouchableOpacity onPress={onClose} style={{ backgroundColor: C.border, width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: C.white, fontSize: 16 }}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ color: C.muted, fontSize: 13, marginBottom: 20 }}>
              {todayLabel}{' · '}{todayClasses.length} {todayClasses.length === 1 ? 'period' : 'periods'} scheduled
            </Text>

            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
              {[
                { val: doneCount, lbl: 'Done', color: '#34D399' },
                { val: nowCount, lbl: 'In Progress', color: C.gold },
                { val: upCount, lbl: 'Upcoming', color: C.muted },
                { val: totalStudents, lbl: 'Students', color: C.teal },
              ].map(s => (
                <View key={s.lbl} style={{ flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 10, alignItems: 'center' }}>
                  <Text style={{ fontWeight: '800', fontSize: 18, color: s.color }}>{s.val}</Text>
                  <Text style={{ fontSize: 10, color: C.muted, marginTop: 2, lineHeight: 12 }}>{s.lbl}</Text>
                </View>
              ))}
            </View>

            {todayClasses.length === 0 && (
              <Text style={{ color: C.muted, textAlign: 'center', marginTop: 30 }}>No classes scheduled for today.</Text>
            )}

            {todayClasses.map((entry, i) => {
              const color = CLASS_COLORS[i % CLASS_COLORS.length];
              const status = getClassStatus(entry);
              const sm = statusMeta[status];
              const isOngoing = status === 'ongoing';
              const cd = classData[entry.className] || {};
              const att = cd.id ? (attendanceStats[cd.id] || null) : null;

              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => { onClose(); onNavigate('teacher-attendance'); }}
                  style={{
                    flexDirection: 'row', gap: 14, marginBottom: 14, padding: 16, borderRadius: 18,
                    backgroundColor: isOngoing ? color + '18' : C.card,
                    borderWidth: 1, borderColor: isOngoing ? color + '55' : C.border,
                  }}
                >
                  <View style={{ alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <View style={{
                      width: 36, height: 36, borderRadius: 12,
                      backgroundColor: color + '22', borderWidth: 1.5, borderColor: color + '55',
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color }}>P{i + 1}</Text>
                    </View>
                    {i < todayClasses.length - 1 && (
                      <View style={{ width: 2, height: 20, backgroundColor: color + '66', borderRadius: 2 }} />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <View>
                        <Text style={{ fontWeight: '700', fontSize: 15, color: C.white }}>Grade {entry.className}</Text>
                        <Text style={{ color: C.muted, fontSize: 12 }}>
                          {formatTimeRange(entry.startTime, entry.endTime)}
                          {entry.room ? ` · ${entry.room}` : ''}
                        </Text>
                      </View>
                      <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, backgroundColor: sm.bg, flexShrink: 0 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: sm.color }}>{sm.label}</Text>
                      </View>
                    </View>
                    <Text style={{ fontSize: 13, color: C.muted, fontWeight: '600', marginBottom: 6 }}>{entry.subject}</Text>
                    {att && att.submitted ? (
                      <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontSize: 12, color: C.muted }}>
                            <Text style={{ color: '#34D399', fontWeight: '600' }}>{att.present}</Text>
                            {'/'}{att.total}{' present'}
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 3 }}>
                            {Array.from({ length: Math.min(att.total, 12) }).map((_, pi) => (
                              <View key={pi} style={{ width: 6, height: 6, borderRadius: 2, backgroundColor: pi < Math.round(att.present / att.total * 12) ? '#34D399' : C.coral, opacity: 0.8 }} />
                            ))}
                          </View>
                        </View>
                        <View style={{ marginTop: 8, height: 5, backgroundColor: C.border, borderRadius: 99, overflow: 'hidden' }}>
                          <View style={{ width: (att.total > 0 ? att.present / att.total * 100 : 0) + '%', height: '100%', backgroundColor: color, borderRadius: 99 }} />
                        </View>
                      </View>
                    ) : (
                      <Text style={{ fontSize: 12, color: C.muted }}>
                        {cd.studentCount ? `${cd.studentCount} students` : 'Attendance not submitted'}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
            <View style={{ height: 20 }} />
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function normalizeGrade(s) {
  return (s || '').trim().replace(/^Grade\s+/i, '');
}


function formatMonthLabel(monthKey) {
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function getCurrentAcademicYear() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

function adaptCCEStudentSummaryToMarksData(summary) {
  const entries = Object.entries(summary.subjects || {});
  const faExam = {
    examType: 'FA1 + FA2 (Formative)',
    subjects: entries.map(([sub, d]) => ({ subject: sub, marks: d.faTotal || 0, maxMarks: 40 })),
    total: entries.reduce((s, [, d]) => s + (d.faTotal || 0), 0),
    maxTotal: entries.length * 40,
  };
  faExam.pct = faExam.maxTotal > 0 ? Math.round((faExam.total / faExam.maxTotal) * 100) : 0;
  faExam.avg = entries.length > 0 ? Math.round(faExam.total / entries.length) : 0;

  const saEntries = entries.filter(([, d]) => d.sa1 !== null);
  const saExam = {
    examType: 'SA1 (Summative)',
    subjects: saEntries.map(([sub, d]) => ({ subject: sub, marks: d.sa1 || 0, maxMarks: 80 })),
    total: saEntries.reduce((s, [, d]) => s + (d.sa1 || 0), 0),
    maxTotal: saEntries.length * 80,
  };
  saExam.pct = saExam.maxTotal > 0 ? Math.round((saExam.total / saExam.maxTotal) * 100) : 0;
  saExam.avg = saEntries.length > 0 ? Math.round(saExam.total / saEntries.length) : 0;

  const byExam = [faExam, ...(saEntries.length > 0 ? [saExam] : [])];
  const bySubject = entries.map(([sub, d]) => ({
    subject: sub,
    avg: d.halfYear !== null ? d.halfYear : (d.faWeight || 0),
    pct: Math.round((d.gradePoints || 0) * 10),
  }));

  const totalPoints = entries.reduce((s, [, d]) => s + (d.gradePoints || 0), 0);
  const overallPct = entries.length > 0 ? Math.round((totalPoints / (entries.length * 10)) * 100) : 0;

  return { success: true, byExam, bySubject, overallPct, total: byExam.reduce((s, e) => s + e.subjects.length, 0) };
}

const SUB_PALETTE = [C.gold, C.teal, C.purple, C.coral, '#34D399', '#60A5FA', '#F59E0B', '#EC4899'];
const subColor = (name, idx) => {
  const map = { maths: C.gold, math: C.gold, mathematics: C.gold, science: C.teal, english: C.purple, social: C.coral, 'social studies': C.coral, 'social science': C.coral, tamil: '#34D399', computer: '#60A5FA', 'computer science': '#60A5FA', hindi: '#F59E0B' };
  return map[(name || '').toLowerCase()] || SUB_PALETTE[idx % SUB_PALETTE.length];
};
const subShort = (name) => (name || '').slice(0, 4);

function getLinePoints(values) {
  if (!values.length) return '';
  if (values.length === 1) return `50,12`;
  const height = 42;
  const width = 100;
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const clamped = Math.max(0, Math.min(100, Number(value) || 0));
    const y = height - (clamped / 100) * 30 - 6;
    return `${x},${y}`;
  }).join(' ');
}

export function StudentProfileModal({ visible, onClose, student }) {
  const [tab, setTab] = React.useState('ATTENDANCE');
  const [attLoading, setAttLoading] = React.useState(true);
  const [attData, setAttData] = React.useState([]);
  const [marksLoading, setMarksLoading] = React.useState(true);
  const [marksData, setMarksData] = React.useState(null);

  React.useEffect(() => {
    if (!visible || !student) return;
    setAttLoading(true);
    setMarksLoading(true);
    setTab('ATTENDANCE');
    
    const d = new Date();
    const monthsToFetch = [];
    for (let i = 0; i < 4; i++) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      monthsToFetch.push(`${y}-${m}`);
      d.setMonth(d.getMonth() - 1);
    }
    Promise.all(monthsToFetch.map(m => apiFetch(`/attendance/student-monthly?studentId=${student.id || student.studentId}&month=${m}`).then(r => r.json()).catch(() => ({}))))
      .then(results => {
        const mapped = results.map((res, i) => {
          const cells = res.cells || [];
          const summary = res.summary || { present: 0, absent: 0, pct: 0, total: 0 };
          return { month: monthsToFetch[i], label: formatMonthLabel(monthsToFetch[i]), summary, cells };
        });
        setAttData(mapped);
      })
      .finally(() => setAttLoading(false));

    const acYear = getCurrentAcademicYear();
    apiFetch(`/cce/student-summary/${student.id || student.studentId}?academicYear=${acYear}&type=halfyear`)
      .then(r => r.json())
      .then(res => {
        if (res.success) setMarksData(adaptCCEStudentSummaryToMarksData(res));
        else setMarksData({ byExam: [], bySubject: [], overallPct: 0 });
      })
      .catch(() => setMarksData({ byExam: [], bySubject: [], overallPct: 0 }))
      .finally(() => setMarksLoading(false));
  }, [visible, student]);

  if (!visible || !student) return null;

  const currentMonth = attData[0];
  const prevMonths = attData.slice(1);

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalSheet, { height: '90%' }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <View>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.white }}>{student.name || student.studentName}</Text>
              <Text style={{ color: C.muted, fontSize: 13 }}>Grade {student.className || student.class} {'·'} Roll #{student.roll || student.rollNumber || '–'}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ backgroundColor: C.border, width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.white, fontSize: 16 }}>{'✕'}</Text>
            </TouchableOpacity>
          </View>
          
          <View style={{ flexDirection: 'row', paddingHorizontal: 20, marginTop: 16, marginBottom: 16 }}>
            <TouchableOpacity onPress={() => setTab('ATTENDANCE')} style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: tab === 'ATTENDANCE' ? C.teal : 'transparent' }}>
              <Text style={{ fontWeight: '700', color: tab === 'ATTENDANCE' ? C.teal : C.muted }}>Attendance</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setTab('MARKS')} style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: tab === 'MARKS' ? C.gold : 'transparent' }}>
              <Text style={{ fontWeight: '700', color: tab === 'MARKS' ? C.gold : C.muted }}>Marks / CCE</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>
            {tab === 'ATTENDANCE' && (
              attLoading ? <ActivityIndicator size="large" color={C.teal} style={{ marginTop: 40 }} /> :
              <View>
                {currentMonth && (
                  <View style={{ backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 10 }}>Current Month: {currentMonth.label}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                      <DonutRing pct={currentMonth.summary.pct} color={C.teal} size={80} stroke={8} label={`${currentMonth.summary.pct}%`} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>{currentMonth.summary.present} Present</Text>
                        <Text style={{ color: C.coral, fontWeight: '700', fontSize: 14 }}>{currentMonth.summary.absent} Absent</Text>
                        <Text style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Out of {currentMonth.summary.total} working days</Text>
                      </View>
                    </View>
                    
                    <Text style={{ fontSize: 13, fontWeight: '700', color: C.muted, marginBottom: 8, textTransform: 'uppercase' }}>Daily View</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {Array.from({ length: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() }, (_, i) => {
                         const day = i + 1;
                         const dateStr = `${currentMonth.month}-${String(day).padStart(2, '0')}`;
                         let status = '–';
                         let bg = C.navyMid;
                         let col = C.muted;
                         
                         const d = new Date(currentMonth.month + '-' + String(day).padStart(2, '0'));
                         if (d.getDay() === 0 || d.getDay() === 6) {
                            status = '–';
                         } else if (currentMonth.cells && Array.isArray(currentMonth.cells)) {
                            const c = currentMonth.cells.find(x => x.date === dateStr);
                            if (c) {
                               if (c.status === 'Present') { status = '✅'; bg = C.teal + '22'; col = C.teal; }
                               else if (c.status === 'Absent') { status = '❌'; bg = C.coral + '22'; col = C.coral; }
                            }
                         } else if (currentMonth.cells && typeof currentMonth.cells === 'object') {
                            const c = currentMonth.cells[dateStr];
                            if (c === 'Present') { status = '✅'; bg = C.teal + '22'; col = C.teal; }
                            else if (c === 'Absent') { status = '❌'; bg = C.coral + '22'; col = C.coral; }
                         }

                         return (
                           <View key={day} style={{ width: '13%', alignItems: 'center', paddingVertical: 6, backgroundColor: bg, borderRadius: 6, borderWidth: 1, borderColor: C.border }}>
                             <Text style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>{day}</Text>
                             <Text style={{ fontSize: 12, color: col }}>{status}</Text>
                           </View>
                         );
                      })}
                    </View>
                  </View>
                )}

                <Text style={{ fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 12 }}>Attendance Trend</Text>
                <View style={{ backgroundColor: C.navyMid, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border }}>
                  <Svg width="100%" height={62} viewBox="0 0 100 42">
                    <Polyline points="0,36 100,36" stroke={C.border} strokeWidth={1} fill="none" strokeDasharray="3 3" />
                    <Polyline points={getLinePoints(attData.slice().reverse().map(m => m.summary.pct))} stroke={C.teal} strokeWidth={3} fill="none" strokeLinecap="round" />
                  </Svg>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                    {attData.slice().reverse().map(m => (
                      <Text key={m.month} style={{ color: C.muted, fontSize: 10 }}>{m.label.slice(0, 3)}</Text>
                    ))}
                  </View>
                </View>

                <Text style={{ fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 12 }}>Previous Months</Text>
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 30 }}>
                  {prevMonths.map(m => (
                    <View key={m.month} style={{ flex: 1, backgroundColor: C.navyMid, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border }}>
                      <Text style={{ color: C.teal, fontWeight: '800', fontSize: 18 }}>{m.summary.pct}%</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{m.label.slice(0, 3)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {tab === 'MARKS' && (
              marksLoading ? <ActivityIndicator size="large" color={C.gold} style={{ marginTop: 40 }} /> :
              !marksData || marksData.total === 0 ? (
                <View style={{ alignItems: 'center', marginTop: 40 }}>
                  <Text style={{ fontSize: 40, marginBottom: 12 }}>📋</Text>
                  <Text style={{ color: C.muted, fontSize: 14 }}>No marks recorded yet.</Text>
                </View>
              ) : (
                <View>
                  <View style={{ backgroundColor: C.gold + '11', borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.gold + '44', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                    <DonutRing pct={marksData.overallPct} color={C.gold} size={80} stroke={8} label={`${marksData.overallPct}%`} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.muted, fontSize: 12 }}>Cumulative Average</Text>
                      <Text style={{ color: C.gold, fontWeight: '900', fontSize: 24 }}>{marksData.overallPct}%</Text>
                    </View>
                  </View>

                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 12 }}>Exam Progress</Text>
                  <View style={{ backgroundColor: C.navyMid, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.border }}>
                    <Svg width="100%" height={62} viewBox="0 0 100 42">
                      <Polyline points="0,36 100,36" stroke={C.border} strokeWidth={1} fill="none" strokeDasharray="3 3" />
                      <Polyline points={getLinePoints(marksData.byExam.map(e => e.pct))} stroke={C.gold} strokeWidth={3} fill="none" strokeLinecap="round" />
                    </Svg>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                      {marksData.byExam.map(e => (
                        <Text key={e.examType} style={{ color: C.muted, fontSize: 10 }}>{e.examType.split(' ')[0]}</Text>
                      ))}
                    </View>
                  </View>

                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.white, marginBottom: 12 }}>Subject Performance</Text>
                  <View style={{ backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 30, borderWidth: 1, borderColor: C.border }}>
                    {marksData.bySubject.map((s, i) => {
                      const col = subColor(s.subject, i);
                      return (
                        <View key={i} style={{ marginBottom: 12 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <Text style={{ fontSize: 13, fontWeight: '600', color: C.white }}>{s.subject}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: col }}>{s.pct}%</Text>
                          </View>
                          <View style={{ height: 6, backgroundColor: C.border, borderRadius: 3, overflow: 'hidden' }}>
                            <View style={{ width: `${s.pct}%`, height: '100%', backgroundColor: col }} />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DrillDownSheet({ visible, onClose, classData, attendanceStats, onStudentSelect }) {
  const [step, setStep] = React.useState(1);
  const [selectedClass, setSelectedClass] = React.useState(null);
  const [students, setStudents] = React.useState({ present: [], absent: [], loading: false });

  React.useEffect(() => {
    if (visible) setStep(1);
  }, [visible]);

  const grades = Object.keys(classData);

  const handleClassClick = async (grade) => {
    const classId = classData[grade]?.id;
    if (!classId) return;
    setStep(2);
    setSelectedClass(grade);
    setStudents({ present: [], absent: [], loading: true });
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [attRes, stdRes] = await Promise.all([
        apiFetch(`/attendance/records?classId=${classId}&date=${today}`),
        apiFetch(`/students/${classId}?t=` + Date.now())
      ]);
      const attData = await attRes.json();
      const stdData = await stdRes.json();
      
      const recordsMap = {};
      if (attData.records) {
        attData.records.forEach(r => { recordsMap[r.studentId] = r.status; });
      }
      
      const present = [];
      const absent = [];
      (stdData.students || []).forEach(s => {
        const stat = recordsMap[s.id] || 'Present';
        if (stat === 'Absent') absent.push(s);
        else present.push(s);
      });
      setStudents({ present, absent, loading: false });
    } catch (e) {
      setStudents({ present: [], absent: [], loading: false });
    }
  };

  if (!visible) return null;

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalSheet, { height: '85%' }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: C.border }}>
            {step === 2 ? (
              <TouchableOpacity onPress={() => setStep(1)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="back" size={16} color={C.white} />
                <Text style={{ fontSize: 18, fontWeight: '700', color: C.white }}>Grade {selectedClass}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.white }}>Assigned Classes</Text>
            )}
            <TouchableOpacity onPress={onClose} style={{ backgroundColor: C.border, width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.white, fontSize: 16 }}>{'✕'}</Text>
            </TouchableOpacity>
          </View>
          
          <ScrollView style={{ flex: 1, padding: 20 }}>
            {step === 1 && (
              grades.length === 0 ? <Text style={{ color: C.muted, textAlign: 'center', marginTop: 40 }}>No classes assigned.</Text> :
              grades.map((g, i) => {
                const id = classData[g]?.id;
                const att = id ? attendanceStats[id] : null;
                const total = classData[g]?.studentCount || 0;
                const present = att ? att.present : 0;
                const absent = att ? att.total - att.present : (total > 0 ? total : 0);
                return (
                  <TouchableOpacity key={i} onPress={() => handleClassClick(g)} style={{ backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: C.white }}>Grade {g}</Text>
                      <Text style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{total} students</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ color: '#34D399', fontWeight: '800', fontSize: 16 }}>{present}</Text>
                        <Text style={{ color: C.muted, fontSize: 10 }}>Present</Text>
                      </View>
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ color: C.coral, fontWeight: '800', fontSize: 16 }}>{absent}</Text>
                        <Text style={{ color: C.muted, fontSize: 10 }}>Absent</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}

            {step === 2 && (
              students.loading ? <ActivityIndicator size="large" color={C.teal} style={{ marginTop: 40 }} /> :
              <View>
                <Text style={{ fontSize: 14, fontWeight: '700', color: C.coral, marginBottom: 10, textTransform: 'uppercase' }}>Absent ({students.absent.length})</Text>
                {students.absent.map((s, i) => (
                  <TouchableOpacity key={i} onPress={() => onStudentSelect({ ...s, className: selectedClass })} style={{ backgroundColor: C.coral + '11', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.coral + '33', flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: C.coral + '33', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                      <Text style={{ color: C.coral, fontWeight: '700' }}>{(s.name || s.studentName || '?')[0]}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.white, fontWeight: '600', fontSize: 14 }}>{s.name || s.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11 }}>Roll #{s.roll || s.rollNumber || '-'}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                {students.absent.length === 0 && <Text style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>No absent students today.</Text>}

                <Text style={{ fontSize: 14, fontWeight: '700', color: '#34D399', marginTop: 16, marginBottom: 10, textTransform: 'uppercase' }}>Present ({students.present.length})</Text>
                {students.present.map((s, i) => (
                  <TouchableOpacity key={i} onPress={() => onStudentSelect({ ...s, className: selectedClass })} style={{ backgroundColor: '#34D39911', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#34D39933', flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#34D39933', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                      <Text style={{ color: '#34D399', fontWeight: '700' }}>{(s.name || s.studentName || '?')[0]}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.white, fontWeight: '600', fontSize: 14 }}>{s.name || s.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11 }}>Roll #{s.roll || s.rollNumber || '-'}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function TeacherDashboard({ onNavigate, currentUser, onLogout, currentScreen }) {
  console.log('[TeacherDashboard] mounting, user:', currentUser?.role_id || 'no-id');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showTodaySheet, setShowTodaySheet] = useState(false);
  const [drillDownVisible, setDrillDownVisible] = useState(false);
  const [selectedProfileStudent, setSelectedProfileStudent] = useState(null);
  const [onDuty, setOnDuty] = useState(false);
  const [dutyLoading, setDutyLoading] = useState(false);
  const [clockInTime, setClockInTime] = useState(null);
  const [currentStatus, setCurrentStatus] = useState('Off Duty');
  const [classData, setClassData] = useState({});
  const [attendanceStats, setAttendanceStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [freshTimetable, setFreshTimetable] = useState(null);
  const [todayScheduleLoading, setTodayScheduleLoading] = useState(true);
  const [todayScheduleError, setTodayScheduleError] = useState('');
  const [todayScheduleItems, setTodayScheduleItems] = useState([]);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });

  const displayName = currentUser?.full_name || 'Teacher';
  const teacherId = currentUser?.role_id || '';
  const showToast = (message, type = 'success') => setToast({ visible: true, message, type });

  const rawTimetable = freshTimetable !== null ? freshTimetable : currentUser?.timetable;
  const timetable = Array.isArray(rawTimetable) ? rawTimetable : [];
  const todayDay = getTodayDay();
  const todayKey = formatDateKey(new Date());
  const todayClasses = timetable
    .filter(e => (e.days || []).includes(todayDay))
    .sort((a, b) => (parseTimeMins(a.startTime) || 0) - (parseTimeMins(b.startTime) || 0));

  const allAssignedGrades = [...new Set(timetable.map(e => normalizeGrade(e.className)).filter(Boolean))];

  const currentClass = todayClasses.find(e => getClassStatus(e) === 'ongoing') || null;
  const nextClass = !currentClass
    ? todayClasses.filter(e => getClassStatus(e) === 'upcoming')[0] || null
    : null;
  const featuredClass = currentClass || nextClass;
  const featuredLabel = currentClass ? 'IN PROGRESS' : nextClass ? 'UPCOMING' : null;
  const featuredColor = currentClass ? C.purple : C.gold;

  useEffect(() => {
    async function loadData() {
      try {
        const fetches = [
          apiFetch('/classes?t=' + Date.now(), { cache: 'no-store' }).then(r => r.json()),
        ];
        if (teacherId) {
          fetches.push(
            apiFetch('/teacher/profile?roleId=' + encodeURIComponent(teacherId) + '&t=' + Date.now(), { cache: 'no-store' })
              .then(r => r.json())
          );
        }

        const [classesData, profileData] = await Promise.all(fetches);

        if (profileData && !profileData.error && Array.isArray(profileData.timetable)) {
          setFreshTimetable(profileData.timetable);
        }

        const classes = classesData.classes || classesData || [];
        const gradeMap = {};
        classes.forEach(cls => {
          const grade = normalizeGrade(cls.name || cls.grade || cls.className);
          if (grade) gradeMap[grade] = { id: cls.id, studentCount: cls.studentCount || 0 };
        });
        setClassData(gradeMap);

        const liveTimetable = profileData?.timetable || currentUser?.timetable || [];
        const liveGrades = [...new Set(liveTimetable.map(e => normalizeGrade(e.className)).filter(Boolean))];
        const uniqueIds = liveGrades.map(g => gradeMap[g]?.id).filter(Boolean);

        if (uniqueIds.length > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const statsRes = await apiFetch(`/attendance/class-stats?date=${today}&classIds=${uniqueIds.join(',')}`);
          const statsData = await statsRes.json();
          setAttendanceStats(statsData.stats || {});
        }
      } catch (e) {
        console.error('Dashboard load error:', getFriendlyError(e, 'Failed to load dashboard data'));
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [teacherId]);

  const loadTodaySchedule = useCallback(async () => {
    if (!teacherId) {
      setTodayScheduleItems([]);
      setTodayScheduleLoading(false);
      return;
    }

    setTodayScheduleLoading(true);
    setTodayScheduleError('');
    try {
      const { month, year } = getMonthYearParts(new Date());
      const [calendarRes, timetableRes] = await Promise.all([
        apiFetch(`/teacher-calendar?roleId=${encodeURIComponent(teacherId)}&month=${month}&year=${year}`),
        apiFetch(`/teacher-timetable?roleId=${encodeURIComponent(teacherId)}&t=${Date.now()}`, { cache: 'no-store' }),
      ]);
      const [calendarData, timetableData] = await Promise.all([
        calendarRes.json(),
        timetableRes.json(),
      ]);

      const liveTimetable = Array.isArray(timetableData?.timetable) && timetableData.timetable.length > 0
        ? timetableData.timetable
        : timetable;
      const calendarEvents = calendarRes.ok && Array.isArray(calendarData?.events) ? calendarData.events : [];

      setTodayScheduleItems(buildTodayScheduleItems(liveTimetable, calendarEvents, todayDay, todayKey));
    } catch (e) {
      const message = getFriendlyError(e, 'Failed to load today\'s schedule');
      setTodayScheduleError(message);
      showToast(message, 'error');
    } finally {
      setTodayScheduleLoading(false);
    }
  }, [teacherId, timetable, todayDay, todayKey]);

  useEffect(() => {
    loadTodaySchedule();
  }, [loadTodaySchedule]);

  useEffect(() => {
    if (!teacherId) return;
    apiFetch(`/duty/status?roleId=${teacherId}`)
      .then(r => r.json())
      .then(data => {
        if (data.onDuty === true) {
          setOnDuty(true);
          setClockInTime(data.clockIn);
          setCurrentStatus(data.currentStatus || 'Available');
        }
      })
      .catch((e) => console.error('Teacher load:', getFriendlyError(e, 'Failed to load data')));
  }, [teacherId]);

  useEffect(() => {
    if (!onDuty || !teacherId) return;
    const newStatus = currentClass ? 'Class in Progress' : 'Available';
    setCurrentStatus(newStatus);
    apiFetch('/duty/update-status', {
      method: 'POST',
      body: JSON.stringify({ roleId: teacherId, currentStatus: newStatus }),
    }).catch((e) => console.error('Teacher load:', getFriendlyError(e, 'Failed to load data')));
  }, [onDuty, teacherId, currentClass]);

  const handleDutyToggle = useCallback(async () => {
    if (dutyLoading) return;
    setDutyLoading(true);
    try {
      if (!onDuty) {
        const res = await apiFetch('/duty/clock-in', {
          method: 'POST',
          body: JSON.stringify({ userId: currentUser?.uid || '', name: displayName, role: 'teacher', roleId: teacherId }),
        });
        const data = await res.json();
        if (res.ok && data.success !== false) {
          setOnDuty(true);
          setClockInTime(data.clockIn);
        }
      } else {
        const res = await apiFetch('/duty/clock-out', {
          method: 'POST',
          body: JSON.stringify({ userId: currentUser?.uid || '', name: displayName, role: 'teacher', roleId: teacherId }),
        });
        if (res.ok) {
          setOnDuty(false);
          setClockInTime(null);
          setCurrentStatus('Off Duty');
        }
      }
    } catch (e) {
      console.error('Duty toggle error:', getFriendlyError(e, 'Failed to toggle duty status'));
    }
    setDutyLoading(false);
  }, [onDuty, dutyLoading, currentUser, displayName, teacherId]);

  const statusColor = currentStatus === 'Class in Progress' ? C.purple : currentStatus === 'Available' ? '#34D399' : C.muted;

  const totalStudents = allAssignedGrades.reduce((sum, g) => sum + (classData[g]?.studentCount || 0), 0);
  const totalPresent = allAssignedGrades.reduce((sum, g) => {
    const id = classData[g]?.id;
    if (!id) return sum;
    const att = attendanceStats[id];
    return sum + (att ? att.present : 0);
  }, 0);

  return (
    <View style={{ flex: 1, backgroundColor: C.navy }}>
      <ScrollView style={{ flex: 1 }}>

      <View style={{ padding: 20, paddingTop: 8, paddingBottom: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <TouchableOpacity
            onPress={() => setDrawerOpen(true)}
            style={{ width: 38, height: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderRadius: 11, borderWidth: 1, borderColor: C.border, marginRight: 10, flexShrink: 0 }}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 17, color: C.white }}>☰</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={{ color: C.muted, fontSize: 13, marginBottom: 2 }}>Welcome,</Text>
            <Text style={{ fontSize: 22, fontWeight: '700', color: C.white }} numberOfLines={1}>{displayName}!</Text>
            {teacherId ? <Text style={{ color: C.gold, fontSize: 12, fontWeight: '600', marginTop: 3 }}>ID: {teacherId}</Text> : null}
            {onDuty && clockInTime ? <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>Clocked in at {clockInTime}</Text> : null}
          </View>
          <View style={{ alignItems: 'center', gap: 4 }}>
            <TouchableOpacity
              onPress={handleDutyToggle}
              disabled={dutyLoading}
              activeOpacity={0.7}
              style={{
                width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                backgroundColor: onDuty ? '#34D399' : C.coral,
                opacity: dutyLoading ? 0.6 : 1,
              }}
            >
              {dutyLoading
                ? <ActivityIndicator size="small" color={C.white} />
                : <Text style={{ fontWeight: '800', fontSize: 11, color: C.white }}>{onDuty ? 'ON' : 'OFF'}</Text>
              }
            </TouchableOpacity>
            <Text style={{ fontSize: 9, fontWeight: '700', color: onDuty ? '#34D399' : C.coral }}>
              {onDuty ? 'ON Duty' : 'OFF Duty'}
            </Text>
            {onDuty && <Text style={{ fontSize: 8, fontWeight: '600', color: statusColor }}>{currentStatus}</Text>}
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
          {[
            { val: loading ? '—' : String(todayClasses.length), lbl: 'Classes Today', color: C.teal, tap: true, onTap: () => setShowTodaySheet(true) },
            { val: loading ? '—' : String(totalStudents), lbl: 'Total Students', color: C.gold, tap: true, onTap: () => setDrillDownVisible(true) },
            { val: loading ? '—' : String(totalPresent), lbl: 'Present', color: '#34D399', tap: true, onTap: () => setDrillDownVisible(true) },
          ].map(m => (
            <TouchableOpacity
              key={m.lbl}
              onPress={m.tap ? m.onTap : undefined}
              style={{
                flex: 1, backgroundColor: C.card, borderWidth: 1,
                borderColor: m.tap ? C.teal + '55' : C.border,
                borderRadius: 16, padding: 16, alignItems: 'center', position: 'relative',
              }}
            >
              {m.tap && (
                <View style={{ position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: 3, backgroundColor: C.teal }} />
              )}
              <Text style={{ fontSize: 28, fontWeight: '700', color: m.color }}>{m.val}</Text>
              <Text style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{m.lbl}</Text>
              {m.tap && <Text style={{ fontSize: 9, color: C.teal, marginTop: 4, fontWeight: '600' }}>Tap to view</Text>}
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ backgroundColor: C.navyMid || C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, padding: 16, marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ flex: 1, marginRight: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.white }}>Today's Schedule</Text>
              <Text style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Classes and staff events in time order</Text>
            </View>
            <TouchableOpacity onPress={loadTodaySchedule} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: (C.navyDark || C.navy) + '66', borderWidth: 1, borderColor: C.border }}>
              <Text style={{ color: C.teal, fontSize: 11, fontWeight: '700' }}>Refresh</Text>
            </TouchableOpacity>
          </View>

          {todayScheduleLoading ? (
            <LoadingSpinner message="Loading today's schedule..." />
          ) : todayScheduleError ? (
            <View style={{ backgroundColor: C.navyDark || C.navy, borderRadius: 16, borderWidth: 1, borderColor: C.coral + '44', padding: 16 }}>
              <Text style={{ color: C.white, fontWeight: '700', fontSize: 14, marginBottom: 6 }}>Couldn't load today's schedule</Text>
              <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{todayScheduleError}</Text>
              <TouchableOpacity onPress={loadTodaySchedule} style={{ alignSelf: 'flex-start', backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 }}>
                <Text style={{ color: C.coral, fontSize: 12, fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView nestedScrollEnabled style={{ maxHeight: 260 }} showsVerticalScrollIndicator={false}>
              {todayScheduleItems.length === 0 ? (
                <View style={{ backgroundColor: C.navyDark || C.navy, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 18, alignItems: 'center' }}>
                  <Text style={{ color: C.white, fontSize: 15, fontWeight: '700', marginBottom: 6 }}>No classes scheduled today</Text>
                  <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>Your classes and staff events for today will appear here.</Text>
                </View>
              ) : todayScheduleItems[0]?.kind === 'holiday' ? (
                <View style={{ backgroundColor: C.coral + '14', borderRadius: 16, borderWidth: 1, borderColor: C.coral + '44', padding: 18 }}>
                  <Text style={{ color: C.coral, fontSize: 14, fontWeight: '800', marginBottom: 6 }}>🔴 Holiday</Text>
                  <Text style={{ color: C.white, fontSize: 15, fontWeight: '700' }}>Holiday — {todayScheduleItems[0].subject}</Text>
                  <Text style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>Today's classes are blocked for the full day.</Text>
                </View>
              ) : (
                todayScheduleItems.map((item, index) => (
                  <View key={item.id} style={{ flexDirection: 'row', gap: 12, backgroundColor: C.navyDark || C.navy, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: index === todayScheduleItems.length - 1 ? 0 : 10 }}>
                    <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: item.kind === 'class' ? C.teal + '22' : C.purple + '22', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Text style={{ fontSize: 18 }}>{item.icon}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: item.kind === 'class' ? C.teal : C.purple, fontSize: 12, fontWeight: '700', marginBottom: 4 }}>{'\u23F0'} {item.time}</Text>
                      <Text style={{ color: C.white, fontSize: 14, fontWeight: '700', marginBottom: 3 }}>{'\uD83C\uDFEB'} {item.className}</Text>
                      <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>{'\uD83D\uDCD6'} {item.subject}</Text>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          )}
        </View>

        {featuredClass && (
          <TouchableOpacity
            onPress={() => setShowTodaySheet(true)}
            style={{
              backgroundColor: featuredColor + '28', borderWidth: 1,
              borderColor: featuredColor + '55', borderRadius: 20, padding: 18, marginBottom: 20,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: featuredColor }} />
                <Text style={{ fontSize: 13, fontWeight: '700', color: featuredColor }}>
                  {featuredLabel}
                  {todayClasses.indexOf(featuredClass) >= 0
                    ? ` · P${todayClasses.indexOf(featuredClass) + 1}`
                    : ''}
                </Text>
              </View>
              <Text style={{ fontSize: 12, color: C.muted }}>
                {formatTimeRange(featuredClass.startTime, featuredClass.endTime)}
              </Text>
            </View>
            <Text style={{ fontWeight: '700', fontSize: 17, marginBottom: 4, color: C.white }}>
              {'Grade '}{featuredClass.className}{' — '}{featuredClass.subject}
            </Text>
            {featuredClass.room ? (
              <Text style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                {featuredClass.room}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              {(() => {
                const cd = classData[featuredClass.className];
                const att = cd?.id ? (attendanceStats[cd.id] || null) : null;
                return (
                  <Text style={{ fontSize: 12, color: C.muted }}>
                    {att && att.submitted
                      ? (
                        <Text>
                          <Text style={{ color: '#34D399', fontWeight: '600' }}>{att.present}</Text>
                          {'/'}{att.total}{' present'}
                        </Text>
                      )
                      : cd?.studentCount
                        ? `${cd.studentCount} students`
                        : 'Loading...'}
                  </Text>
                );
              })()}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ color: featuredColor, fontSize: 12, fontWeight: '600' }}>View all</Text>
                <Icon name="arrow" size={13} color={featuredColor} />
              </View>
            </View>
          </TouchableOpacity>
        )}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
          {[
            { label: 'Mark Attendance', icon: 'check', color: C.teal, screen: 'teacher-attendance' },
            { label: 'Enter Marks', icon: 'chart', color: C.gold, screen: 'cce-home' },
            { label: 'My Schedule', icon: 'book', color: C.purple, screen: 'teacher-schedule' },
            { label: 'Bus Monitor', icon: 'bus', color: C.coral, screen: 'teacher-bus' },
          ].map(a => (
            <TouchableOpacity
              key={a.label}
              onPress={() => onNavigate(a.screen)}
              style={{ width: '48%', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: a.color + '22', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name={a.icon} size={20} color={a.color} />
              </View>
              <Text style={{ fontWeight: '600', fontSize: 13, color: C.white }}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: C.white }}>All My Classes</Text>
          <TouchableOpacity onPress={() => setShowTodaySheet(true)}>
            <Text style={{ fontSize: 13, color: C.gold }}>Today's Schedule</Text>
          </TouchableOpacity>
        </View>

        {loading && (
          <LoadingSpinner message="Loading your classes..." />
        )}

        {!loading && allAssignedGrades.length === 0 && (
          <View style={{ padding: 30, alignItems: 'center', backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border }}>
            <Text style={{ color: C.muted, fontSize: 14, textAlign: 'center' }}>No classes assigned yet.</Text>
            <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 4 }}>Contact admin to set up your timetable.</Text>
          </View>
        )}

        {!loading && timetable.map((entry, i) => {
          const cd = classData[entry.className] || {};
          const att = cd.id ? (attendanceStats[cd.id] || null) : null;
          const color = CLASS_COLORS[i % CLASS_COLORS.length];
          const submitted = att ? att.submitted : false;
          const pct = att && att.submitted && att.total > 0 ? Math.round(att.present / att.total * 100) : null;

          const todayEntry = todayClasses.find(e => e.className === entry.className && e.subject === entry.subject);
          let badgeLabel = '—';
          let badgeColor = C.muted;
          if (todayEntry) {
            const st = getClassStatus(todayEntry);
            if (st === 'ongoing') { badgeLabel = 'Now'; badgeColor = C.gold; }
            else if (st === 'completed') { badgeLabel = submitted ? 'Done' : 'Pending'; badgeColor = submitted ? '#34D399' : C.coral; }
            else { badgeLabel = 'Later'; badgeColor = C.muted; }
          }

          return (
            <TouchableOpacity
              key={i}
              onPress={() => onNavigate('teacher-attendance')}
              style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, padding: 20, marginBottom: 10 }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: color + '22', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Text style={{ fontWeight: '800', fontSize: 13, color }}>{(entry.className || '').replace('-', '')}</Text>
                  </View>
                  <View>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: C.white }}>Grade {entry.className}</Text>
                    <Text style={{ color: C.muted, fontSize: 12 }}>
                      {entry.subject}
                      {entry.room ? ` · ${entry.room}` : ''}
                    </Text>
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <View style={{ paddingVertical: 3, paddingHorizontal: 10, borderRadius: 7, backgroundColor: badgeColor + '22', marginBottom: 4 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: badgeColor }}>{badgeLabel}</Text>
                  </View>
                  {pct !== null
                    ? <Text style={{ fontWeight: '700', fontSize: 16, color }}>{pct}%</Text>
                    : <Text style={{ fontWeight: '700', fontSize: 13, color: C.muted }}>—%</Text>
                  }
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: C.muted }}>
                  {'\u23F0'}{' '}{formatDays(entry.days)}{' '}{entry.startTime ? `· ${entry.startTime}` : ''}
                </Text>
                <Text style={{ fontSize: 12, color: C.muted }}>
                  {att && att.submitted
                    ? `${att.present}/${att.total} present`
                    : cd.studentCount
                      ? `${cd.studentCount} students`
                      : '—'}
                </Text>
              </View>
              <View style={{ height: 8, backgroundColor: C.border, borderRadius: 99, overflow: 'hidden' }}>
                <View style={{
                  width: (att && att.submitted && att.total > 0 ? att.present / att.total * 100 : 0) + '%',
                  height: '100%', backgroundColor: color, borderRadius: 99,
                }} />
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
      </ScrollView>
    <DrillDownSheet 
      visible={drillDownVisible} 
      onClose={() => setDrillDownVisible(false)} 
      classData={classData} 
      attendanceStats={attendanceStats} 
      onStudentSelect={(s) => { setDrillDownVisible(false); setSelectedProfileStudent(s); }} 
    />
    <StudentProfileModal 
      visible={!!selectedProfileStudent} 
      onClose={() => setSelectedProfileStudent(null)} 
      student={selectedProfileStudent} 
    />
    {showTodaySheet && (
      <TodayClassesSheet
        onClose={() => setShowTodaySheet(false)}
        onNavigate={onNavigate}
        todayClasses={todayClasses}
        classData={classData}
        attendanceStats={attendanceStats}
      />
    )}
    <SideDrawer
      visible={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      currentUser={currentUser}
      onNavigate={(scr) => { setDrawerOpen(false); onNavigate(scr); }}
      onLogout={onLogout}
      role="teacher"
      currentScreen={currentScreen}
    />
    <Toast {...toast} onHide={() => setToast(t => ({ ...t, visible: false }))} />
    </View>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5,15,30,0.85)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    maxHeight: '82%',
    backgroundColor: C.navyMid,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: C.border,
    borderBottomWidth: 0,
  },
});
