import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Modal, ActivityIndicator, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Icon from '../../components/Icon';
import { C } from '../../theme/colors';
import { S } from '../../theme/styles';
import { loginUser, forgotPassword } from '../../api/client';

export default function LoginScreen({ role, onLoginSuccess, onBack, onNavigate }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const isParent = role === 'parent';
  const isDriver = role === 'driver';
  const isCleaner = role === 'cleaner';

  const [schoolName, setSchoolName] = useState('');
  const [schoolLogoUrl, setSchoolLogoUrl] = useState('');
  const [schoolInitials, setSchoolInitials] = useState('');
  useEffect(() => {
    AsyncStorage.multiGet(['schoolName', 'schoolLogoUrl']).then(vals => {
      const name = vals[0][1] || '';
      const logo = vals[1][1] || '';
      setSchoolName(name);
      setSchoolLogoUrl(logo);
      setSchoolInitials(name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase());
    }).catch(() => {});
  }, []);

  const handleLogin = async () => {
    setErrorMsg('');
    if (!user || !pass) {
      setErrorMsg('Please enter email and password');
      return;
    }

    setLoading(true);
    try {
      const data = await loginUser({ email: user, password: pass });
      if (data.token) {
        await AsyncStorage.setItem('authToken', data.token);
        const storedSchoolId = await AsyncStorage.getItem('schoolId');
        await AsyncStorage.setItem('schoolId', data.user?.schoolId || storedSchoolId || '');
        await AsyncStorage.setItem('userData', JSON.stringify(data.user));
      }
      const userData = data.user;
      if (onLoginSuccess) onLoginSuccess(userData);
    } catch (err) {
      setErrorMsg(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotOpen = () => {
    setResetEmail(user || '');
    setResetMsg('');
    setResetError('');
    setResetSent(false);
    setShowForgot(true);
  };

  const handleForgotClose = () => {
    setShowForgot(false);
    setResetEmail('');
    setResetMsg('');
    setResetError('');
    setResetSent(false);
  };

  const handleResetSubmit = async () => {
    setResetError('');
    setResetMsg('');
    if (!resetEmail.trim()) {
      setResetError('Please enter your registered email address.');
      return;
    }
    setResetLoading(true);
    try {
      const data = await forgotPassword({ email: resetEmail.trim() });
      setResetMsg(data.message || 'Password reset link sent! Please check your inbox.');
      setResetSent(true);
    } catch (err) {
      setResetError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <LinearGradient
      colors={[C.navyLt, C.navy]}
      start={{ x: 0.2, y: 0 }}
      end={{ x: 0.8, y: 0.6 }}
      style={{ flex: 1 }}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
        <View style={{ padding: 12, paddingHorizontal: 20 }}>
          <TouchableOpacity style={S.backBtn} onPress={onBack}>
            <Icon name="back" size={18} color={C.white} />
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: 28, paddingTop: 20, paddingBottom: 40, flex: 1 }}>
          {schoolName ? (
            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              {schoolLogoUrl ? (
                <Image source={{ uri: schoolLogoUrl }} style={{ width: 50, height: 50, borderRadius: 10, marginBottom: 6 }} resizeMode="contain" />
              ) : schoolInitials ? (
                <View style={{ width: 50, height: 50, borderRadius: 10, backgroundColor: C.navyLt, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
                  <Text style={{ color: C.teal, fontSize: 18, fontWeight: '800' }}>{schoolInitials}</Text>
                </View>
              ) : null}
              <Text style={{ color: C.muted, fontSize: 13, fontWeight: '600' }}>{schoolName}</Text>
            </View>
          ) : null}
          <View style={{ marginBottom: 36 }}>
            <View style={[S.chip, isParent ? S.chipGold : S.chipTeal, { marginBottom: 16, alignSelf: 'flex-start' }]}>
              <Text style={[S.chipText, { color: C.teal }]}>
                👩‍🏫 Teacher / Staff / Driver / Cleaner Portal
              </Text>
            </View>
            <Text style={{ fontSize: 30, fontWeight: '700', color: C.white, marginBottom: 8 }}>
              Welcome Back
            </Text>
            <Text style={{ color: C.muted, fontSize: 14 }}>Sign in to continue</Text>
          </View>

          {errorMsg ? (
            <View style={{ backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '55', borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <Text style={{ color: C.coral, fontSize: 13, fontWeight: '600' }}>{errorMsg}</Text>
            </View>
          ) : null}

          <View style={{ gap: 18, marginBottom: 32 }}>
            <View>
              <Text style={S.label}>Email</Text>
              <TextInput
                style={S.inputField}
                placeholder="Enter your email"
                placeholderTextColor={C.muted}
                value={user}
                onChangeText={setUser}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>
            <View>
              <Text style={S.label}>Password</Text>
              <View style={{ position: 'relative' }}>
                <TextInput
                  style={[S.inputField, { paddingRight: 50 }]}
                  placeholder="Enter your password"
                  placeholderTextColor={C.muted}
                  secureTextEntry={!showPass}
                  value={pass}
                  onChangeText={setPass}
                />
                <TouchableOpacity
                  onPress={() => setShowPass(!showPass)}
                  style={{ position: 'absolute', right: 14, top: 0, bottom: 0, justifyContent: 'center' }}
                >
                  <Text style={{ fontSize: 16 }}>{showPass ? '🙈' : '👁️'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={[S.btn, S.btnFull, isParent ? S.btnGold : S.btnTeal, { marginBottom: 16, opacity: loading ? 0.6 : 1 }]}
            onPress={handleLogin}
            disabled={loading}
          >
            <Text style={isParent ? S.btnTextDark : S.btnTextLight}>{loading ? 'Signing In...' : 'Sign In'}</Text>
            <Icon name="arrow" size={16} color={isParent ? C.navy : C.white} />
          </TouchableOpacity>

          <TouchableOpacity onPress={handleForgotOpen}>
            <Text style={{ textAlign: 'center', color: C.muted, fontSize: 13 }}>
              Forgot Password? <Text style={{ color: C.gold, fontWeight: '600' }}>Reset</Text>
            </Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => onNavigate && onNavigate('signup')} style={{ marginTop: 16 }}>
            <Text style={{ textAlign: 'center', color: C.muted, fontSize: 13 }}>
              New here? <Text style={{ color: C.gold }}>Register</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={showForgot} transparent animationType="fade" onRequestClose={handleForgotClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 22, padding: 24, width: '100%', maxWidth: 380 }}>
            {resetSent ? (
              <View style={{ alignItems: 'center' }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#22d38a22', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                  <Icon name="check" size={32} color="#22d38a" />
                </View>
                <Text style={{ fontWeight: '800', fontSize: 18, color: C.white, marginBottom: 10, textAlign: 'center' }}>Email Sent!</Text>
                <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 24 }}>{resetMsg}</Text>
                <TouchableOpacity onPress={handleForgotClose} style={{ backgroundColor: C.teal, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 24, width: '100%', alignItems: 'center' }}>
                  <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Back to Login</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                  <Text style={{ fontWeight: '800', fontSize: 18, color: C.white }}>Reset Password</Text>
                  <TouchableOpacity onPress={handleForgotClose} style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: C.navyMid, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="x" size={16} color={C.muted} />
                  </TouchableOpacity>
                </View>
                <Text style={{ color: C.muted, fontSize: 13, lineHeight: 20, marginBottom: 20 }}>
                  Enter your registered email address and we'll send you a link to reset your password.
                </Text>
                <Text style={{ fontSize: 12, fontWeight: '500', color: C.muted, marginBottom: 6 }}>Registered Email</Text>
                <TextInput
                  style={{ width: '100%', padding: 14, paddingHorizontal: 16, borderRadius: 12, backgroundColor: C.navyMid, borderWidth: 1.5, borderColor: C.border, color: C.white, fontSize: 14, marginBottom: 4 }}
                  placeholder="e.g. teacher@venkeys.edu"
                  placeholderTextColor={C.muted}
                  value={resetEmail}
                  onChangeText={setResetEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                {resetError ? (
                  <View style={{ backgroundColor: C.coral + '22', borderWidth: 1, borderColor: C.coral + '44', borderRadius: 10, padding: 10, marginTop: 10 }}>
                    <Text style={{ color: C.coral, fontSize: 12, fontWeight: '600' }}>{resetError}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  onPress={handleResetSubmit}
                  disabled={resetLoading}
                  style={{ backgroundColor: C.gold, borderRadius: 12, paddingVertical: 14, marginTop: 16, alignItems: 'center', opacity: resetLoading ? 0.6 : 1 }}
                >
                  {resetLoading ? (
                    <ActivityIndicator size="small" color={C.navy} />
                  ) : (
                    <Text style={{ color: C.navy, fontWeight: '700', fontSize: 14 }}>Send Reset Link</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}
