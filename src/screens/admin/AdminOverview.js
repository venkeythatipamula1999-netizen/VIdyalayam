import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Image,
  ActivityIndicator,
  Platform,
  Modal,
} from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { C } from '../../theme/colors';
import Icon from '../../components/Icon';
import { apiFetch } from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Toast from '../../components/Toast';
import DonutRing from '../../components/DonutRing';
import { getFriendlyError } from '../../utils/errorMessages';
import SideDrawer from '../../components/SideDrawer';

const ROLE_COLORS = { teacher: C.gold, driver: C.teal, cleaner: C.coral };
const STATUS_COLORS = {
  'Class in Progress': C.purple,
  'In Transit': C.teal,
  'In Transit/Student Pickup': C.teal,
  Available: '#34D399',
  'On Duty': '#34D399',
  'Off Duty': C.muted,
  'Auto Clock-Out': C.coral,
};
const ATTENDANCE_STATUS_COLORS = {
  Present: '#34D399',
  Absent: C.coral,
  Leave: C.gold,
  'Half Day': C.gold,
  'Short Day': '#FB923C',
  'Not Marked': C.muted,
  Sunday: C.border,
};

function getIstTodayKey() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getRecentMonths(count = 4, startMonth = currentMonthKey()) {
  const months = [];
  let [year, month] = startMonth.split('-').map(Number);
  for (let index = 0; index < count; index += 1) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return months;
}

function formatMonthLabel(monthKey) {
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}

