import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Image,
  StyleSheet,
  Platform,
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

export default function SplashScreen({ onSelect }) {
  return (
    <LinearGradient
      colors={['#0a1628', '#0d2137']}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.6, y: 1 }}
      style={styles.bg}
    >
      <View style={styles.blob1} />
      <View style={styles.blob2} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <View style={styles.logoWrap}>
            <Image
              source={require('../../../assets/logo.png')}
              style={styles.logo}
              resizeMode="cover"
            />
          </View>

          <Text style={styles.schoolName}>SREE PRAGATHI{'\n'}HIGH SCHOOL</Text>
          <Text style={styles.tagline}>Excellence in Education · Gopalraopet</Text>

          <View style={styles.buttons}>
            <TouchableOpacity
              style={[styles.btn, styles.btnOrange]}
              onPress={() => onSelect('parent-login')}
              activeOpacity={0.82}
            >
              <Ionicons name="people" size={20} color="#fff" style={styles.btnIcon} />
              <Text style={styles.btnText}>Parent Login</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnTeal]}
              onPress={() => onSelect('teacher-login')}
              activeOpacity={0.82}
            >
              <Ionicons name="book" size={20} color="#fff" style={styles.btnIcon} />
              <Text style={styles.btnText}>Teacher / Staff Login</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnOutline]}
              onPress={() => onSelect('explore')}
              activeOpacity={0.82}
            >
              <Ionicons name="information-circle-outline" size={20} color="#fff" style={styles.btnIcon} />
              <Text style={styles.btnTextOutline}>Explore School</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnOutline]}
              onPress={() => onSelect('contact')}
              activeOpacity={0.82}
            >
              <Ionicons name="call-outline" size={20} color="#fff" style={styles.btnIcon} />
              <Text style={styles.btnTextOutline}>Contact Us</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.copyright}>© 2025 Sree Pragathi High School</Text>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    position: 'relative',
  },
  blob1: {
    position: 'absolute',
    top: -100,
    left: -100,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: '#1a4a5c',
    opacity: 0.4,
  },
  blob2: {
    position: 'absolute',
    bottom: -80,
    right: -80,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#1a4a5c',
    opacity: 0.4,
  },
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0f2744',
    borderRadius: 24,
    padding: 30,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 16,
  },
  logoWrap: {
    width: 90,
    height: 90,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 20,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  logo: {
    width: 90,
    height: 90,
  },
  schoolName: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    textAlign: 'center',
    lineHeight: 32,
    letterSpacing: 0.5,
  },
  tagline: {
    fontSize: 13,
    color: '#9bb0c9',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 28,
    letterSpacing: 0.2,
  },
  buttons: {
    width: '100%',
    gap: 12,
  },
  btn: {
    width: '100%',
    height: 54,
    borderRadius: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOrange: {
    backgroundColor: '#f5a623',
  },
  btnTeal: {
    backgroundColor: '#00bfa5',
  },
  btnPurple: {
    backgroundColor: '#7C3AED',
  },
  btnAdmin: {
    backgroundColor: '#db2777', // pink/rose colour
  },
  btnOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  btnIcon: {
    marginRight: 10,
  },
  btnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  btnTextOutline: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  copyright: {
    marginTop: 28,
    fontSize: 11,
    color: '#4a6282',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
});
