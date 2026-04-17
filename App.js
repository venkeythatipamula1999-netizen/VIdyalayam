import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Platform, SafeAreaView, StatusBar, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C } from './src/theme/colors';
import { S } from './src/theme/styles';
import Icon from './src/components/Icon';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useGlobalErrorListener } from './src/hooks/useGlobalErrorListener';
import { setErrorReporterUser, clearErrorReporterUser } from './src/services/errorReporter';
import { registerForPushNotifications } from './src/services/notifications';
import OfflineBanner from './src/components/OfflineBanner';

import WelcomeScreen from './src/screens/onboarding/WelcomeScreen';
import SchoolSplashScreen from './src/screens/onboarding/SchoolSplashScreen';
import SplashScreen from './src/screens/auth/SplashScreen';
import SplashIntroScreen from './src/screens/auth/SplashIntroScreen';
import LoginScreen from './src/screens/auth/LoginScreen';
import ParentLoginScreen from './src/screens/auth/ParentLoginScreen';
import ParentPortalScreen from './src/screens/auth/ParentPortalScreen';
import SignupScreen from './src/screens/auth/SignupScreen';
import ParentDashboard from './src/screens/parent/ParentDashboard';
import AttendanceScreen from './src/screens/parent/AttendanceScreen';
import MarksScreen from './src/screens/parent/MarksScreen';
import BusScreen from './src/screens/parent/BusScreen';
import NotificationsScreen from './src/screens/parent/NotificationsScreen';
import FeeScreen from './src/screens/parent/FeeScreen';
import LeaveScreen from './src/screens/parent/LeaveScreen';
import DigitalFolder from './src/screens/parent/DigitalFolder';
import ActivitiesScreen from './src/screens/parent/ActivitiesScreen';
import ExploreScreen from './src/screens/ExploreScreen';
import ContactScreen from './src/screens/ContactScreen';
import TeacherDashboard from './src/screens/teacher/TeacherDashboard';
import TeacherAttendance from './src/screens/teacher/TeacherAttendance';
import TeacherScheduleScreen from './src/screens/teacher/TeacherScheduleScreen';
import TeacherBusMonitor from './src/screens/teacher/TeacherBusMonitor';
import TeacherAlertsScreen from './src/screens/teacher/TeacherAlertsScreen';
import TeacherPersonalScreen from './src/screens/teacher/TeacherPersonalScreen';
import TeacherProfile from './src/screens/teacher/TeacherProfile';
import TeacherSendDocument from './src/screens/teacher/TeacherSendDocument';
import ClassMarksViewScreen from './src/screens/teacher/ClassMarksViewScreen';
import CCEHomeScreen from './src/screens/cce/CCEHomeScreen';
import CCEMarkEntryScreen from './src/screens/cce/CCEMarkEntryScreen';
import CCEHalfYearReportScreen from './src/screens/cce/CCEHalfYearReportScreen';
import CCEFinalReportScreen from './src/screens/cce/CCEFinalReportScreen';
import AdminOverview from './src/screens/admin/AdminOverview';
import AdminSendDocument from './src/screens/admin/AdminSendDocument';
import AdminStudents from './src/screens/admin/AdminStudents';
import AdminUsers from './src/screens/admin/AdminUsers';
import StudentImport from './src/screens/admin/StudentImport';
import StudentList from './src/screens/admin/StudentList';
import AdminClasses from './src/screens/admin/AdminClasses';
import AdminBuses from './src/screens/admin/AdminBuses';
import AdminReports from './src/screens/admin/AdminReports';
import AdminAlerts from './src/screens/admin/AdminAlerts';
import AdminNotificationsScreen from './src/screens/admin/AdminNotificationsScreen';
import AdminActivities from './src/screens/admin/AdminActivities';
import AdminSettings from './src/screens/admin/AdminSettings';
import AdminStudentQR from './src/screens/admin/AdminStudentQR';
import AdminLeaveScreen from './src/screens/admin/AdminLeaveScreen';
import AdminFeeScreen from './src/screens/admin/AdminFeeScreen';
import AdminSalaryScreen from './src/screens/admin/AdminSalaryScreen';
import AdminPromotion from './src/screens/admin/AdminPromotion';
import AdminFeeStatus from './src/screens/admin/AdminFeeStatus';
import AdminProfile from './src/screens/admin/AdminProfile';
import DriverDashboard from './src/screens/driver/DriverDashboard';
import DriverScans from './src/screens/driver/DriverScans';
import DriverDuration from './src/screens/driver/DriverDuration';
import DriverProfile from './src/screens/driver/DriverProfile';
import DriverStudentLocations from './src/screens/driver/DriverStudentLocations';
import DriverLeave from './src/screens/driver/DriverLeave';
import DriverProximityAlerts from './src/screens/driver/DriverProximityAlerts';
import CleanerDashboard from './src/screens/cleaner/CleanerDashboard';
import CleanerScanner from './src/screens/cleaner/CleanerScanner';
import CleanerDuration from './src/screens/cleaner/CleanerDuration';
import CleanerAlerts from './src/screens/cleaner/CleanerAlerts';
import CleanerProfile from './src/screens/cleaner/CleanerProfile';
import CleanerLeave from './src/screens/cleaner/CleanerLeave';
import CompleteProfileScreen from './src/screens/auth/CompleteProfileScreen';
import { STUDENTS_INIT as STUDENTS_INIT_CLEANER } from './src/data/cleaner';