function formatDisplayDate(dateKey) {
  if (!dateKey) return '';
  return new Date(dateKey + 'T12:00:00').toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatClassLabel(raw) {
  if (!raw) return 'Unassigned';
  const label = String(raw).trim();
  if (!label) return 'Unassigned';
  return /^grade /i.test(label) ? label : `Grade ${label}`;
}

function getStudentId(student) {
  return String(student?.studentId || student?.id || '');
}

function getStudentRecordKey(student) {
  return String(student?.id || student?.studentId || '');
}

function getStudentName(student) {
  return student?.name || student?.studentName || 'Student';
}

function getStudentClass(student) {
  return student?.className || student?.class || student?.studentClass || '-';
}

function isDateWithin(dateKey, fromDate, toDate) {
  if (!dateKey || !fromDate) return false;
  const start = String(fromDate).slice(0, 10);
  const end = String(toDate || fromDate).slice(0, 10);
  return dateKey >= start && dateKey <= end;
}

function isApprovedLeaveToday(leave, dateKey) {
  const status = String(leave?.status || '').toLowerCase();
  if (status !== 'approved') return false;
  return isDateWithin(dateKey, leave?.from || leave?.startDate, leave?.to || leave?.endDate);
}

function formatScanTimestamp(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function parseTimeMins(value) {
  if (!value) return null;
  const match = String(value).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();
  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

function getTodayDay() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function getNowMins() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function normalizeClassKey(raw) {
  return String(raw || '').replace(/^Grade\s+/i, '').trim().toLowerCase();
}

function sortByName(a, b) {
  return getStudentName(a).localeCompare(getStudentName(b));
}

function getWorkingDays(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const workingDays = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${monthKey}-${String(day).padStart(2, '0')}`;
    if (new Date(dateKey + 'T12:00:00').getDay() !== 0) {
      workingDays.push(dateKey);
    }
  }
  return workingDays;
}

function buildMonthCells(monthKey, recordMap) {
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(`${monthKey}-01T12:00:00`).getDay();
  const cells = [];
  for (let blank = 0; blank < firstDow; blank += 1) {
    cells.push({ key: `blank-${monthKey}-${blank}`, isBlank: true });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${monthKey}-${String(day).padStart(2, '0')}`;
    const dow = new Date(date + 'T12:00:00').getDay();
    const isSunday = dow === 0;
    cells.push({
      key: date,
      date,
      day,
      isSunday,
      status: isSunday ? 'Sunday' : recordMap[date] || 'Not Marked',
    });
  }
  return cells;
}

function summarizeStudentMonth(monthKey, recordEntries) {
  const recordMap = {};
  recordEntries
    .filter((item) => item.date && item.date.startsWith(monthKey))
    .forEach((item) => {
      recordMap[item.date] = item.status || 'Not Marked';
    });

  const workingDays = getWorkingDays(monthKey);
  const days = workingDays.map((date) => ({ date, status: recordMap[date] || 'Not Marked' }));
  const present = days.filter((day) => day.status === 'Present').length;
  const absent = days.filter((day) => day.status === 'Absent').length;
  const leave = days.filter((day) => day.status === 'Leave').length;
  const markedDays = days.filter((day) => day.status !== 'Not Marked').length;
  const pct = markedDays > 0 ? Math.round((present / markedDays) * 100) : 0;

  return {
    month: monthKey,
    label: formatMonthLabel(monthKey),
    cells: buildMonthCells(monthKey, recordMap),
    summary: {
      present,
      absent,
      leave,
      total: workingDays.length,
      markedDays,
      pct,
    },
  };
}

function summarizeStaffMonth(monthKey, days) {
  const calendarMap = {};
  (days || []).forEach((day) => {
    calendarMap[day.date] = day.status || 'Absent';
  });
  const present = (days || []).filter((day) => ['Present', 'Half Day', 'Short Day'].includes(day.status)).length;
  const absent = (days || []).filter((day) => day.status === 'Absent').length;
  const pct = days && days.length > 0 ? Math.round((present / days.length) * 100) : 0;

  return {
    month: monthKey,
    label: formatMonthLabel(monthKey),
    cells: buildMonthCells(monthKey, calendarMap),
    days: days || [],
    summary: {
      present,
      absent,
      total: (days || []).length,
      markedDays: (days || []).length,
      pct,
    },
  };
}

function getStatusColor(status) {
  return ATTENDANCE_STATUS_COLORS[status] || C.muted;
}

function getStatusIcon(status) {
  switch (status) {
    case 'Present':
      return 'OK';
    case 'Absent':
      return 'X';
    case 'Leave':
      return 'LV';
    case 'Half Day':
      return 'HD';
    case 'Short Day':
      return 'SD';
    case 'Sunday':
      return '';
    default:
      return '-';
  }
}

function getStaffDescriptor(staff) {
  if (!staff) return '-';
  const detail = staff.subject || staff.dept || staff.department;
  if (detail) return detail;
  const role = String(staff.role || '').trim();
  if (!role) return 'Staff';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function getLinePoints(values) {
  if (!values.length) return '';
  if (values.length === 1) return `50,12`;
  const height = 42;
  const width = 100;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const clamped = Math.max(0, Math.min(100, Number(value) || 0));
      const y = height - (clamped / 100) * 30 - 6;
      return `${x},${y}`;
    })
    .join(' ');
}

function formatMoney(value) {
  return `Rs ${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function AttendanceMetricCard({ label, value, color, icon, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[styles.attendanceMetricCard, { borderColor: color + '44' }]}
    >
      <View style={[styles.attendanceMetricIcon, { backgroundColor: color + '22' }]}>
        <Text style={{ fontSize: 18 }}>{icon}</Text>
      </View>
      <Text style={[styles.attendanceMetricValue, { color }]}>{value}</Text>
      <Text style={styles.attendanceMetricLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function SectionChip({ color, label }) {
  return (
    <View style={[styles.sectionChip, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

function SheetModal({ visible, onClose, title, subtitle, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.sheetContent}>
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={styles.sheetTitle}>{title}</Text>
              {subtitle ? <Text style={styles.sheetSubtitle}>{subtitle}</Text> : null}
            </View>
            <TouchableOpacity onPress={onClose} style={styles.sheetCloseBtn}>
              <Icon name="x" size={16} color={C.muted} />
            </TouchableOpacity>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

function AttendancePie({ present, absent, size = 96 }) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = Math.max((present || 0) + (absent || 0), 1);
  const presentPct = present / total;
  const presentDash = circumference * presentPct;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={C.border}
          strokeWidth={stroke}
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={C.coral}
          strokeWidth={stroke}
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#34D399"
          strokeWidth={stroke}
          strokeDasharray={`${presentDash} ${circumference}`}
          strokeLinecap="round"
        />
      </Svg>
      <View style={styles.pieCenter}>
        <Text style={{ color: C.white, fontWeight: '800', fontSize: 15 }}>
          {Math.round(presentPct * 100)}%
        </Text>
        <Text style={{ color: C.muted, fontSize: 9 }}>Present</Text>
      </View>
    </View>
  );
}

function MonthlyBarChart({ months, color }) {
  const safeMonths = months || [];
  return (
    <View style={styles.barChartWrap}>
      <View style={styles.barChart}>
        {safeMonths.map((month) => (
          <View key={month.month} style={styles.barChartCol}>
            <Text style={[styles.barChartValue, { color }]}>{month.summary.pct}%</Text>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  {
                    height: `${Math.max(month.summary.pct, 4)}%`,
                    backgroundColor: color,
                  },
                ]}
              />
            </View>
            <Text style={styles.barChartLabel}>{month.label.slice(0, 3)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function TrendLineChart({ months, color }) {
  const points = getLinePoints((months || []).map((month) => month.summary.pct));
  return (
    <View style={styles.trendWrap}>
      <Svg width="100%" height={62} viewBox="0 0 100 42">
        <Polyline
          points="0,36 100,36"
          stroke={C.border}
          strokeWidth={1}
          fill="none"
          strokeDasharray="3 3"
        />
        {points ? (
          <Polyline points={points} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" />
        ) : null}
      </Svg>
      <View style={styles.trendLabels}>
        {(months || []).map((month) => (
          <Text key={month.month} style={styles.trendLabelText}>
            {month.label.slice(0, 3)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function CalendarMonthCard({ monthData }) {
  if (!monthData) return null;
  return (
    <View style={styles.calendarCard}>
      <View style={styles.calendarHeader}>
        <Text style={styles.calendarTitle}>{monthData.label}</Text>
        <SectionChip color={monthData.summary.pct >= 75 ? C.teal : C.coral} label={`${monthData.summary.pct}%`} />
      </View>
      <View style={styles.calendarWeekRow}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <Text key={day} style={styles.calendarWeekLabel}>
            {day}
          </Text>
        ))}
      </View>
      <View style={styles.calendarGrid}>
        {monthData.cells.map((cell) => {
          if (cell.isBlank) return <View key={cell.key} style={styles.calendarCellBlank} />;
          const color = getStatusColor(cell.status);
          return (
            <View
              key={cell.key}
              style={[
                styles.calendarCell,
                cell.isSunday && styles.calendarCellSunday,
                !cell.isSunday && { borderColor: color + '44', backgroundColor: color + '14' },
              ]}
            >
              <Text style={[styles.calendarDayText, cell.isSunday && { color: C.border }]}>
                {cell.day}
              </Text>
              <Text
                style={[
                  styles.calendarStatusText,
                  cell.isSunday ? { color: C.border } : { color },
                ]}
              >
                {getStatusIcon(cell.status)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default function AdminOverview({ onNavigate, currentUser, onLogout, currentScreen }) {
  const attendanceRecordCacheRef = useRef({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [realStats, setRealStats] = useState({ teachers: 0, drivers: 0, cleaners: 0, classes: 0 });
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [liveBoardRows, setLiveBoardRows] = useState([]);
  const [liveBoardLoading, setLiveBoardLoading] = useState(false);
  const [liveBoardError, setLiveBoardError] = useState('');
  const [showLiveBoardModal, setShowLiveBoardModal] = useState(false);
  const [locationRequests, setLocationRequests] = useState([]);
  const [approvingId, setApprovingId] = useState(null);
  const [rejectingId, setRejectingId] = useState(null);
  const [locationMsg, setLocationMsg] = useState('');
  const [busSummaryLoading, setBusSummaryLoading] = useState(true);
  const [busSummaryError, setBusSummaryError] = useState('');
  const [busSummaries, setBusSummaries] = useState([]);
  const [selectedBusSummary, setSelectedBusSummary] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [attendanceLoading, setAttendanceLoading] = useState(true);
  const [attendanceError, setAttendanceError] = useState('');
  const [attendanceSnapshot, setAttendanceSnapshot] = useState({
    totalStudents: 0,
    presentStudents: 0,
    absentStudents: 0,
    totalStaff: 0,
    presentStaff: 0,
    absentStaff: 0,
    classSummaries: [],
    studentsByClass: {},
    staffAll: [],
    staffPresent: [],
    staffAbsent: [],
  });
  const [attendancePanel, setAttendancePanel] = useState(null);
  const [selectedAttendanceClass, setSelectedAttendanceClass] = useState(null);
  const [attendanceClassLoading, setAttendanceClassLoading] = useState(false);
  const [attendanceClassError, setAttendanceClassError] = useState('');
  const [attendanceClassDetails, setAttendanceClassDetails] = useState(null);
  const [studentProfileTarget, setStudentProfileTarget] = useState(null);
  const [studentProfileLoading, setStudentProfileLoading] = useState(false);
  const [studentProfileError, setStudentProfileError] = useState('');
  const [studentProfile, setStudentProfile] = useState(null);
  const [staffProfileTarget, setStaffProfileTarget] = useState(null);
  const [staffProfileLoading, setStaffProfileLoading] = useState(false);
  const [staffProfileError, setStaffProfileError] = useState('');
  const [staffProfile, setStaffProfile] = useState(null);

  const showToast = (message, type = 'success') => setToast({ visible: true, message, type });

  useEffect(() => {
    const fetchUnread = () => {
      apiFetch('/school-notifications?unreadOnly=true&t=' + Date.now(), { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => setUnreadNotifCount(data.count || 0))
        .catch(() => {});
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    apiFetch('/onboarded-users?t=' + Date.now(), { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        const users = data.users || [];
        setRealStats((previous) => ({
          ...previous,
          teachers: users.filter((user) => user.role === 'teacher').length,
          drivers: users.filter((user) => user.role === 'driver').length,
          cleaners: users.filter((user) => user.role === 'cleaner').length,
        }));
      })
      .catch(() => {});
    apiFetch('/classes?t=' + Date.now(), { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setRealStats((previous) => ({ ...previous, classes: (data.classes || []).length })))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fetchLiveBoard = async (showLoader) => {
      if (showLoader) setLiveBoardLoading(true);
      setLiveBoardError('');
      try {
        const [classesRes, usersRes, dutyRes] = await Promise.all([
          apiFetch('/classes?t=' + Date.now(), { cache: 'no-store' }),
          apiFetch('/onboarded-users?t=' + Date.now(), { cache: 'no-store' }),
          apiFetch('/duty/all-staff?t=' + Date.now(), { cache: 'no-store' }),
        ]);

        const [classesData, usersData, dutyData] = await Promise.all([
          classesRes.json(),
          usersRes.json(),
          dutyRes.json(),
        ]);

        const classes = (classesData.classes || []).slice().sort((a, b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''), undefined, { numeric: true }));
        const users = usersData.users || [];
        const academicUsers = users.filter((user) => user.role === 'teacher' || user.role === 'staff');
        const profiles = await Promise.all(
          academicUsers.map(async (user) => {
            try {
              const response = await apiFetch(`/teacher/profile?roleId=${encodeURIComponent(user.role_id)}&t=${Date.now()}`, { cache: 'no-store' });
              const data = await response.json();
              if (response.ok && !data.error) {
                return {
                  ...user,
                  ...data,
                  full_name: data.full_name || user.full_name || 'Teacher',
                  role_id: data.role_id || user.role_id,
                  timetable: Array.isArray(data.timetable) ? data.timetable : [],
                  assignedClasses: Array.isArray(data.assignedClasses) ? data.assignedClasses : (user.assignedClasses || []),
                  classTeacherOf: data.classTeacherOf || user.classTeacherOf || null,
                };
              }
            } catch (_) {}

            return {
              ...user,
              full_name: user.full_name || 'Teacher',
              timetable: [],
              assignedClasses: user.assignedClasses || [],
              classTeacherOf: user.classTeacherOf || null,
            };
          })
        );

        const dutyMap = {};
        (dutyData.staff || []).forEach((item) => {
          if (item.roleId) dutyMap[item.roleId] = item;
        });

        const todayDay = getTodayDay();
        const nowMins = getNowMins();
        const rows = classes.map((schoolClass) => {
          const className = schoolClass.name || schoolClass.id || '';
          const classKey = normalizeClassKey(className);

          const matchingProfiles = profiles.filter((profile) => {
            const assignedClasses = Array.isArray(profile.assignedClasses) ? profile.assignedClasses : [];
            const timetable = Array.isArray(profile.timetable) ? profile.timetable : [];
            return (
              normalizeClassKey(profile.classTeacherOf) === classKey ||
              assignedClasses.some((item) => normalizeClassKey(item) === classKey) ||
              timetable.some((entry) => normalizeClassKey(entry.className) === classKey)
            );
          });

          const activeEntries = [];
          matchingProfiles.forEach((profile) => {
            (profile.timetable || []).forEach((entry, index) => {
              if (normalizeClassKey(entry.className) !== classKey) return;
              if (!(entry.days || []).includes(todayDay)) return;
              const start = parseTimeMins(entry.startTime);
              const end = parseTimeMins(entry.endTime);
              if (start === null || end === null) return;
              if (nowMins >= start && nowMins < end) {
                activeEntries.push({
                  profile,
                  entry,
                  start,
                  index,
                  duty: dutyMap[profile.role_id] || null,
                });
              }
            });
          });

          activeEntries.sort((a, b) => {
            if (!!b.duty?.onDuty !== !!a.duty?.onDuty) return b.duty?.onDuty ? 1 : -1;
            return a.start - b.start || a.index - b.index;
          });

          const currentSlot = activeEntries[0] || null;
          const assignedProfile =
            matchingProfiles.find((profile) => normalizeClassKey(profile.classTeacherOf) === classKey) ||
            matchingProfiles[0] ||
            null;
          const subjectHint =
            (assignedProfile?.timetable || []).find((entry) => normalizeClassKey(entry.className) === classKey)?.subject ||
            assignedProfile?.subject ||
            assignedProfile?.subjects?.[0] ||
            '';

          if (currentSlot) {
            const isActive = !!currentSlot.duty?.onDuty;
            return {
              id: String(schoolClass.id || classKey || className),
              className: formatClassLabel(className),
              teacherName: currentSlot.profile.full_name || 'Teacher',
              subject: currentSlot.entry.subject || subjectHint || 'Class',
              statusKey: isActive ? 'green' : 'red',
              statusLabel: isActive ? 'Teacher Active' : 'Teacher Absent',
              statusColor: isActive ? '#34D399' : C.coral,
              noTeacher: false,
              currentStatus: currentSlot.duty?.currentStatus || '',
            };
          }

          if (assignedProfile) {
            return {
              id: String(schoolClass.id || classKey || className),
              className: formatClassLabel(className),
              teacherName: assignedProfile.full_name || 'Teacher',
              subject: subjectHint || 'Free Period',
              statusKey: 'yellow',
              statusLabel: 'Free Period',
              statusColor: C.gold,
              noTeacher: false,
              currentStatus: '',
            };
          }

          return {
            id: String(schoolClass.id || classKey || className),
            className: formatClassLabel(className),
            teacherName: 'No Teacher Assigned',
            subject: 'No class scheduled',
            statusKey: 'red',
            statusLabel: 'No Teacher',
            statusColor: C.coral,
            noTeacher: true,
            currentStatus: '',
          };
        });

        const statusOrder = { red: 0, green: 1, yellow: 2 };
        rows.sort((a, b) => {
          const rankDelta = (statusOrder[a.statusKey] ?? 9) - (statusOrder[b.statusKey] ?? 9);
          if (rankDelta !== 0) return rankDelta;
          return a.className.localeCompare(b.className, undefined, { numeric: true });
        });

        setLiveBoardRows(rows);
      } catch (error) {
        setLiveBoardError(getFriendlyError(error, 'Failed to load live staff board'));
      } finally {
        if (showLoader) setLiveBoardLoading(false);
      }
    };

    fetchLiveBoard(true);
    const interval = setInterval(() => fetchLiveBoard(false), 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchRequests = () => {
      apiFetch('/bus/location-change-requests?t=' + Date.now(), { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => {
          setLocationRequests(data.requests || []);
        })
        .catch(() => {});
    };
    fetchRequests();
    const interval = setInterval(fetchRequests, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchAttendanceSnapshot = useCallback(async (showLoader = true) => {
    if (showLoader) setAttendanceLoading(true);
    setAttendanceError('');
    try {
      const todayKey = getIstTodayKey();
      const monthKey = currentMonthKey();
      const [classesRes, studentsRes, employeesRes, liveStaffRes] = await Promise.all([
        apiFetch('/classes?t=' + Date.now(), { cache: 'no-store' }),
        apiFetch('/students/list?t=' + Date.now(), { cache: 'no-store' }),
        apiFetch(`/payroll/employees?month=${monthKey}&t=${Date.now()}`, { cache: 'no-store' }),
        apiFetch('/duty/all-staff?t=' + Date.now(), { cache: 'no-store' }),
      ]);

      const [classesData, studentsData, employeesData, liveStaffData] = await Promise.all([
        classesRes.json(),
        studentsRes.json(),
        employeesRes.json(),
        liveStaffRes.json(),
      ]);

      const classes = classesData.classes || [];
      const students = studentsData.students || [];
      const employees = employeesData.employees || [];
      const liveStaff = liveStaffData.staff || [];
      const classIds = classes.map((item) => item.id).filter(Boolean);

      let classStats = {};
      if (classIds.length > 0) {
        const statsRes = await apiFetch(
          `/attendance/class-stats?date=${todayKey}&classIds=${encodeURIComponent(classIds.join(','))}&t=${Date.now()}`,
          { cache: 'no-store' }
        );
        const statsData = await statsRes.json();
        classStats = statsData.stats || {};
      }

      const classesById = {};
      classes.forEach((item) => {
        classesById[item.id] = item;
      });

      const studentsByClass = {};
      students.forEach((student) => {
        const classId = student.classId || student.className || 'unassigned';
        if (!studentsByClass[classId]) studentsByClass[classId] = [];
        studentsByClass[classId].push(student);
      });

      const mergedClassIds = Array.from(new Set([...Object.keys(studentsByClass), ...classIds]));
      const classSummaries = mergedClassIds
        .map((classId) => {
          const classStudents = (studentsByClass[classId] || []).slice().sort(sortByName);
          const classInfo = classesById[classId];
          const presentCount = classStats[classId]?.present || 0;
          const absentCount = Math.max(classStudents.length - presentCount, 0);
          const className = formatClassLabel(classInfo?.name || classStudents[0]?.className || classId);
          return {
            classId,
            className,
            totalStudents: classStudents.length,
            presentCount,
            absentCount,
          };
        })
        .filter((item) => item.totalStudents > 0)
        .sort((a, b) => a.className.localeCompare(b.className));

      const presentStudents = classSummaries.reduce((sum, item) => sum + item.presentCount, 0);
      const totalStudents = students.length;
      const absentStudents = Math.max(totalStudents - presentStudents, 0);

      const liveStaffMap = {};
      liveStaff.forEach((item) => {
        if (item.roleId) liveStaffMap[item.roleId] = item;
      });

      const staffAll = employees.slice().sort((a, b) => a.name.localeCompare(b.name));
      const staffPresent = staffAll.filter((item) => liveStaffMap[item.roleId]);
      const staffAbsent = staffAll.filter((item) => !liveStaffMap[item.roleId]);

      setAttendanceSnapshot({
        totalStudents,
        presentStudents,
        absentStudents,
        totalStaff: staffAll.length,
        presentStaff: staffPresent.length,
        absentStaff: staffAbsent.length,
        classSummaries,
        studentsByClass,
        staffAll,
        staffPresent,
        staffAbsent,
      });
    } catch (error) {
      const message = getFriendlyError(error, 'Failed to load attendance snapshot');
      setAttendanceError(message);
      if (showLoader) showToast(message, 'error');
    } finally {
      if (showLoader) setAttendanceLoading(false);
    }
  }, []);

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
      const buses = busesData.buses || [];
      const leaveRequests = leavesData.requests || leavesData.leaves || [];
      const approvedLeavesToday = leaveRequests.filter((request) => isApprovedLeaveToday(request, todayKey));

      const summaries = await Promise.all(
        buses.map(async (bus) => {
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
            .filter((scan) => scan.type === 'board')
            .sort((a, b) => (a.timestamp || a.createdAt || '').localeCompare(b.timestamp || b.createdAt || ''))
            .forEach((scan) => {
              boardedScanMap[String(scan.studentId || '')] = scan;
            });

          const leaveStudentMap = {};
          approvedLeavesToday.forEach((leave) => {
            const leaveStudentId = String(leave.studentId || '');
            if (!leaveStudentId) return;
            if (!passengers.some((student) => getStudentId(student) === leaveStudentId)) return;
            const matchedStudent = passengers.find((student) => getStudentId(student) === leaveStudentId);
            leaveStudentMap[leaveStudentId] = {
              studentId: leaveStudentId,
              studentName: leave.studentName || getStudentName(matchedStudent),
              className: leave.studentClass || getStudentClass(matchedStudent),
            };
          });

          const boardedStudents = passengers
            .filter((student) => boardedScanMap[getStudentId(student)])
            .map((student) => {
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
            .filter((student) => {
              const studentId = getStudentId(student);
              return !boardedScanMap[studentId] && !leaveStudentMap[studentId];
            })
            .map((student) => ({
              studentId: getStudentId(student),
              studentName: getStudentName(student),
              className: getStudentClass(student),
            }))
            .sort((a, b) => a.studentName.localeCompare(b.studentName));

          const recentScans = scans
            .slice()
            .sort((a, b) => (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || ''))
            .map((scan) => ({
              id: scan.id || `${scan.studentId}_${scan.timestamp}`,
              studentName: scan.studentName || 'Student',
              className: scan.className || '-',
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

      setBusSummaries(
        summaries.sort((a, b) =>
          String(a.busNumber).localeCompare(String(b.busNumber), undefined, { numeric: true })
        )
      );
      setSelectedBusSummary((previous) =>
        previous ? summaries.find((bus) => bus.id === previous.id) || previous : null
      );
    } catch (error) {
      const message = getFriendlyError(error, 'Failed to load bus summary');
      setBusSummaryError(message);
      if (showLoader) showToast(message, 'error');
    } finally {
      if (showLoader) setBusSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAttendanceSnapshot(true);
    const interval = setInterval(() => fetchAttendanceSnapshot(false), 60000);
    return () => clearInterval(interval);
  }, [fetchAttendanceSnapshot]);

  useEffect(() => {
    fetchBusSummaries(true);
    const interval = setInterval(() => fetchBusSummaries(false), 30000);
    return () => clearInterval(interval);
  }, [fetchBusSummaries]);

  const handleApproveLocation = (request) => {
    setApprovingId(request.id);
    setLocationMsg('');
    apiFetch('/bus/approve-location-change', {
      method: 'POST',
      body: JSON.stringify({ requestId: request.id }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          setLocationRequests((previous) => previous.filter((item) => item.id !== request.id));
          setLocationMsg(`Approved location for ${request.studentName}`);
          setTimeout(() => setLocationMsg(''), 3000);
        } else {
          setLocationMsg(data.error || 'Failed to approve');
          setTimeout(() => setLocationMsg(''), 4000);
        }
      })
      .catch((error) => {
        setLocationMsg(getFriendlyError(error, 'Network error approving request'));
        setTimeout(() => setLocationMsg(''), 4000);
      })
      .finally(() => setApprovingId(null));
  };

  const handleRejectLocation = (request) => {
    setRejectingId(request.id);
    setLocationMsg('');
    apiFetch('/bus/reject-location-change', {
      method: 'POST',
      body: JSON.stringify({ requestId: request.id }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          setLocationRequests((previous) => previous.filter((item) => item.id !== request.id));
          setLocationMsg(`Rejected location change for ${request.studentName}`);
          setTimeout(() => setLocationMsg(''), 3000);
        } else {
          setLocationMsg(data.error || 'Failed to reject');
          setTimeout(() => setLocationMsg(''), 4000);
        }
      })
      .catch((error) => {
        setLocationMsg(getFriendlyError(error, 'Network error rejecting request'));
        setTimeout(() => setLocationMsg(''), 4000);
      })
      .finally(() => setRejectingId(null));
  };

  const handleDownloadAudit = async () => {
    setAuditLoading(true);
    try {
      const response = await apiFetch('/report/master-audit');
      if (!response.ok) throw new Error('Failed to generate report');
      if (Platform.OS === 'web') {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'Sree-Pragathi-Master-Audit-Report.pdf';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
        showToast('Audit report downloaded!', 'success');
      } else {
        showToast('PDF downloaded', 'success');
      }
    } catch (error) {
      showToast(getFriendlyError(error, 'Failed to download audit report'), 'error');
    } finally {
      setAuditLoading(false);
    }
  };

  const openAttendancePanel = (type, filter) => {
    setAttendancePanel({ type, filter });
    setSelectedAttendanceClass(null);
    setAttendanceClassDetails(null);
    setAttendanceClassError('');
    setStudentProfileTarget(null);
    setStudentProfile(null);
    setStudentProfileError('');
    setStaffProfileTarget(null);
    setStaffProfile(null);
    setStaffProfileError('');
  };

  const closeAttendancePanel = () => {
    setAttendancePanel(null);
    setSelectedAttendanceClass(null);
    setAttendanceClassDetails(null);
    setAttendanceClassError('');
  };

  const handleOpenClassDetail = async (classSummary) => {
    if (!classSummary) return;
    setSelectedAttendanceClass(classSummary);
    setAttendanceClassLoading(true);
    setAttendanceClassError('');
    setAttendanceClassDetails(null);
    try {
      const response = await apiFetch(
        `/attendance/records?classId=${encodeURIComponent(classSummary.classId)}&date=${getIstTodayKey()}&t=${Date.now()}`,
        { cache: 'no-store' }
      );
      const data = await response.json();
      const records = data.records || [];
      const statusMap = {};
      records.forEach((record) => {
        statusMap[String(record.studentId || '')] = record.status || 'Absent';
      });
      const students = (attendanceSnapshot.studentsByClass[classSummary.classId] || []).slice().sort(sortByName);
      const presentStudents = students
        .filter((student) => statusMap[getStudentRecordKey(student)] === 'Present')
        .map((student) => ({
          ...student,
          displayName: getStudentName(student),
          displayClass: formatClassLabel(getStudentClass(student)),
          displayId: getStudentId(student) || getStudentRecordKey(student),
        }));
      const absentStudents = students
        .filter((student) => statusMap[getStudentRecordKey(student)] !== 'Present')
        .map((student) => ({
          ...student,
          displayName: getStudentName(student),
          displayClass: formatClassLabel(getStudentClass(student)),
          displayId: getStudentId(student) || getStudentRecordKey(student),
        }));

      setAttendanceClassDetails({
        classId: classSummary.classId,
        className: classSummary.className,
        presentStudents,
        absentStudents,
      });
    } catch (error) {
      setAttendanceClassError(getFriendlyError(error, 'Failed to load class attendance'));
    } finally {
      setAttendanceClassLoading(false);
    }
  };

  const handleOpenStudentProfile = async (student) => {
    setStudentProfileTarget(student);
    setStudentProfileLoading(true);
    setStudentProfileError('');
    setStudentProfile(null);
    try {
      const studentDocId = getStudentRecordKey(student);
      const classId = student?.classId || selectedAttendanceClass?.classId;
      if (!studentDocId || !classId) throw new Error('Student record not available');

      const months = getRecentMonths(4);
      const recordEntries = [];

      for (const month of months) {
        const workingDays = getWorkingDays(month);
        const dailyRecords = await Promise.all(
          workingDays.map(async (date) => {
            const cacheKey = `${classId}_${date}`;
            if (!attendanceRecordCacheRef.current[cacheKey]) {
              attendanceRecordCacheRef.current[cacheKey] = apiFetch(
                `/attendance/records?classId=${encodeURIComponent(classId)}&date=${date}&t=${Date.now()}`,
                { cache: 'no-store' }
              )
                .then((response) => response.json())
                .then((data) => data.records || [])
                .catch(() => []);
            }

            const records = await attendanceRecordCacheRef.current[cacheKey];
            const match = records.find((record) => String(record.studentId || '') === studentDocId);
            return { date, status: match?.status || 'Not Marked' };
          })
        );
        recordEntries.push(...dailyRecords);
      }

      const monthSummaries = months.map((month) => summarizeStudentMonth(month, recordEntries));
      const totals = monthSummaries.reduce(
        (accumulator, month) => ({
          present: accumulator.present + month.summary.present,
          absent: accumulator.absent + month.summary.absent,
          leave: accumulator.leave + month.summary.leave,
        }),
        { present: 0, absent: 0, leave: 0 }
      );
      const totalMarked = totals.present + totals.absent + totals.leave;
      const overallPct = totalMarked > 0 ? Math.round((totals.present / totalMarked) * 100) : 0;

      setStudentProfile({
        student,
        monthSummaries,
        totals,
        overallPct,
      });
    } catch (error) {
      setStudentProfileError(getFriendlyError(error, 'Failed to load student attendance profile'));
    } finally {
      setStudentProfileLoading(false);
    }
  };

  const closeStudentProfile = () => {
    setStudentProfileTarget(null);
    setStudentProfile(null);
    setStudentProfileError('');
  };

  const handleOpenStaffProfile = async (staff) => {
    setStaffProfileTarget(staff);
    setStaffProfileLoading(true);
    setStaffProfileError('');
    setStaffProfile(null);
    try {
      const months = getRecentMonths(4);
      const responses = await Promise.all(
        months.map((month) =>
          apiFetch(`/payroll/attendance?roleId=${encodeURIComponent(staff.roleId)}&month=${month}&t=${Date.now()}`, {
            cache: 'no-store',
          }).then((response) => response.json())
        )
      );

      const monthSummaries = months.map((month, index) =>
        summarizeStaffMonth(month, responses[index]?.days || [])
      );

      const totals = monthSummaries.reduce(
        (accumulator, month) => ({
          present: accumulator.present + month.summary.present,
          absent: accumulator.absent + month.summary.absent,
        }),
        { present: 0, absent: 0 }
      );
      const overallPct =
        totals.present + totals.absent > 0
          ? Math.round((totals.present / (totals.present + totals.absent)) * 100)
          : 0;

      setStaffProfile({
        staff,
        monthSummaries,
        totals,
        overallPct,
      });
    } catch (error) {
      setStaffProfileError(getFriendlyError(error, 'Failed to load staff attendance profile'));
    } finally {
      setStaffProfileLoading(false);
    }
  };

  const closeStaffProfile = () => {
    setStaffProfileTarget(null);
    setStaffProfile(null);
    setStaffProfileError('');
  };

  const statGrid = [
    { icon: '👩‍🏫', val: String(realStats.teachers), lbl: 'Teachers', color: C.gold },
    { icon: '🏫', val: String(realStats.classes), lbl: 'Classes', color: C.purple },
    { icon: '🚌', val: String(realStats.drivers), lbl: 'Drivers', color: C.coral },
    { icon: '🧹', val: String(realStats.cleaners), lbl: 'Cleaners', color: C.teal },
  ];

  const quickNav = [
    { icon: '👥', label: 'Manage Users', screen: 'admin-users', color: C.teal },
    { icon: '🏫', label: 'Classes', screen: 'admin-classes', color: C.gold },
    { icon: '🚌', label: 'Bus & Routes', screen: 'admin-buses', color: C.coral },
    { icon: '📊', label: 'Reports', screen: 'admin-reports', color: C.purple },
    { icon: '📅', label: 'Leave Requests', screen: 'admin-leaves', color: '#34D399' },
    { icon: '💰', label: 'Fee Management', screen: 'admin-fees', color: '#60A5FA' },
    { icon: '📋', label: 'Fee Status', screen: 'admin-fee-status', color: '#38BDF8' },
    { icon: '💸', label: 'Payroll', screen: 'admin-salary', color: '#FB923C' },
    { icon: '🎓', label: 'Activities', screen: 'admin-activities', color: C.gold },
    { icon: '📤', label: 'Promotion', screen: 'admin-promotion', color: '#A78BFA' },
  ];

  const studentPanelRows = attendanceSnapshot.classSummaries
    .slice()
    .sort((a, b) => {
      if (attendancePanel?.filter === 'present') {
        return b.presentCount - a.presentCount || a.className.localeCompare(b.className);
      }
      if (attendancePanel?.filter === 'absent') {
        return b.absentCount - a.absentCount || a.className.localeCompare(b.className);
      }
      return a.className.localeCompare(b.className);
    });

  const staffPanelRows =
    attendancePanel?.filter === 'present'
      ? attendanceSnapshot.staffPresent
      : attendancePanel?.filter === 'absent'
        ? attendanceSnapshot.staffAbsent
        : attendanceSnapshot.staffAll;
  const liveBoardPreviewRows = liveBoardRows.slice(0, 3);
  const liveBoardActiveCount = liveBoardRows.filter((row) => row.statusKey === 'green').length;
  const liveBoardNoTeacherCount = liveBoardRows.filter((row) => row.noTeacher).length;

  return (
    <>
      <ScrollView style={styles.container}>
        <View style={{ padding: 20, paddingBottom: 0 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <TouchableOpacity
                onPress={() => setDrawerOpen(true)}
                style={styles.drawerBtn}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 17, color: C.white }}>☰</Text>
              </TouchableOpacity>
              <View>
                <Text style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>
                  Master Admin · {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
                <Text style={{ fontSize: 22, fontWeight: '700', color: C.white }}>School Overview</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TouchableOpacity
                onPress={() => onNavigate('admin-notifications')}
                style={styles.headerIconBtn}
              >
                <Text style={{ fontSize: 20 }}>🔔</Text>
                {unreadNotifCount > 0 ? (
                  <View style={styles.notifBadge}>
                    <Text style={{ color: C.white, fontSize: 10, fontWeight: '700' }}>
                      {unreadNotifCount > 99 ? '99+' : String(unreadNotifCount)}
                    </Text>
                  </View>
                ) : null}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => onNavigate('admin-profile')} style={styles.adminAvatar}>
                {currentUser?.profileImage ? (
                  <Image source={{ uri: currentUser.profileImage }} style={{ width: 42, height: 42, borderRadius: 13 }} />
                ) : (
                  <Text style={{ fontSize: 22 }}>👨‍💼</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>

          <View style={{ marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={styles.secTitle}>Today's Attendance</Text>
              <TouchableOpacity onPress={() => fetchAttendanceSnapshot(true)}>
                <Text style={{ fontSize: 12, color: C.teal }}>Refresh</Text>
              </TouchableOpacity>
            </View>

            {attendanceLoading ? (
              <View style={[styles.card, { alignItems: 'center', padding: 24 }]}>
                <LoadingSpinner message="Loading attendance snapshot..." size="small" />
              </View>
            ) : attendanceError ? (
              <View style={[styles.card, { padding: 16 }]}>
                <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load attendance</Text>
                <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{attendanceError}</Text>
                <TouchableOpacity
                  onPress={() => fetchAttendanceSnapshot(true)}
                  style={styles.retryBtn}
                >
                  <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attendanceMetricRow}>
                <AttendanceMetricCard
                  icon="👨‍🎓"
                  label="Total Students"
                  value={attendanceSnapshot.totalStudents}
                  color={C.gold}
                  onPress={() => openAttendancePanel('students', 'all')}
                />
                <AttendanceMetricCard
                  icon="✅"
                  label="Students Present"
                  value={attendanceSnapshot.presentStudents}
                  color="#34D399"
                  onPress={() => openAttendancePanel('students', 'present')}
                />
                <AttendanceMetricCard
                  icon="❌"
                  label="Students Absent"
                  value={attendanceSnapshot.absentStudents}
                  color={C.coral}
                  onPress={() => openAttendancePanel('students', 'absent')}
                />
                <AttendanceMetricCard
                  icon="👥"
                  label="Total Staff"
                  value={attendanceSnapshot.totalStaff}
                  color={C.purple}
                  onPress={() => openAttendancePanel('staff', 'all')}
                />
                <AttendanceMetricCard
                  icon="✅"
                  label="Staff Present"
                  value={attendanceSnapshot.presentStaff}
                  color={C.teal}
                  onPress={() => openAttendancePanel('staff', 'present')}
                />
                <AttendanceMetricCard
                  icon="❌"
                  label="Staff Absent"
                  value={attendanceSnapshot.absentStaff}
                  color={C.coral}
                  onPress={() => openAttendancePanel('staff', 'absent')}
                />
              </ScrollView>
            )}
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
            {statGrid.map((stat) => (
              <View key={stat.lbl} style={[styles.statCard, { borderTopColor: stat.color, borderTopWidth: 3 }]}>
                <Text style={{ fontSize: 20, marginBottom: 4 }}>{stat.icon}</Text>
                <Text style={{ fontSize: 17, fontWeight: '800', color: stat.color }}>{stat.val}</Text>
                <Text style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{stat.lbl}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          <Text style={styles.secTitle}>Manage</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
            {quickNav.map((item) => (
              <TouchableOpacity
                key={item.label}
                onPress={() => onNavigate(item.screen)}
                style={[styles.navCard, { borderColor: item.color + '44' }]}
              >
                <View style={[styles.navIcon, { backgroundColor: item.color + '22' }]}>
                  <Text style={{ fontSize: 22 }}>{item.icon}</Text>
                </View>
                <Text style={{ color: C.white, fontWeight: '700', fontSize: 13, flex: 1 }}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            onPress={handleDownloadAudit}
            disabled={auditLoading}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#1E293B', borderWidth: 1, borderColor: C.gold + '44', borderRadius: 14, paddingVertical: 14, marginBottom: 20, opacity: auditLoading ? 0.6 : 1 }}
          >
            {auditLoading ? (
              <ActivityIndicator size="small" color={C.gold} />
            ) : (
              <Icon name="download" size={18} color={C.gold} />
            )}
            <Text style={{ fontWeight: '700', fontSize: 14, color: C.gold }}>
              {auditLoading ? 'Generating Report...' : 'Download Master Audit Report'}
            </Text>
          </TouchableOpacity>

          <View style={{ marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <Text style={styles.secTitle}>📡 Live Staff Board</Text>
              {!liveBoardLoading && liveBoardRows.length > 0 ? (
                <TouchableOpacity onPress={() => setShowLiveBoardModal(true)}>
                  <Text style={{ fontSize: 12, color: C.teal, fontWeight: '700' }}>View All →</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {liveBoardLoading ? (
              <View style={[styles.card, { alignItems: 'center', padding: 24 }]}>
                <LoadingSpinner message="Loading live board..." size="small" />
              </View>
            ) : liveBoardError ? (
              <View style={[styles.card, { padding: 16 }]}>
                <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load live staff board</Text>
                <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>{liveBoardError}</Text>
              </View>
            ) : liveBoardPreviewRows.length === 0 ? (
              <View style={[styles.card, { alignItems: 'center', padding: 24 }]}>
                <Text style={{ fontSize: 22, marginBottom: 8 }}>📡</Text>
                <Text style={{ color: C.muted, fontSize: 13 }}>No class coverage data yet</Text>
              </View>
            ) : (
              <View style={styles.liveBoardCard}>
                {liveBoardPreviewRows.map((row, index) => (
                  <View
                    key={row.id}
                    style={[
                      styles.liveBoardRow,
                      index < liveBoardPreviewRows.length - 1 && styles.liveBoardRowDivider,
                      row.noTeacher && styles.liveBoardRowAlert,
                    ]}
                  >
                    <View style={[styles.liveBoardStatusDot, { backgroundColor: row.statusColor }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.liveBoardClassText}>{row.className}</Text>
                      <Text style={styles.liveBoardTeacherText}>{row.teacherName}</Text>
                      <Text style={styles.liveBoardSubjectText}>{row.subject}</Text>
                    </View>
                  </View>
                ))}
                <TouchableOpacity onPress={() => setShowLiveBoardModal(true)} style={styles.liveBoardViewAllBtn}>
                  <Text style={{ fontSize: 12, color: C.teal, fontWeight: '700' }}>View All →</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {locationMsg ? (
            <View style={{ backgroundColor: locationMsg.includes('Approved') ? '#34D39922' : locationMsg.includes('Rejected') ? C.gold + '22' : C.coral + '22', borderRadius: 10, padding: 10, marginBottom: 12 }}>
              <Text style={{ color: locationMsg.includes('Approved') ? '#34D399' : locationMsg.includes('Rejected') ? C.gold : C.coral, fontSize: 12, fontWeight: '600' }}>
                {locationMsg}
              </Text>
            </View>
          ) : null}

          {locationRequests.length > 0 ? (
            <View style={{ marginBottom: 20 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <Text style={styles.secTitle}>Location Change Requests</Text>
                <View style={{ backgroundColor: C.coral + '22', paddingVertical: 2, paddingHorizontal: 10, borderRadius: 50, borderWidth: 1, borderColor: C.coral + '44' }}>
                  <Text style={{ color: C.coral, fontSize: 12, fontWeight: '700' }}>{locationRequests.length}</Text>
                </View>
              </View>
              {locationRequests.map((request) => (
                <View key={request.id} style={[styles.card, { marginBottom: 10 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontWeight: '700', fontSize: 13, color: C.white }}>{request.studentName}</Text>
                      <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{request.className}</Text>
                    </View>
                    <View style={{ backgroundColor: C.teal + '22', paddingVertical: 2, paddingHorizontal: 10, borderRadius: 50 }}>
                      <Text style={{ color: C.teal, fontSize: 11, fontWeight: '600' }}>{request.route}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Text style={{ color: C.muted, fontSize: 11 }}>{request.oldLat?.toFixed(4)}, {request.oldLng?.toFixed(4)}</Text>
                    <Text style={{ color: C.gold, fontSize: 11 }}>-></Text>
                    <Text style={{ color: C.gold, fontSize: 11, fontWeight: '600' }}>{request.newLat?.toFixed(4)}, {request.newLng?.toFixed(4)}</Text>
                  </View>
                  <Text style={{ color: C.muted, fontSize: 11, marginBottom: 10 }}>Requested by: {request.requestedBy}</Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {approvingId === request.id ? (
                      <ActivityIndicator color="#34D399" />
                    ) : (
                      <TouchableOpacity onPress={() => handleApproveLocation(request)} style={{ backgroundColor: '#34D399', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10 }}>
                        <Text style={{ color: C.white, fontWeight: '700', fontSize: 12 }}>Approve</Text>
                      </TouchableOpacity>
                    )}
                    {rejectingId === request.id ? (
                      <ActivityIndicator color={C.coral} />
                    ) : (
                      <TouchableOpacity onPress={() => handleRejectLocation(request)} style={{ backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10 }}>
                        <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Reject</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <Text style={styles.secTitle}>🚌 Bus Summary</Text>
              <TouchableOpacity onPress={() => fetchBusSummaries(true)}>
                <Text style={{ fontSize: 12, color: C.teal }}>Refresh</Text>
              </TouchableOpacity>
            </View>

            {busSummaryLoading ? (
              <View style={[styles.card, { alignItems: 'center', padding: 24 }]}>
                <LoadingSpinner message="Loading bus summary..." size="small" />
              </View>
            ) : busSummaryError ? (
              <View style={[styles.card, { padding: 16 }]}>
                <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load bus summary</Text>
                <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{busSummaryError}</Text>
                <TouchableOpacity onPress={() => fetchBusSummaries(true)} style={styles.retryBtn}>
                  <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
                <View style={[styles.busRow, { backgroundColor: C.navyMid, borderBottomColor: C.border }]}>
                  <Text style={[styles.busCell, styles.busHeaderText, { flex: 1.2 }]}>Bus Number</Text>
                  <Text style={[styles.busCell, styles.busHeaderText]}>Students Allotted</Text>
                  <Text style={[styles.busCell, styles.busHeaderText]}>Boarded Today</Text>
                  <Text style={[styles.busCell, styles.busHeaderText]}>Absent</Text>
                </View>

                {busSummaries.length === 0 ? (
                  <View style={{ padding: 20, alignItems: 'center' }}>
                    <Text style={{ color: C.muted, fontSize: 13 }}>No buses found yet.</Text>
                  </View>
                ) : (
                  <>
                    {busSummaries.map((bus, index) => (
                      <TouchableOpacity
                        key={bus.id}
                        onPress={() => setSelectedBusSummary(bus)}
                        style={[styles.busRow, { borderBottomColor: index === busSummaries.length - 1 ? C.border : C.border }]}
                      >
                        <Text style={[styles.busCell, { flex: 1.2, color: C.white, fontWeight: '700' }]}>{bus.busNumber || '-'}</Text>
                        <Text style={styles.busCell}>{bus.studentsAllotted}</Text>
                        <Text style={[styles.busCell, { color: C.teal, fontWeight: '700' }]}>{bus.boardedToday}</Text>
                        <Text style={[styles.busCell, { color: C.coral, fontWeight: '700' }]}>{bus.absent}</Text>
                      </TouchableOpacity>
                    ))}

                    <View style={[styles.busRow, { backgroundColor: C.navyMid, borderTopWidth: 1, borderTopColor: C.border }]}>
                      <Text style={[styles.busCell, { flex: 1.2, color: C.white, fontWeight: '800' }]}>Total</Text>
                      <Text style={[styles.busCell, { color: C.white, fontWeight: '800' }]}>
                        {busSummaries.reduce((sum, bus) => sum + bus.studentsAllotted, 0)}
                      </Text>
                      <Text style={[styles.busCell, { color: C.teal, fontWeight: '800' }]}>
                        {busSummaries.reduce((sum, bus) => sum + bus.boardedToday, 0)}
                      </Text>
                      <Text style={[styles.busCell, { color: C.coral, fontWeight: '800' }]}>
                        {busSummaries.reduce((sum, bus) => sum + bus.absent, 0)}
                      </Text>
                    </View>
                  </>
                )}
              </View>
            )}
          </View>

          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 16, marginBottom: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center' }}>
              Attendance analytics will appear here as teachers record daily attendance.
            </Text>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <Text style={styles.secTitle}>Leave Requests</Text>
            <TouchableOpacity onPress={() => onNavigate('admin-leaves')}>
              <Text style={{ fontSize: 12, color: C.teal }}>View All</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => onNavigate('admin-leaves')} style={[styles.card, { marginBottom: 20, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
            <Text style={{ fontSize: 28 }}>📅</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', fontSize: 14, color: C.white }}>Staff Leave Applications</Text>
              <Text style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                Tap to review and approve or reject pending leave requests.
              </Text>
            </View>
            <Text style={{ fontSize: 16, color: C.muted }}>›</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <SideDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentUser={currentUser}
        onNavigate={(screen) => {
          setDrawerOpen(false);
          onNavigate(screen);
        }}
        onLogout={onLogout}
        role="principal"
        currentScreen={currentScreen}
      />

      <SheetModal
        visible={!!attendancePanel && attendancePanel.type === 'students'}
        onClose={closeAttendancePanel}
        title="Student Attendance Snapshot"
        subtitle={`${attendanceSnapshot.totalStudents} students · ${attendanceSnapshot.presentStudents} present · ${attendanceSnapshot.absentStudents} absent`}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <SectionChip color={C.gold} label={`Total ${attendanceSnapshot.totalStudents}`} />
            <SectionChip color="#34D399" label={`Present ${attendanceSnapshot.presentStudents}`} />
            <SectionChip color={C.coral} label={`Absent ${attendanceSnapshot.absentStudents}`} />
          </View>

          {studentPanelRows.map((item) => (
            <TouchableOpacity key={item.classId} onPress={() => handleOpenClassDetail(item)} style={styles.summaryRowCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryRowTitle}>{item.className}</Text>
                <Text style={styles.summaryRowMeta}>{item.totalStudents} students</Text>
              </View>
              <View style={styles.summaryCounts}>
                <Text style={[styles.summaryCountText, { color: '#34D399' }]}>{item.presentCount} P</Text>
                <Text style={[styles.summaryCountText, { color: C.coral }]}>{item.absentCount} A</Text>
              </View>
              <Icon name="arrow" size={14} color={C.muted} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SheetModal>

      <SheetModal
        visible={!!attendancePanel && attendancePanel.type === 'staff'}
        onClose={closeAttendancePanel}
        title="Staff Attendance Snapshot"
        subtitle={`${attendanceSnapshot.totalStaff} staff · ${attendanceSnapshot.presentStaff} present · ${attendanceSnapshot.absentStaff} absent`}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <SectionChip color={C.purple} label={`Total ${attendanceSnapshot.totalStaff}`} />
            <SectionChip color={C.teal} label={`Present ${attendanceSnapshot.presentStaff}`} />
            <SectionChip color={C.coral} label={`Absent ${attendanceSnapshot.absentStaff}`} />
          </View>

          {staffPanelRows.map((item) => (
            <TouchableOpacity key={item.roleId} onPress={() => handleOpenStaffProfile(item)} style={styles.summaryRowCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryRowTitle}>{item.name}</Text>
                <Text style={styles.summaryRowMeta}>{getStaffDescriptor(item)}</Text>
              </View>
              <SectionChip color={(attendanceSnapshot.staffPresent || []).some((staff) => staff.roleId === item.roleId) ? C.teal : C.coral} label={(attendanceSnapshot.staffPresent || []).some((staff) => staff.roleId === item.roleId) ? 'Present' : 'Absent'} />
              <Icon name="arrow" size={14} color={C.muted} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SheetModal>

      <SheetModal
        visible={!!selectedAttendanceClass}
        onClose={() => {
          setSelectedAttendanceClass(null);
          setAttendanceClassDetails(null);
          setAttendanceClassError('');
        }}
        title={selectedAttendanceClass?.className || 'Class Attendance'}
        subtitle={
          attendanceClassDetails
            ? `${attendanceClassDetails.presentStudents.length} present · ${attendanceClassDetails.absentStudents.length} absent`
            : 'Loading class attendance'
        }
      >
        {attendanceClassLoading ? (
          <View style={{ paddingVertical: 24 }}>
            <LoadingSpinner message="Loading class details..." size="small" />
          </View>
        ) : attendanceClassError ? (
          <View style={[styles.card, { padding: 16 }]}>
            <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load class attendance</Text>
            <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{attendanceClassError}</Text>
            <TouchableOpacity onPress={() => handleOpenClassDetail(selectedAttendanceClass)} style={styles.retryBtn}>
              <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ marginBottom: 18 }}>
              <Text style={styles.detailTitle}>Present Students</Text>
              {attendanceClassDetails?.presentStudents.length ? (
                attendanceClassDetails.presentStudents.map((student) => (
                  <TouchableOpacity key={`present-${student.id}`} onPress={() => handleOpenStudentProfile(student)} style={styles.detailRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailName}>{student.displayName}</Text>
                      <Text style={styles.detailMeta}>{student.displayClass} · {student.displayId}</Text>
                    </View>
                    <SectionChip color="#34D399" label="Present" />
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.detailEmpty}>No present students found.</Text>
              )}
            </View>

            <View style={{ marginBottom: 8 }}>
              <Text style={styles.detailTitle}>Absent Students</Text>
              {attendanceClassDetails?.absentStudents.length ? (
                attendanceClassDetails.absentStudents.map((student) => (
                  <TouchableOpacity key={`absent-${student.id}`} onPress={() => handleOpenStudentProfile(student)} style={styles.detailRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailName}>{student.displayName}</Text>
                      <Text style={styles.detailMeta}>{student.displayClass} · {student.displayId}</Text>
                    </View>
                    <SectionChip color={C.coral} label="Absent" />
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.detailEmpty}>No absent students found.</Text>
              )}
            </View>
          </ScrollView>
        )}
      </SheetModal>

      <SheetModal
        visible={!!studentProfileTarget}
        onClose={closeStudentProfile}
        title={studentProfileTarget?.displayName || studentProfileTarget?.name || studentProfileTarget?.studentName || 'Student Profile'}
        subtitle={
          studentProfileTarget
            ? `${studentProfileTarget.displayClass || formatClassLabel(getStudentClass(studentProfileTarget))} · ${studentProfileTarget.displayId || getStudentId(studentProfileTarget) || getStudentRecordKey(studentProfileTarget)}`
            : ''
        }
      >
        {studentProfileLoading ? (
          <View style={{ paddingVertical: 24 }}>
            <LoadingSpinner message="Loading student profile..." size="small" />
          </View>
        ) : studentProfileError ? (
          <View style={[styles.card, { padding: 16 }]}>
            <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load student profile</Text>
            <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{studentProfileError}</Text>
            <TouchableOpacity onPress={() => handleOpenStudentProfile(studentProfileTarget)} style={styles.retryBtn}>
              <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : studentProfile ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={[styles.heroCard, { borderColor: C.teal + '44' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <View style={[styles.heroAvatar, { backgroundColor: C.teal + '22', borderColor: C.teal + '44' }]}>
                  <Text style={{ color: C.teal, fontWeight: '800', fontSize: 18 }}>
                    {(studentProfileTarget?.displayName || getStudentName(studentProfileTarget)).slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroName}>{studentProfileTarget?.displayName || getStudentName(studentProfileTarget)}</Text>
                  <Text style={styles.heroMeta}>{studentProfileTarget?.displayClass || formatClassLabel(getStudentClass(studentProfileTarget))}</Text>
                  <Text style={styles.heroMeta}>
                    ID: {studentProfileTarget?.displayId || getStudentId(studentProfileTarget) || getStudentRecordKey(studentProfileTarget)}
                  </Text>
                </View>
                <DonutRing pct={studentProfile.overallPct} color={studentProfile.overallPct >= 75 ? C.teal : C.coral} size={78} stroke={8} label={`${studentProfile.overallPct}%`} sublabel="Overall" />
              </View>
            </View>

            <View style={styles.analyticsGrid}>
              <View style={styles.analyticsMiniCard}>
                <Text style={[styles.analyticsMiniValue, { color: '#34D399' }]}>{studentProfile.totals.present}</Text>
                <Text style={styles.analyticsMiniLabel}>Present Days</Text>
              </View>
              <View style={styles.analyticsMiniCard}>
                <Text style={[styles.analyticsMiniValue, { color: C.coral }]}>{studentProfile.totals.absent}</Text>
                <Text style={styles.analyticsMiniLabel}>Absent Days</Text>
              </View>
              <View style={styles.analyticsMiniCard}>
                <Text style={[styles.analyticsMiniValue, { color: C.gold }]}>{studentProfile.totals.leave}</Text>
                <Text style={styles.analyticsMiniLabel}>Leave Days</Text>
              </View>
            </View>

            <View style={styles.analyticsCard}>
              <Text style={styles.analyticsTitle}>Attendance Analytics</Text>
              <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center', marginBottom: 18 }}>
                <AttendancePie present={studentProfile.totals.present} absent={studentProfile.totals.absent} />
                <View style={{ flex: 1 }}>
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: '#34D399' }]} />
                    <Text style={styles.legendText}>Present · {studentProfile.totals.present}</Text>
                  </View>
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: C.coral }]} />
                    <Text style={styles.legendText}>Absent · {studentProfile.totals.absent}</Text>
                  </View>
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: C.gold }]} />
                    <Text style={styles.legendText}>Leave · {studentProfile.totals.leave}</Text>
                  </View>
                </View>
              </View>

              <Text style={styles.analyticsSubTitle}>Monthly Attendance %</Text>
              <MonthlyBarChart months={studentProfile.monthSummaries.slice().reverse()} color={C.teal} />

              <Text style={styles.analyticsSubTitle}>Trend Line</Text>
              <TrendLineChart months={studentProfile.monthSummaries.slice().reverse()} color={C.teal} />
            </View>

            <View style={styles.analyticsCard}>
              <Text style={styles.analyticsTitle}>Monthly Calendars</Text>
              {studentProfile.monthSummaries.map((monthData) => (
                <CalendarMonthCard key={monthData.month} monthData={monthData} />
              ))}
            </View>
          </ScrollView>
        ) : null}
      </SheetModal>

      <SheetModal
        visible={!!staffProfileTarget}
        onClose={closeStaffProfile}
        title={staffProfileTarget?.name || 'Staff Profile'}
        subtitle={staffProfileTarget ? `${getStaffDescriptor(staffProfileTarget)} · ${staffProfileTarget.roleId}` : ''}
      >
        {staffProfileLoading ? (
          <View style={{ paddingVertical: 24 }}>
            <LoadingSpinner message="Loading staff profile..." size="small" />
          </View>
        ) : staffProfileError ? (
          <View style={[styles.card, { padding: 16 }]}>
            <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load staff profile</Text>
            <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 }}>{staffProfileError}</Text>
            <TouchableOpacity onPress={() => handleOpenStaffProfile(staffProfileTarget)} style={styles.retryBtn}>
              <Text style={{ color: C.coral, fontWeight: '700', fontSize: 12 }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : staffProfile ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={[styles.heroCard, { borderColor: C.purple + '44' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <View style={[styles.heroAvatar, { backgroundColor: C.purple + '22', borderColor: C.purple + '44' }]}>
                  <Text style={{ color: C.purple, fontWeight: '800', fontSize: 18 }}>
                    {(staffProfileTarget?.name || 'S').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroName}>{staffProfileTarget?.name}</Text>
                  <Text style={styles.heroMeta}>{getStaffDescriptor(staffProfileTarget)}</Text>
                  <Text style={styles.heroMeta}>ID: {staffProfileTarget?.roleId}</Text>
                </View>
                <DonutRing pct={staffProfile.overallPct} color={staffProfile.overallPct >= 75 ? C.teal : C.coral} size={78} stroke={8} label={`${staffProfile.overallPct}%`} sublabel="Overall" />
              </View>
            </View>

            <View style={styles.analyticsGrid}>
              <View style={styles.analyticsMiniCard}>
                <Text style={[styles.analyticsMiniValue, { color: '#34D399' }]}>{staffProfile.totals.present}</Text>
                <Text style={styles.analyticsMiniLabel}>Present Days</Text>
              </View>
              <View style={styles.analyticsMiniCard}>
                <Text style={[styles.analyticsMiniValue, { color: C.coral }]}>{staffProfile.totals.absent}</Text>
                <Text style={styles.analyticsMiniLabel}>Absent Days</Text>
              </View>
              <View style={styles.analyticsMiniCard}>
                <Text style={[styles.analyticsMiniValue, { color: C.gold }]}>{staffProfileTarget?.lopDays || 0}</Text>
                <Text style={styles.analyticsMiniLabel}>LOP Days</Text>
              </View>
            </View>

            <View style={styles.analyticsCard}>
              <Text style={styles.analyticsTitle}>Attendance Analytics</Text>
              <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center', marginBottom: 18 }}>
                <AttendancePie present={staffProfile.totals.present} absent={staffProfile.totals.absent} />
                <View style={{ flex: 1 }}>
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: '#34D399' }]} />
                    <Text style={styles.legendText}>Present · {staffProfile.totals.present}</Text>
                  </View>
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: C.coral }]} />
                    <Text style={styles.legendText}>Absent · {staffProfile.totals.absent}</Text>
                  </View>
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: C.gold }]} />
                    <Text style={styles.legendText}>Role · {staffProfileTarget?.role || 'Staff'}</Text>
                  </View>
                </View>
              </View>

              <Text style={styles.analyticsSubTitle}>Monthly Attendance %</Text>
              <MonthlyBarChart months={staffProfile.monthSummaries.slice().reverse()} color={C.purple} />

              <Text style={styles.analyticsSubTitle}>Trend Line</Text>
              <TrendLineChart months={staffProfile.monthSummaries.slice().reverse()} color={C.purple} />
            </View>

            <View style={styles.analyticsCard}>
              <Text style={styles.analyticsTitle}>Payroll Impact</Text>
              <View style={styles.payrollRow}>
                <Text style={styles.payrollLabel}>Days Present</Text>
                <Text style={[styles.payrollValue, { color: '#34D399' }]}>
                  {staffProfileTarget?.fullDays || 0}
                </Text>
              </View>
              <View style={styles.payrollRow}>
                <Text style={styles.payrollLabel}>Absent Days</Text>
                <Text style={[styles.payrollValue, { color: C.coral }]}>
                  {staffProfileTarget?.absentDays || 0}
                </Text>
              </View>
              <View style={styles.payrollRow}>
                <Text style={styles.payrollLabel}>Deductions</Text>
                <Text style={[styles.payrollValue, { color: C.coral }]}>
                  {formatMoney(staffProfileTarget?.totalDeductions || 0)}
                </Text>
              </View>
              <View style={styles.payrollRow}>
                <Text style={styles.payrollLabel}>Net Payable</Text>
                <Text style={[styles.payrollValue, { color: '#34D399' }]}>
                  {formatMoney(staffProfileTarget?.net || 0)}
                </Text>
              </View>
            </View>

            <View style={styles.analyticsCard}>
              <Text style={styles.analyticsTitle}>Monthly Calendars</Text>
              {staffProfile.monthSummaries.map((monthData) => (
                <CalendarMonthCard key={monthData.month} monthData={monthData} />
              ))}
            </View>
          </ScrollView>
        ) : null}
      </SheetModal>

      <SheetModal
        visible={showLiveBoardModal}
        onClose={() => setShowLiveBoardModal(false)}
        title="📡 Live Staff Board"
        subtitle={`${liveBoardRows.length} classes · ${liveBoardActiveCount} active · ${liveBoardNoTeacherCount} without teacher`}
      >
        {liveBoardLoading ? (
          <View style={{ paddingVertical: 24 }}>
            <LoadingSpinner message="Loading live board..." size="small" />
          </View>
        ) : liveBoardError ? (
          <View style={[styles.card, { padding: 16 }]}>
            <Text style={{ color: C.coral, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>Failed to load live staff board</Text>
            <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>{liveBoardError}</Text>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false}>
            {liveBoardRows.map((row) => (
              <View key={`full-${row.id}`} style={[styles.liveBoardFullRow, row.noTeacher && styles.liveBoardFullRowAlert]}>
                <View style={{ flex: 1.15 }}>
                  <Text style={styles.liveBoardClassText}>{row.className}</Text>
                </View>
                <View style={{ flex: 1.4 }}>
                  <Text style={styles.liveBoardTeacherText}>{row.teacherName}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.liveBoardSubjectText}>{row.subject}</Text>
                </View>
                <View style={styles.liveBoardStatusWrap}>
                  <View style={[styles.liveBoardStatusDot, { backgroundColor: row.statusColor, marginRight: 8 }]} />
                  <Text style={[styles.liveBoardStatusText, { color: row.statusColor }]}>{row.statusLabel}</Text>
                </View>
              </View>
            ))}

            <View style={styles.liveBoardSummaryBar}>
              <Text style={{ color: '#34D399', fontSize: 12, fontWeight: '700' }}>🟢 Active: {liveBoardActiveCount}</Text>
              <Text style={{ color: C.coral, fontSize: 12, fontWeight: '700' }}>🔴 No Teacher: {liveBoardNoTeacherCount}</Text>
            </View>
          </ScrollView>
        )}
      </SheetModal>

      <Modal visible={!!selectedBusSummary} transparent animationType="slide" onRequestClose={() => setSelectedBusSummary(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.sheetContent}>
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={styles.sheetTitle}>🚌 {selectedBusSummary?.busNumber || 'Bus Detail'}</Text>
                <Text style={styles.sheetSubtitle}>
                  {selectedBusSummary
                    ? `${selectedBusSummary.studentsAllotted} allotted · ${selectedBusSummary.boardedToday} boarded · ${selectedBusSummary.absent} absent`
                    : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedBusSummary(null)} style={styles.sheetCloseBtn}>
                <Icon name="x" size={16} color={C.muted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ marginBottom: 18 }}>
                <Text style={styles.detailTitle}>Boarded</Text>
                {selectedBusSummary?.boardedStudents.length ? (
                  selectedBusSummary.boardedStudents.map((student) => (
                    <View key={`boarded-${student.studentId}`} style={styles.detailRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailName}>{student.studentName}</Text>
                        <Text style={styles.detailMeta}>{student.className}</Text>
                      </View>
                      <Text style={[styles.detailMeta, { color: C.teal, fontWeight: '700' }]}>
                        {formatScanTimestamp(student.scanTime)}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.detailEmpty}>No boarded students yet.</Text>
                )}
              </View>

              <View style={{ marginBottom: 18 }}>
                <Text style={styles.detailTitle}>Not Boarded</Text>
                {selectedBusSummary?.notBoardedStudents.length ? (
                  selectedBusSummary.notBoardedStudents.map((student) => (
                    <View key={`absent-${student.studentId}`} style={styles.detailRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailName}>{student.studentName}</Text>
                        <Text style={styles.detailMeta}>{student.className}</Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.detailEmpty}>No absent students right now.</Text>
                )}
              </View>

              <View style={{ marginBottom: 18 }}>
                <Text style={styles.detailTitle}>On Leave</Text>
                {selectedBusSummary?.onLeaveStudents.length ? (
                  selectedBusSummary.onLeaveStudents.map((student) => (
                    <View key={`leave-${student.studentId}`} style={styles.detailRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailName}>{student.studentName}</Text>
                        <Text style={styles.detailMeta}>{student.className}</Text>
                      </View>
                      <View style={{ backgroundColor: C.gold + '22', borderRadius: 99, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.gold + '44' }}>
                        <Text style={{ color: C.gold, fontSize: 11, fontWeight: '700' }}>Skip Stop</Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.detailEmpty}>No approved leave students today.</Text>
                )}
              </View>

              <View style={{ marginBottom: 8 }}>
                <Text style={styles.detailTitle}>Recent Scans</Text>
                {selectedBusSummary?.recentScans.length ? (
                  selectedBusSummary.recentScans.map((scan) => (
                    <View key={`scan-${scan.id}`} style={styles.detailRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailName}>{scan.studentName}</Text>
                        <Text style={styles.detailMeta}>{scan.className}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={[styles.detailMeta, { color: scan.type === 'board' ? C.teal : C.gold, fontWeight: '700' }]}>
                          {scan.type === 'board' ? 'Boarded' : 'Arrived'}
                        </Text>
                        <Text style={styles.detailMeta}>{formatScanTimestamp(scan.timestamp)}</Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.detailEmpty}>No scans recorded today.</Text>
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Toast {...toast} onHide={() => setToast((value) => ({ ...value, visible: false }))} />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.navy,
    ...(Platform.OS === 'web'
      ? {
          maxWidth: 1000,
          alignSelf: 'center',
          width: '100%',
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderColor: C.border,
        }
      : {}),
  },
  drawerBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.card,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.border,
    flexShrink: 0,
    marginTop: 2,
  },
  headerIconBtn: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: C.coral,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 2,
    borderColor: C.navy,
  },
  adminAvatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.purple + '22',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.purple + '44',
  },
  statCard: {
    width: '31%',
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 14,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  secTitle: {
    fontWeight: '700',
    fontSize: 15,
    color: C.white,
    marginBottom: 14,
  },
  navCard: {
    width: '48%',
    backgroundColor: C.card,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  navIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  card: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 14,
  },
  retryBtn: {
    alignSelf: 'flex-start',
    backgroundColor: C.coral + '22',
    borderWidth: 1,
    borderColor: C.coral + '44',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  attendanceMetricRow: {
    paddingRight: 10,
    gap: 10,
  },
  attendanceMetricCard: {
    width: 128,
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
  },
  attendanceMetricIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  attendanceMetricValue: {
    fontSize: 24,
    fontWeight: '900',
    marginBottom: 4,
  },
  attendanceMetricLabel: {
    color: C.muted,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
  liveBoardCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    overflow: 'hidden',
  },
  liveBoardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  liveBoardRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  liveBoardRowAlert: {
    backgroundColor: C.coral + '10',
  },
  liveBoardStatusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 5,
  },
  liveBoardClassText: {
    color: C.white,
    fontSize: 13,
    fontWeight: '700',
  },
  liveBoardTeacherText: {
    color: C.white,
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  liveBoardSubjectText: {
    color: C.muted,
    fontSize: 11,
    marginTop: 3,
  },
  liveBoardViewAllBtn: {
    alignSelf: 'flex-end',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  liveBoardFullRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 8,
  },
  liveBoardFullRowAlert: {
    borderColor: C.coral + '55',
    backgroundColor: C.coral + '12',
  },
  liveBoardStatusWrap: {
    minWidth: 96,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  liveBoardStatusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  liveBoardSummaryBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: C.navyMid,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 8,
  },
  busRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
  },
  busCell: {
    flex: 1,
    color: C.muted,
    fontSize: 11,
    textAlign: 'center',
  },
  busHeaderText: {
    color: C.white,
    fontWeight: '700',
    fontSize: 11,
  },
  detailTitle: {
    color: C.white,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 8,
    gap: 10,
  },
  detailName: {
    color: C.white,
    fontSize: 13,
    fontWeight: '700',
  },
  detailMeta: {
    color: C.muted,
    fontSize: 11,
    marginTop: 2,
  },
  detailEmpty: {
    color: C.muted,
    fontSize: 12,
    marginBottom: 4,
  },
  progressTrack: {
    flex: 1,
    height: 6,
    backgroundColor: C.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: C.navy,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    maxHeight: '88%',
    borderWidth: 1,
    borderColor: C.border,
    borderBottomWidth: 0,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  sheetTitle: {
    color: C.white,
    fontSize: 18,
    fontWeight: '800',
  },
  sheetSubtitle: {
    color: C.muted,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 18,
  },
  sheetCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionChip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 99,
    borderWidth: 1,
  },
  summaryRowCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  summaryRowTitle: {
    color: C.white,
    fontSize: 14,
    fontWeight: '700',
  },
  summaryRowMeta: {
    color: C.muted,
    fontSize: 11,
    marginTop: 4,
  },
  summaryCounts: {
    alignItems: 'flex-end',
    gap: 4,
    marginRight: 2,
  },
  summaryCountText: {
    fontSize: 12,
    fontWeight: '800',
  },
  heroCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
  },
  heroAvatar: {
    width: 58,
    height: 58,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroName: {
    color: C.white,
    fontSize: 17,
    fontWeight: '800',
  },
  heroMeta: {
    color: C.muted,
    fontSize: 12,
    marginTop: 3,
  },
  analyticsGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  analyticsMiniCard: {
    flex: 1,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  analyticsMiniValue: {
    fontSize: 20,
    fontWeight: '800',
  },
  analyticsMiniLabel: {
    color: C.muted,
    fontSize: 10,
    marginTop: 4,
  },
  analyticsCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
  },
  analyticsTitle: {
    color: C.white,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 14,
  },
  analyticsSubTitle: {
    color: C.white,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
    marginTop: 4,
  },
  pieCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    color: C.muted,
    fontSize: 12,
  },
  barChartWrap: {
    marginBottom: 10,
  },
  barChart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    height: 140,
    paddingTop: 8,
  },
  barChartCol: {
    flex: 1,
    alignItems: 'center',
  },
  barChartValue: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 6,
  },
  barTrack: {
    height: 96,
    width: 18,
    borderRadius: 9,
    backgroundColor: C.navyMid,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    marginBottom: 8,
  },
  barFill: {
    width: '100%',
    borderRadius: 9,
  },
  barChartLabel: {
    color: C.muted,
    fontSize: 10,
  },
  trendWrap: {
    backgroundColor: C.navyMid,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 6,
  },
  trendLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -2,
  },
  trendLabelText: {
    color: C.muted,
    fontSize: 10,
  },
  calendarCard: {
    backgroundColor: C.navyMid,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    padding: 12,
    marginBottom: 12,
  },
  calendarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  calendarTitle: {
    color: C.white,
    fontSize: 13,
    fontWeight: '700',
  },
  calendarWeekRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  calendarWeekLabel: {
    width: `${100 / 7}%`,
    color: C.muted,
    fontSize: 10,
    textAlign: 'center',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarCellBlank: {
    width: `${100 / 7}%`,
    height: 44,
  },
  calendarCell: {
    width: `${100 / 7}%`,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    paddingTop: 5,
    alignItems: 'center',
    marginBottom: 6,
  },
  calendarCellSunday: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  calendarDayText: {
    color: C.white,
    fontSize: 11,
    fontWeight: '700',
  },
  calendarStatusText: {
    fontSize: 9,
    marginTop: 3,
    fontWeight: '700',
  },
  payrollRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  payrollLabel: {
    color: C.muted,
    fontSize: 12,
  },
  payrollValue: {
    fontSize: 13,
    fontWeight: '800',
  },
});
