import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ActivityIndicator, Image, StyleSheet, Vibration, Alert,
} from 'react-native';
import { Camera, CameraView } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { C } from '../../theme/colors';

const PRODUCTION_URL = 'https://vidyalayam-one.vercel.app';
const LOCAL_IP_URL = 'http://192.168.1.33:5001'; // Local development IP
const LOCALHOST_URL = 'http://localhost:5001'; // Web development
const API_BASE = Platform.OS === 'web'
  ? (typeof window !== 'undefined' && window.location && window.location.hostname === 'localhost'
      ? LOCALHOST_URL
      : PRODUCTION_URL)
  : LOCAL_IP_URL; // React Native/Mobile uses local IP

export default function WelcomeScreen({ onNavigate }) {
  const [mode, setMode]               = useState('home');
  const [hasPermission, setHasPermission] = useState(null);
  const [scanned, setScanned]         = useState(false);
  const [schoolIdInput, setSchoolIdInput] = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  useEffect(() => {
    if (mode === 'scan') {
      (async () => {
        const { status } = await Camera.requestCameraPermissionsAsync();
        setHasPermission(status === 'granted');
        setScanned(false);
      })();
    }
  }, [mode]);

  const saveSchoolAndNavigate = async ({ schoolId, schoolName, logoUrl, primaryColor, location, tagline }) => {
    await AsyncStorage.multiSet([
      ['schoolId',           schoolId         || ''],
      ['schoolName',         schoolName        || ''],
      ['schoolLogoUrl',      logoUrl           || ''],
      ['schoolPrimaryColor', primaryColor      || '#1a3c5e'],
      ['schoolLocation',     location          || ''],
      ['schoolTagline',      tagline           || ''],
    ]);
    onNavigate('school-splash');
  };

  const handleBarCodeScanned = async ({ data }) => {
    if (scanned) return;
    setScanned(true);
    Vibration.vibrate(100);
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'school' || parsed.type === 'student') {
        await saveSchoolAndNavigate({
          schoolId:     parsed.schoolId,
          schoolName:   parsed.schoolName,
          logoUrl:      parsed.logoUrl      || '',
          primaryColor: parsed.primaryColor || '#1a3c5e',
          location:     parsed.location     || '',
          tagline:      parsed.tagline      || '',
        });
      } else {
        Alert.alert('Invalid QR', 'This does not appear to be a school QR code.', [
          { text: 'Try Again', onPress: () => setScanned(false) },
        ]);
      }
    } catch {
      Alert.alert('Invalid QR', 'Could not read QR code. Please try again.', [
        { text: 'Try Again', onPress: () => setScanned(false) },
      ]);
    }
  };

  const handleManualSubmit = async () => {
    const id = schoolIdInput.trim().toUpperCase();
    if (!id) { setError('Please enter a School ID'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/school/info/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || 'School not found. Check ID and try again.');
        return;
      }
      await saveSchoolAndNavigate(data);
    } catch {
      setError('Network error. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'scan') {
    if (hasPermission === null) {
      return (
        <View style={st.center}>
          <ActivityIndicator color={C.teal} />
          <Text style={{ color: C.muted, marginTop: 12 }}>Requesting camera access...</Text>
        </View>
      );
    }
    if (hasPermission === false) {
      return (
        <View style={st.center}>
          <Text style={{ color: C.coral, fontSize: 15, marginBottom: 20, textAlign: 'center' }}>
            Camera permission denied. Please enable it in your device settings.
          </Text>
          <TouchableOpacity onPress={() => setMode('home')} style={st.btnSecondary}>
            <Text style={st.btnSecondaryText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
        />
        <View style={st.scanOverlay}>
          <View style={st.scanFrame} />
          <Text style={st.scanHint}>Point camera at school QR code</Text>
        </View>
        <TouchableOpacity onPress={() => setMode('home')} style={st.scanClose}>
          <Text style={{ color: C.white, fontSize: 18, fontWeight: '700' }}>✕</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (mode === 'manual') {
    return (
      <View style={st.container}>
        <View style={st.logoArea}>
          <Text style={st.appName}>VIDYALAYAM</Text>
          <Text style={st.appSub}>School Management System</Text>
        </View>
        <View style={{ paddingHorizontal: 28, paddingTop: 16 }}>
          <Text style={st.sectionTitle}>Enter School ID</Text>
          <TextInput
            style={st.input}
            placeholder="e.g. SP-GOPA"
            placeholderTextColor={C.muted}
            value={schoolIdInput}
            onChangeText={t => { setSchoolIdInput(t); setError(''); }}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {error ? (
            <Text style={{ color: C.coral, fontSize: 13, marginTop: 8 }}>{error}</Text>
          ) : null}
          <TouchableOpacity
            style={[st.btn, { marginTop: 20, opacity: loading ? 0.6 : 1 }]}
            onPress={handleManualSubmit}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color={C.white} />
              : <Text style={st.btnText}>Find School</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setMode('home'); setError(''); }} style={{ marginTop: 20, alignItems: 'center' }}>
            <Text style={{ color: C.muted, fontSize: 14 }}>← Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={st.container}>
      <View style={st.logoArea}>
        <View style={st.logoCircle}>
          <Text style={{ fontSize: 36 }}>🎓</Text>
        </View>
        <Text style={st.appName}>VIDYALAYAM</Text>
        <Text style={st.appSub}>School Management System</Text>
      </View>
      <View style={{ paddingHorizontal: 28, paddingTop: 32 }}>
        <Text style={{ color: C.muted, fontSize: 15, textAlign: 'center', marginBottom: 40, lineHeight: 22 }}>
          Select your school to get started
        </Text>
        <TouchableOpacity style={st.btn} onPress={() => setMode('scan')}>
          <Text style={st.btnText}>📷  Scan School QR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[st.btn, st.btnOutline, { marginTop: 16 }]} onPress={() => setMode('manual')}>
          <Text style={[st.btnText, { color: C.teal }]}>⌨️  Enter School ID</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#0a1628',
  },
  center: {
    flex: 1, backgroundColor: '#0a1628',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  logoArea: {
    alignItems: 'center', paddingTop: 100, paddingBottom: 16,
  },
  logoCircle: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: C.navyLt,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 20,
  },
  appName: {
    fontSize: 28, fontWeight: '900', color: C.white,
    letterSpacing: 4, marginBottom: 6,
  },
  appSub: {
    fontSize: 14, color: C.muted, letterSpacing: 1,
  },
  sectionTitle: {
    fontSize: 18, fontWeight: '700', color: C.white, marginBottom: 16,
  },
  input: {
    backgroundColor: '#162E50', borderWidth: 1.5, borderColor: '#213D62',
    borderRadius: 14, padding: 15, color: C.white, fontSize: 16,
  },
  btn: {
    backgroundColor: C.teal, borderRadius: 14,
    paddingVertical: 16, alignItems: 'center',
  },
  btnText: {
    color: C.white, fontSize: 16, fontWeight: '700',
  },
  btnOutline: {
    backgroundColor: 'transparent', borderWidth: 2, borderColor: C.teal,
  },
  btnSecondary: {
    borderWidth: 1.5, borderColor: C.muted, borderRadius: 14,
    paddingVertical: 14, paddingHorizontal: 28,
  },
  btnSecondaryText: { color: C.muted, fontSize: 15, fontWeight: '600' },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
  },
  scanFrame: {
    width: 240, height: 240,
    borderWidth: 3, borderColor: C.teal, borderRadius: 16,
  },
  scanHint: {
    color: C.white, fontSize: 14, marginTop: 20,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
  },
  scanClose: {
    position: 'absolute', top: 52, right: 20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
});