export default function App() {
  useGlobalErrorListener();

  const [screen, setScreen] = useState('loading');
  const [role, setRole] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [cleanerStudents, setCleanerStudents] = useState(STUDENTS_INIT_CLEANER);
  const [cleanerNotifs, setCleanerNotifs] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (currentUser) {
      setErrorReporterUser(currentUser);
    } else {
      clearErrorReporterUser();
    }
  }, [currentUser]);

  useEffect(() => {
    global.__onAuthExpired = () => {
      setCurrentUser(null);
      setRole(null);
      navigate('school-splash');
      setTimeout(() => {
        alert('Your session has expired. Please log in again.');
      }, 300);
    };

    return () => {
      global.__onAuthExpired = null;
    };
  }, []);

  useEffect(() => {
    const checkOnboarding = async () => {
      try {
        const schoolId = await AsyncStorage.getItem('schoolId');
        const token = await AsyncStorage.getItem('authToken');
        const storedUser = await AsyncStorage.getItem('userData');

        if (!schoolId) {
          setScreen('welcome');
          return;
        }

        if (!token || !storedUser) {
          setScreen('school-splash');
          return;
        }

        try {
          const base64Part = token.split('.')[1];
          if (base64Part) {
            const padded = base64Part.replace(/-/g, '+').replace(/_/g, '/');
            const decoded = typeof atob === 'function' ? atob(padded) : null;
            if (decoded) {
              const payload = JSON.parse(decoded);
              if (payload.exp && payload.exp * 1000 < Date.now()) {
                await AsyncStorage.multiRemove(['authToken', 'userData']);
                setScreen('school-splash');
                return;
              }
            }
          }
        } catch {
          console.warn('[Auth] JWT decode failed, proceeding with stored session');
        }

        const userData = JSON.parse(storedUser);
        setCurrentUser(userData);
        setRole(userData.role);
        setScreen('school-splash');
        console.log('[Auth] Session ready for role:', userData.role);
      } catch (e) {
        await AsyncStorage.multiRemove(['authToken', 'schoolId', 'userData']);
        setScreen('welcome');
      }
    };

    checkOnboarding();
  }, []);

  const [navParams, setNavParams] = useState({});
  const navigate = useCallback((s, params = {}) => {
    setNavParams(params);
    setScreen(s);
    if (scrollRef.current && scrollRef.current.scrollTo) {
      scrollRef.current.scrollTo({ y: 0, animated: false });
    }
  }, []);

  const adminScreens = useMemo(() => ['admin-home', 'admin-users', 'admin-classes', 'admin-buses', 'admin-reports', 'admin-alerts', 'admin-notifications', 'admin-settings', 'admin-activities', 'admin-leaves', 'admin-fees', 'admin-salary', 'admin-profile', 'admin-promotion', 'admin-fee-status', 'admin-send-document'], []);

  const navigateToDashboard = useCallback((userRole) => {
    if (userRole === 'principal') navigate('admin-home');
    else if (userRole === 'driver') navigate('driver-home');
    else if (userRole === 'cleaner') navigate('cleaner-home');
    else if (userRole === 'teacher' || userRole === 'staff') navigate('teacher-home');
    else navigate('parent-home');
  }, [navigate]);

  const handleLoginSuccess = useCallback((userData, _requiresPIN, _token) => {
    const userRole = userData.role;
    setRole(userRole);
    setCurrentUser(userData);
    registerForPushNotifications(userData.uid, userRole);
    const hasData = !!(userData.mobile && userData.blood_group && userData.emergency_contact && userData.date_of_birth);
    if (!userData.profileCompleted && !hasData) {
      navigate('complete-profile');
    } else {
      if (!userData.profileCompleted && hasData) {
        userData.profileCompleted = true;
        AsyncStorage.setItem('userData', JSON.stringify(userData)).catch(() => { });
      }
      navigateToDashboard(userRole);
    }
  }, [navigate, navigateToDashboard]);

  const handleSignupSuccess = useCallback((data) => {
    const user = data.user || data;
    setCurrentUser(user);
    setRole(user.role);
    navigate('complete-profile');
  }, [navigate]);

  const handleProfileComplete = useCallback(async (updatedUser) => {
    setCurrentUser(updatedUser);
    await AsyncStorage.setItem('userData', JSON.stringify(updatedUser));
    navigateToDashboard(updatedUser.role);
  }, [navigateToDashboard]);

  const handleLogout = useCallback(async () => {
    await AsyncStorage.multiRemove(['authToken', 'userData']);
    setCurrentUser(null);
    setRole(null);
    navigate('school-splash');
  }, [navigate]);

  const driverScreens = useMemo(() => ['driver-home', 'driver-scans', 'driver-locations', 'driver-duration', 'driver-profile', 'driver-leave', 'driver-proximity'], []);
  const cleanerScreens = useMemo(() => ['cleaner-home', 'cleaner-scanner', 'cleaner-duration', 'cleaner-alerts', 'cleaner-profile', 'cleaner-leave'], []);
  const isParentHome = ['parent-home', 'attendance', 'marks', 'bus', 'notifications', 'activities', 'fee', 'leave', 'digital-folder'].includes(screen);
  const isTeacherHome = ['teacher-home', 'teacher-attendance', 'teacher-marks', 'teacher-class-marks', 'teacher-schedule', 'teacher-bus', 'teacher-alerts', 'teacher-personal', 'teacher-profile', 'teacher-send-document', 'cce-home', 'cce-mark-entry', 'cce-halfyear', 'cce-final', 'marks-cce'].includes(screen);
  const isDriverHome = driverScreens.includes(screen);
  const isCleanerHome = cleanerScreens.includes(screen);
  const isAdminHome = adminScreens.includes(screen);

  const isDashboardScreen = isParentHome || isTeacherHome || isDriverHome || isCleanerHome || isAdminHome;
  const hasProfileData = !!(currentUser?.mobile && currentUser?.blood_group && currentUser?.emergency_contact && currentUser?.date_of_birth);
  const needsProfile = currentUser && !currentUser.profileCompleted && !hasProfileData && isDashboardScreen;
  if (needsProfile) {
    return <CompleteProfileScreen currentUser={currentUser} onComplete={handleProfileComplete} />;
  }

  if (isAdminHome && role !== 'principal') {
    return (
      <View style={{ flex: 1, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text style={{ fontSize: 48, marginBottom: 16 }}>🔒</Text>
        <Text style={{ fontSize: 20, fontWeight: '700', color: C.white, marginBottom: 8, textAlign: 'center' }}>Access Denied</Text>
        <Text style={{ fontSize: 14, color: C.muted, textAlign: 'center', marginBottom: 24 }}>Only the Principal can access the Admin Dashboard.</Text>
        <TouchableOpacity
          onPress={handleLogout}
          style={{ backgroundColor: C.gold, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 14 }}
        >
          <Text style={{ fontWeight: '600', fontSize: 15, color: C.navy }}>Go to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isDriverHome && role !== 'driver') {
    return (
      <View style={{ flex: 1, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text style={{ fontSize: 48, marginBottom: 16 }}>🔒</Text>
        <Text style={{ fontSize: 20, fontWeight: '700', color: C.white, marginBottom: 8, textAlign: 'center' }}>Access Denied</Text>
        <Text style={{ fontSize: 14, color: C.muted, textAlign: 'center', marginBottom: 24 }}>Only registered Drivers can access the Driver Dashboard.</Text>
        <TouchableOpacity
          onPress={handleLogout}
          style={{ backgroundColor: C.teal, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 14 }}
        >
          <Text style={{ fontWeight: '600', fontSize: 15, color: C.white }}>Go to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isCleanerHome && role !== 'cleaner') {
    return (
      <View style={{ flex: 1, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text style={{ fontSize: 48, marginBottom: 16 }}>🔒</Text>
        <Text style={{ fontSize: 20, fontWeight: '700', color: C.white, marginBottom: 8, textAlign: 'center' }}>Access Denied</Text>
        <Text style={{ fontSize: 14, color: C.muted, textAlign: 'center', marginBottom: 24 }}>Only registered Cleaners can access the Cleaner Dashboard.</Text>
        <TouchableOpacity
          onPress={handleLogout}
          style={{ backgroundColor: C.gold, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 14 }}
        >
          <Text style={{ fontWeight: '600', fontSize: 15, color: C.navy }}>Go to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const parentTabs = useMemo(() => [
    { id: 'home', label: 'Home', icon: 'home', screen: 'parent-home' },
    { id: 'marks', label: 'Marks', icon: 'chart', screen: 'marks' },
    { id: 'activities', label: 'Activities', icon: 'star', screen: 'activities' },
    { id: 'bus', label: 'Bus', icon: 'bus', screen: 'bus' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', screen: 'notifications' },
  ], []);

  const teacherTabs = useMemo(() => [
    { id: 'home', label: 'Dashboard', icon: 'home', screen: 'teacher-home' },
    { id: 'attend', label: 'Attendance', icon: 'check', screen: 'teacher-attendance' },
    { id: 'marks', label: 'Marks', icon: 'chart', screen: 'cce-home' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', screen: 'teacher-alerts' },
    { id: 'personal', label: 'My Leave', icon: 'star', screen: 'teacher-personal' },
    { id: 'profile', label: 'Profile', icon: 'user', screen: 'teacher-profile' },
  ], []);

  const adminTabs = useMemo(() => [
    { id: 'home', label: 'Overview', icon: 'home', screen: 'admin-home' },
    { id: 'users', label: 'Users', icon: 'users', screen: 'admin-users' },
    { id: 'leaves', label: 'Leaves', icon: 'check', screen: 'admin-leaves' },
    { id: 'fees', label: 'Fees', icon: 'fee', screen: 'admin-fees' },
    { id: 'salary', label: 'Payroll', icon: 'chart', screen: 'admin-salary' },
  ], []);

  const driverTabs = useMemo(() => [
    { id: 'home', label: 'Home', icon: 'home', screen: 'driver-home' },
    { id: 'scans', label: 'Scans', icon: 'scan', screen: 'driver-scans' },
    { id: 'locations', label: 'Locations', icon: 'navigate', screen: 'driver-locations' },
    { id: 'duration', label: 'Trips', icon: 'clock', screen: 'driver-duration' },
    { id: 'profile', label: 'Profile', icon: 'user', screen: 'driver-profile' },
    { id: 'leave', label: 'Leave', icon: 'leave', screen: 'driver-leave' },
  ], []);

  const cleanerTabs = useMemo(() => [
    { id: 'home', label: 'Home', icon: 'home', screen: 'cleaner-home' },
    { id: 'scanner', label: 'Scanner', icon: 'scan', screen: 'cleaner-scanner' },
    { id: 'duration', label: 'Trips', icon: 'clock', screen: 'cleaner-duration' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', screen: 'cleaner-alerts' },
    { id: 'profile', label: 'Profile', icon: 'user', screen: 'cleaner-profile' },
    { id: 'leave', label: 'Leave', icon: 'leave', screen: 'cleaner-leave' },
  ], []);

  const renderScreen = () => {
    switch (screen) {
      case 'loading':
        return <View style={{ flex: 1, backgroundColor: '#0a1628' }} />;
      case 'welcome':
        return <WelcomeScreen onNavigate={navigate} />;
      case 'school-splash':
        return <SchoolSplashScreen onNavigate={navigate} currentUser={currentUser} />;
      case 'splash-intro':
        return <SplashIntroScreen onFinish={() => navigate('splash')} />;
      case 'splash':
        return <SplashScreen onSelect={s => {
          if (s === 'teacher-login') setRole('teacher');
          navigate(s);
        }} />;
      case 'parent-portal':
        return <ParentPortalScreen onBack={() => navigate('splash')} onLoginSuccess={handleLoginSuccess} onNavigate={navigate} />;
      case 'parent-login':
        return <ParentLoginScreen onLoginSuccess={handleLoginSuccess} onBack={() => navigate('parent-portal')} onNavigate={navigate} />;
      case 'parent-register':
        return <ParentLoginScreen onLoginSuccess={handleLoginSuccess} onBack={() => navigate('parent-portal')} onNavigate={navigate} />;
      case 'teacher-login':
        return <LoginScreen role="teacher" onLoginSuccess={handleLoginSuccess} onBack={() => navigate('splash')} onNavigate={navigate} />;
      case 'signup':
        return <SignupScreen onSignup={handleSignupSuccess} onBack={() => navigate(role === 'teacher' ? 'teacher-login' : 'parent-login')} />;
      case 'complete-profile':
        return <CompleteProfileScreen currentUser={currentUser} onComplete={handleProfileComplete} />;
      case 'parent-home': return (
        <ErrorBoundary onReset={() => navigate('parent-home')}>
          <ParentDashboard onNavigate={navigate} currentUser={currentUser} onLogout={handleLogout} onUpdateUser={(u) => setCurrentUser(u)} />
        </ErrorBoundary>
      );
      case 'attendance': return <AttendanceScreen onBack={() => navigate('parent-home')} currentUser={currentUser} />;
      case 'marks': return <MarksScreen onBack={() => navigate('parent-home')} currentUser={currentUser} />;
      case 'bus': return <BusScreen onBack={() => navigate('parent-home')} />;
      case 'notifications': return <NotificationsScreen onBack={() => navigate('parent-home')} currentUser={currentUser} />;
      case 'activities': return <ActivitiesScreen onBack={() => navigate('parent-home')} />;
      case 'fee': return <FeeScreen onBack={() => navigate('parent-home')} currentUser={currentUser} />;
      case 'leave': return <LeaveScreen onBack={() => navigate('parent-home')} currentUser={currentUser} />;
      case 'digital-folder': return <DigitalFolder onBack={() => navigate('parent-home')} currentUser={currentUser} />;
      case 'teacher-home': return (
        <ErrorBoundary onReset={() => navigate('teacher-home')}>
          <TeacherDashboard onNavigate={navigate} currentUser={currentUser} onLogout={handleLogout} currentScreen={screen} />
        </ErrorBoundary>
      );
      case 'teacher-attendance': return <TeacherAttendance onBack={() => navigate('teacher-home')} currentUser={currentUser} />;
      case 'teacher-marks': return <CCEHomeScreen onBack={() => navigate('teacher-home')} onNavigate={navigate} currentUser={currentUser} />;
      case 'teacher-schedule': return <TeacherScheduleScreen onBack={() => navigate('teacher-home')} currentUser={currentUser} />;
      case 'teacher-bus': return <TeacherBusMonitor onBack={() => navigate('teacher-home')} currentUser={currentUser} />;
      case 'teacher-alerts': return <TeacherAlertsScreen onBack={() => navigate('teacher-home')} requests={leaveRequests} setRequests={setLeaveRequests} currentUser={currentUser} />;
      case 'teacher-personal': return <TeacherPersonalScreen onBack={() => navigate('teacher-home')} currentUser={currentUser} />;
      case 'teacher-profile': return <TeacherProfile onBack={() => navigate('teacher-home')} currentUser={currentUser} onLogout={handleLogout} />;
      case 'teacher-send-document': return <TeacherSendDocument onBack={() => navigate('teacher-home')} currentUser={currentUser} isAdmin={false} />;
      case 'teacher-class-marks': return <ClassMarksViewScreen onBack={() => navigate('teacher-home')} currentUser={currentUser} />;
      case 'cce-home': return <CCEHomeScreen onBack={() => navigate('teacher-home')} onNavigate={navigate} currentUser={currentUser} />;
      case 'cce-mark-entry': return <CCEMarkEntryScreen onBack={() => navigate('cce-home')} params={navParams} />;
      case 'cce-halfyear': return <CCEHalfYearReportScreen onBack={() => navigate('cce-home')} params={navParams} />;
      case 'cce-final': return <CCEFinalReportScreen onBack={() => navigate('cce-home')} params={navParams} />;
      case 'explore': return <ExploreScreen onBack={() => navigate('splash')} />;
      case 'contact': return <ContactScreen onBack={() => navigate('splash')} />;
      case 'driver-home': return (
        <ErrorBoundary onReset={() => navigate('driver-home')}>
          <DriverDashboard onNavigate={navigate} currentUser={currentUser} />
        </ErrorBoundary>
      );
      case 'driver-scans': return <DriverScans onBack={() => navigate('driver-home')} />;
      case 'driver-locations': return <DriverStudentLocations onBack={() => navigate('driver-home')} currentUser={currentUser} />;
      case 'driver-duration': return <DriverDuration onBack={() => navigate('driver-home')} currentUser={currentUser} />;
      case 'driver-profile': return <DriverProfile onBack={() => navigate('driver-home')} currentUser={currentUser} onLogout={handleLogout} />;
      case 'driver-leave': return <DriverLeave onBack={() => navigate('driver-home')} currentUser={currentUser} />;
      case 'driver-proximity': return <DriverProximityAlerts onBack={() => navigate('driver-home')} currentUser={currentUser} />;
      case 'cleaner-home': return (
        <ErrorBoundary onReset={() => navigate('cleaner-home')}>
          <CleanerDashboard onNavigate={navigate} currentUser={currentUser} students={cleanerStudents} />
        </ErrorBoundary>
      );
      case 'cleaner-scanner': return <CleanerScanner currentUser={currentUser} onBack={() => navigate('cleaner-home')} />;
      case 'cleaner-duration': return <CleanerDuration onBack={() => navigate('cleaner-home')} currentUser={currentUser} />;
      case 'cleaner-alerts': return <CleanerAlerts onBack={() => navigate('cleaner-home')} notifs={cleanerNotifs} setNotifs={setCleanerNotifs} />;
      case 'cleaner-profile': return <CleanerProfile onBack={() => navigate('cleaner-home')} currentUser={currentUser} onLogout={handleLogout} />;
      case 'cleaner-leave': return <CleanerLeave onBack={() => navigate('cleaner-home')} currentUser={currentUser} />;
      case 'admin-home': return (
        <ErrorBoundary onReset={() => navigate('admin-home')}>
          <AdminOverview onNavigate={navigate} currentUser={currentUser} onLogout={handleLogout} currentScreen={screen} />
        </ErrorBoundary>
      );
      case 'admin-users': return <AdminUsers onBack={() => navigate('admin-home')} onNavigate={navigate} />;
      case 'student-import': return <StudentImport onBack={() => navigate('admin-users')} onNavigate={navigate} />;
      case 'student-list': return <StudentList onBack={() => navigate('admin-users')} />;
      case 'admin-classes': return <AdminClasses onBack={() => navigate('admin-home')} currentUser={currentUser} onNavigate={navigate} />;
      case 'admin-student-qr': return <AdminStudentQR onBack={() => navigate('admin-classes')} currentUser={currentUser} />;
      case 'admin-buses': return <AdminBuses onBack={() => navigate('admin-home')} currentUser={currentUser} />;
      case 'admin-reports': return <AdminReports onBack={() => navigate('admin-home')} />;
      case 'admin-alerts': return <AdminAlerts onBack={() => navigate('admin-home')} />;
      case 'admin-notifications': return <AdminNotificationsScreen onBack={() => navigate('admin-home')} schoolId={currentUser?.schoolId} />;
      case 'admin-activities': return <AdminActivities onBack={() => navigate('admin-home')} currentUser={currentUser} />;
      case 'admin-settings': return <AdminSettings onBack={() => navigate('admin-home')} currentUser={currentUser} />;
      case 'admin-leaves': return <AdminLeaveScreen onBack={() => navigate('admin-home')} currentUser={currentUser} />;
      case 'admin-fees': return <AdminFeeScreen onBack={() => navigate('admin-home')} currentUser={currentUser} />;
      case 'admin-salary': return <AdminSalaryScreen onBack={() => navigate('admin-home')} />;
      case 'admin-promotion': return <AdminPromotion onBack={() => navigate('admin-home')} />;
      case 'admin-fee-status': return <AdminFeeStatus onBack={() => navigate('admin-home')} />;
      case 'admin-students': return <AdminStudents onBack={() => navigate('admin-classes')} classItem={navParams.selectedClass} />;
      case 'admin-profile': return <AdminProfile onBack={() => navigate('admin-home')} currentUser={currentUser} onLogout={handleLogout} onUpdateUser={(u) => setCurrentUser(u)} />;
      case 'admin-send-document': return <AdminSendDocument onBack={() => navigate('admin-home')} currentUser={currentUser} />;
      default: return null;
    }
  };

  const showNav = isParentHome || isTeacherHome || isDriverHome || isCleanerHome || isAdminHome;
  const tabs = isParentHome ? parentTabs : isAdminHome ? adminTabs : isDriverHome ? driverTabs : isCleanerHome ? cleanerTabs : teacherTabs;
  const activeColor = isAdminHome ? C.purple : isDriverHome ? C.teal : isCleanerHome ? C.gold : C.gold;

  const isWeb = Platform.OS === 'web';

  const webContainerStyle = showNav
    ? { width: 390, height: 844, backgroundColor: C.navy, borderRadius: 40, overflow: 'hidden', alignSelf: 'center' }
    : { width: 390, minHeight: 844, backgroundColor: C.navy, borderRadius: 40, overflow: 'hidden', alignSelf: 'center' };

  const content = (
    <View style={isWeb ? webContainerStyle : { flex: 1, backgroundColor: C.navy }}>

      {Platform.OS === 'web' ? (
        <View style={{ flex: 1 }}>
          <React.Fragment key={screen}>
            {renderScreen()}
          </React.Fragment>
        </View>
      ) : (
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
          <React.Fragment key={screen}>
            {renderScreen()}
          </React.Fragment>
        </ScrollView>
      )}

      {showNav && (
        <View style={[S.bottomNav, { flexShrink: 0 }]}>
          {tabs.map(t => {
            const isActive = screen === t.screen;
            const pendingLeaveCount = isTeacherHome && t.id === 'alerts'
              ? (leaveRequests || []).filter(r => r.status === 'Pending').length
              : 0;
            return (
              <TouchableOpacity key={t.id} style={[S.navItem, { position: 'relative' }]} onPress={() => navigate(t.screen)}>
                {pendingLeaveCount > 0 && (
                  <View style={{ position: 'absolute', top: 0, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: C.coral, borderWidth: 2, borderColor: C.navy, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, zIndex: 10 }}>
                    <Text style={{ fontSize: 8, fontWeight: '800', color: C.white }}>{pendingLeaveCount}</Text>
                  </View>
                )}
                <Icon name={t.icon} size={22} color={isActive ? activeColor : C.muted} />
                <Text style={isActive ? [S.navItemLabelActive, { color: activeColor }] : S.navItemLabel}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );

  const appContent = isWeb ? (
    <View style={{ flex: 1, backgroundColor: '#050F1E', alignItems: 'center', justifyContent: 'center', paddingVertical: 20 }}>
      <OfflineBanner />
      {content}
    </View>
  ) : (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.navy }}>
      <StatusBar barStyle="light-content" backgroundColor={C.navy} />
      <OfflineBanner />
      {content}
    </SafeAreaView>
  );

  return (
    <ErrorBoundary onReset={() => {
      setScreen('splash-intro');
      setCurrentUser(null);
      setRole(null);
    }}>
      {appContent}
    </ErrorBoundary>
  );
}
