require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');

const _cache = new Map();
function cacheGet(key, ttlMs = 5 * 60 * 1000) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  _cache.delete(key);
  return null;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }
function cacheDel(prefix) {
  for (const k of _cache.keys()) { if (k.startsWith(prefix)) _cache.delete(k); }
}
const { runDailyBackup } = require('../src/services/firestoreBackup');
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 5001;

function normalizeMultilineSecret(value) {
  return String(value || '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\\n/g, '\n');
}

if (!JWT_SECRET) {
  console.warn('[WARNING] JWT_SECRET environment variable is not set. Auth will fail.');
} else {
  console.log(`[JWT Debug] Secret Length: ${JWT_SECRET.length}, Prefix: ${JWT_SECRET.substring(0, 3)}`);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    console.error('[JWT Verification Failure]', e.message);
    return null;
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
});

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many scan requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Dynamic per-request — set from JWT. This constant is only used as fallback.
const DEFAULT_SCHOOL_ID = 'school_001';

const verifyAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized — Bearer token required' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    }

    req.user     = decoded;
    req.schoolId = decoded.schoolId || DEFAULT_SCHOOL_ID;
    req.userId   = decoded.userId;
    req.userRole = decoded.role;
    req.roleId   = decoded.roleId || '';
    req.teacherName = decoded.fullName || '';
    return next();

  } catch (err) {
    console.error('[verifyAuth]', err.message);
    res.status(401).json({ error: 'Unauthorized' });
  }
};



const admin = require('firebase-admin');
const { sendAndLog } = require('../services/whatsappService');

let adminAuth = null;
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: normalizeMultilineSecret(process.env.FIREBASE_PRIVATE_KEY)
      })
    });
  }
  adminAuth = admin.auth();
  console.log('[Firebase Admin] Initialized');
} catch (e) {
  console.warn('[Firebase Admin] Skipped:', e.message);
}

let adminDb = null;
try {
  adminDb = admin.firestore();
  if (typeof adminDb.settings === 'function') {
    adminDb.settings({ preferRest: true });
  }
  console.log('[Firebase Admin] Firestore initialized');
} catch (e) {
  console.warn('[Firebase Admin] Firestore init failed:', e.message);
}

const checkSchoolActive = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    if (!schoolId || schoolId === DEFAULT_SCHOOL_ID) return next();
    if (!adminDb) return next();

    const ck = `school_status:${schoolId}`;
    let status = cacheGet(ck, 60000);
    if (status === null) {
      const schoolSnap = await adminDb.collection('schools').doc(schoolId).get();
      status = schoolSnap.exists ? (schoolSnap.data().status || 'active') : 'active';
      cacheSet(ck, status);
    }
    if (status === 'suspended') {
      return res.status(403).json({
        error: 'School account suspended. Please contact Vidhaya Layam support.',
        code: 'SCHOOL_SUSPENDED'
      });
    }
    next();
  } catch (err) {
    next();
  }
};

const multer = require('multer');
const csvParser = require('csv-parser');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { syncAttendance, syncMarks, syncUserDirectory, updateUserDirectoryOnRegistration, syncLogisticsStaff, updateUserDirectoryClasses, updateProfileInSheets, markUserInactiveInSheets, syncMasterTimetable, removeMasterTimetableEntries, syncStudentFile, syncBusTripHistory, syncStudentStop, syncStaffAttendance, syncStudent, syncTeacher, syncLeaveRequest, syncParentAccount, syncPayroll, syncNotification, resetDocCache } = require('../src/services/googleSheets');

function generateSchoolCode(schoolName, location) {
  const skipWords = ['THE','AND','OF','A','AN','HIGH','SCHOOL','SR','JR','HIGHER','SECONDARY','PUBLIC','PRIVATE','CENTRAL','CONVENT','ENGLISH','MEDIUM'];
  const nameCode = String(schoolName || '').trim().toUpperCase()
    .split(/\s+/)
    .filter(w => !skipWords.includes(w))
    .map(w => w.replace(/[^A-Z]/g, ''))
    .filter(w => w.length > 0)
    .map(w => w[0])
    .join('')
    .slice(0, 4);
  const locCode = String(location || '').trim().toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4);
  return `${nameCode}-${locCode}`;
}

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  appId: process.env.FIREBASE_APP_ID,
};

console.log('Firebase Config Check:');
console.log('  apiKey:', firebaseConfig.apiKey ? 'SET (' + firebaseConfig.apiKey.substring(0, 10) + '...)' : 'MISSING');
console.log('  authDomain:', firebaseConfig.authDomain || 'MISSING');
console.log('  projectId:', firebaseConfig.projectId || 'MISSING');
console.log('  storageBucket:', firebaseConfig.storageBucket || 'MISSING');
console.log('  appId:', firebaseConfig.appId ? 'SET' : 'MISSING');

const db = adminDb;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', 1);

// Production-ready CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5000', 'http://localhost:5001', 'http://localhost:3000', 'http://localhost:3001'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(compression({ level: 6, threshold: 1024 }));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Vidyalayam API', version: '2.0.0' }));

async function firebaseSignIn(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const errCode = data.error?.message || 'INVALID_CREDENTIALS';
    const err = new Error(errCode);
    err.code = 'auth/' + errCode.toLowerCase().replace(/_/g, '-');
    throw err;
  }
  return { user: { uid: data.localId, email: data.email, getIdToken: async () => data.idToken } };
}

app.get('/health', async (req, res) => {
  const firebaseStatus = admin.apps.length > 0 ? 'initialized' : 'missing';
  let firestoreStatus = 'unknown';
  try {
    if (adminDb) {
      await adminDb.collection('_health').doc('check').set({ lastCheck: new Date().toISOString() });
      firestoreStatus = 'connected';
    }
  } catch (e) {
    firestoreStatus = 'error: ' + e.message;
  }

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    firebase: firebaseStatus,
    firestore: firestoreStatus,
    project: process.env.FIREBASE_PROJECT_ID
  });
});
app.get('/api/auth/me', verifyAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User profile not found' });
    res.json({ user: { id: userDoc.id, ...userDoc.data() } });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching profile: ' + err.message });
  }
});

const productionOrigins = [
  process.env.APP_URL,
].filter(Boolean);

const developmentOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
  'http://localhost:8081',
  'http://localhost:19006',
];

const allowedOrigins2 = process.env.NODE_ENV === 'production'
  ? productionOrigins
  : [...productionOrigins, ...developmentOrigins];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins2.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-role-id']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(mongoSanitize());
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/login') ||
    req.path.startsWith('/api/admin/login') ||
    req.path.startsWith('/api/parent') ||
    req.path.startsWith('/api/report') ||
    req.path.startsWith('/api/register')
  ) return next();
  checkSchoolActive(req, res, next);
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; worker-src blob:; font-src 'self' data:; img-src 'self' data: https:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=(self)');
  res.removeHeader('X-Powered-By');
  next();
});
app.use('/api/', apiLimiter);
app.use('/api/whatsapp', require('../routes/whatsapp'));
app.use('/api/healthcheck', require('../routes/healthcheck'));

// ── GLOBAL AUTH GUARD ──────────────────────────────────────────
const PUBLIC_ROUTES = [
  { method: 'POST', path: '/api/login' },
  { method: 'POST', path: '/api/admin/login' },
  { method: 'POST', path: '/api/register' },
  { method: 'POST', path: '/api/forgot-password' },
  { method: 'POST', path: '/api/parent/register' },
  { method: 'POST', path: '/api/parent/email-login' },
  { method: 'POST', path: '/api/parent/forgot-password' },
  { method: 'GET',  path: '/api/parent/check-student' },
  { method: 'GET',  path: '/api/school-info' },
  { method: 'GET',  path: '/api/report' },
  { method: 'GET',  path: '/api/students/import/template' },
];

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/download/')) {
    return next();
  }
  if (req.path.startsWith('/api/super/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/school/info/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/students/qr/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/students/verify/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/whatsapp/webhook')) return next();
  if (req.method === 'POST' && req.path === '/api/whatsapp/webhook') return next();
  const isPublic = PUBLIC_ROUTES.some(
    r => r.method === req.method && req.path === r.path
  );
  if (isPublic) return next();
  return verifyAuth(req, res, next);
});
// ── END GLOBAL AUTH GUARD ───────────────────────────────────────

app.use('/api/cce', require('../routes/cce'));

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

async function safeSync(operation, syncFn, payload) {
  if (!process.env.GOOGLE_SPREADSHEET_ID) {
    return { success: false, error: 'GOOGLE_SPREADSHEET_ID not set — skipped' };
  }
  try {
    const result = await syncFn();
    if (!result.success) {
      db.collection('sync_errors').add({
        operation, payload: JSON.stringify(payload).slice(0, 4000),
        error: result.error || 'Sync returned failure', status: 'pending',
        createdAt: new Date().toISOString(), attempts: 1,
      }).catch(() => {});
      console.warn(`[GSheets] ${operation} sync failed — queued for retry: ${result.error}`);
    }
    return result;
  } catch (err) {
    db.collection('sync_errors').add({
      operation, payload: JSON.stringify(payload).slice(0, 4000),
      error: err.message, status: 'pending',
      createdAt: new Date().toISOString(), attempts: 1,
    }).catch(() => {});
    console.error(`[GSheets] ${operation} sync threw — queued for retry: ${err.message}`);
    return { success: false, error: err.message };
  }
}

app.post('/api/register', registerLimiter, validate([
  body('fullName').notEmpty().trim().withMessage('fullName is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(['teacher', 'parent', 'staff', 'student', 'driver', 'cleaner']).withMessage('Invalid role'),
  body('roleId').notEmpty().trim().withMessage('roleId is required'),
]), async (req, res) => {
  try {
    const { fullName, email: rawEmail, password, role, roleId } = req.body;
    const email = (rawEmail || '').trim().toLowerCase();
    console.log('Registration attempt for role:', role);

    if (!fullName || !email || !password || !role || !roleId) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (!['teacher', 'parent', 'staff', 'student', 'driver', 'cleaner'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be teacher, parent, staff, student, driver, or cleaner.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    let userCredential;
    try {
      userCredential = await adminAuth.createUser({ email: email, password: password });
      console.log('Firebase Auth user created:', userCredential.uid);
    } catch (authErr) {
      console.error('Firebase Auth error:', authErr.code, authErr.message);
      const errorMap = {
        'auth/email-already-in-use': 'Email already registered',
        'auth/invalid-email': 'Invalid email address',
        'auth/weak-password': 'Password is too weak (min 6 characters)',
        'auth/operation-not-allowed': 'Email/Password sign-in is NOT enabled in Firebase Console. Go to Firebase Console > Authentication > Sign-in method > Email/Password > Enable',
        'auth/configuration-not-found': 'Firebase Auth configuration not found. Please enable Email/Password authentication in Firebase Console > Authentication > Sign-in method',
      };
      const friendlyMsg = errorMap[authErr.code] || `Firebase Auth error [${authErr.code}]: ${authErr.message}`;
      return res.status(authErr.code === 'auth/email-already-in-use' ? 409 : 400).json({ error: friendlyMsg });
    }

    const uid = userCredential.uid;
    const userData = {
      uid: uid,
      full_name: fullName,
      email: email,
      role: String(role),
      role_id: roleId,
      schoolId: (req.body.schoolId || req.schoolId || DEFAULT_SCHOOL_ID),
      onboarded_by: req.body.onboardedBy || '',
      created_at: new Date().toISOString(),
      ...(role === 'parent' ? {
        studentId: roleId,
        studentIds: [roleId],
        parentName: fullName,
        accountStatus: 'active',
      } : {}),
    };

    const PRINCIPAL_EMAIL = process.env.PRINCIPAL_EMAIL || 'thatipamulavenkatesh1999@gmail.com';
    if (email === PRINCIPAL_EMAIL) {
      userData.role = 'principal';
      console.log(`Auto-promoted ${email} to principal during registration`);
    }

    console.log('Saving to Firestore for role:', userData.role);
    const usersRef = db.collection('users');

    const isPreGenerated = /^(TCH|DRV|CLN)-\d{4}(-\d{4})?$/.test(roleId);
    if (/^DRV-\d{4}$/.test(roleId)) { userData.role = 'driver'; }
    if (/^CLN-\d{4}$/.test(roleId)) { userData.role = 'cleaner'; }
    let docId;

    if (isPreGenerated) {
      const existingQ = usersRef.where('role_id', '==', roleId);
      const existingSnap = await existingQ.get();

      if (!existingSnap.empty) {
        const existingDoc = existingSnap.docs[0];
        await db.collection('users').doc(existingDoc.id).update({
          uid: uid,
          email: email,
          full_name: fullName,
          status: 'onboarded',
          created_at: userData.created_at,
        });
        docId = existingDoc.id;
        console.log(`Updated pre-generated Firestore doc ${docId} to onboarded for ${roleId}`);
      } else {
        userData.status = 'onboarded';
        const docRef = await usersRef.add(userData);
        docId = docRef.id;
        console.log('Firestore doc created (onboarded):', docId);
      }

      try {
        await updateUserDirectoryOnRegistration(roleId, email, uid);
      } catch (sheetErr) {
        console.error('Google Sheets onboard update failed:', sheetErr.message);
      }
    } else {
      const docRef = await usersRef.add(userData);
      docId = docRef.id;
      console.log('Firestore doc created:', docId, '| UID:', uid, '| Role:', userData.role);
    }

    if (userData.role === 'parent') {
      const studentIds = userData.studentIds || (roleId ? [roleId] : []);
      const parentAccountData = {
        uid,
        parentName: fullName,
        email,
        phone: '',
        studentIds,
        activeStudentId: studentIds[0] || '',
        accountStatus: 'active',
        emailVerified: false,
        failedAttempts: 0,
        lockUntil: null,
        pinHash: null,
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };
      try {
        await db.collection('parent_accounts').add(parentAccountData);
        console.log('parent_accounts doc created for:', email, '| studentId:', studentIds[0]);
      } catch (paErr) {
        console.error('Failed to create parent_accounts doc:', paErr.message);
      }
    }

    res.status(201).json({
      user: {
        id: docId,
        uid: uid,
        full_name: userData.full_name,
        email: userData.email,
        role: userData.role,
        role_id: userData.role_id,
        created_at: userData.created_at,
        profileCompleted: false,
      },
    });
  } catch (err) {
    console.error('Registration error:', err.code || '', err.message || err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body;
    const email = (rawEmail || '').trim().toLowerCase();
    console.log('Login attempt:', email);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    let userCredential;
    try {
      userCredential = await firebaseSignIn(email, password);
      console.log('Firebase Auth login success:', userCredential.user.uid);
    } catch (authErr) {
      console.error('Firebase Auth login error:', authErr.code, authErr.message);
      const errorMap = {
        'auth/user-not-found': 'Invalid email or password',
        'auth/wrong-password': 'Invalid email or password',
        'auth/invalid-credential': 'Invalid email or password',
        'auth/invalid-login-credentials': 'Invalid email or password',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/operation-not-allowed': 'Email/Password sign-in is NOT enabled. Go to Firebase Console > Authentication > Sign-in method > Enable it.',
        'auth/configuration-not-found': 'Firebase Auth not configured. Enable Email/Password in Firebase Console > Authentication.',
      };
      const friendlyMsg = errorMap[authErr.code] || 'Invalid email or password';
      return res.status(401).json({ error: friendlyMsg });
    }

    const uid = userCredential.user.uid;
    const usersRef = db.collection('users');
    const q = usersRef.where('uid', '==', uid);
    const snapshot = await q.get();

    let userDoc, user;

    if (snapshot.empty) {
      const qByEmail = usersRef.where('email', '==', email);
      const snapByEmail = await qByEmail.get();
      if (snapByEmail.empty) {
        return res.status(404).json({ error: 'User profile not found in Firestore. Please register again.' });
      }
      userDoc = snapByEmail.docs[0];
      user = userDoc.data();
    } else {
      userDoc = snapshot.docs[0];
      user = userDoc.data();
    }

    const PRINCIPAL_EMAIL = process.env.PRINCIPAL_EMAIL || 'thatipamulavenkatesh1999@gmail.com';
    if (email === PRINCIPAL_EMAIL && user.role !== 'principal') {
      await db.collection('users').doc(userDoc.id).update({ role: 'principal' });
      user.role = 'principal';
      console.log(`Auto-promoted ${email} to principal`);
    }

    const roleId = user.role_id || '';
    if (/^DRV-\d{4}$/.test(roleId) && user.role !== 'driver') {
      await db.collection('users').doc(userDoc.id).update({ role: 'driver' });
      user.role = 'driver';
      console.log(`Auto-set role to driver for ${roleId}`);
    }
    if (/^CLN-\d{4}$/.test(roleId) && user.role !== 'cleaner') {
      await db.collection('users').doc(userDoc.id).update({ role: 'cleaner' });
      user.role = 'cleaner';
      console.log(`Auto-set role to cleaner for ${roleId}`);
    }
    const isPreGenerated = /^(TCH|DRV|CLN)-\d{4}(-\d{4})?$/.test(roleId);
    if (isPreGenerated && user.status !== 'onboarded') {
      await db.collection('users').doc(userDoc.id).update({ status: 'onboarded', uid: uid, email: email });
      user.status = 'onboarded';
      console.log(`Login onboard: Updated ${roleId} status to onboarded`);

      const preGenQ = usersRef.where('role_id', '==', roleId).where('onboarded_by', '==', 'principal');
      const preGenSnap = await preGenQ.get();
      for (const preDoc of preGenSnap.docs) {
        if (preDoc.id !== userDoc.id && preDoc.data().status !== 'onboarded') {
          await db.collection('users').doc(preDoc.id).update({ status: 'onboarded', uid: uid, email: email });
          console.log(`Login onboard: Also updated pre-generated doc ${preDoc.id} to onboarded`);
        }
      }

      try {
        await updateUserDirectoryOnRegistration(roleId, email, uid);
      } catch (sheetErr) {
        console.error('Google Sheets onboard update on login failed:', sheetErr.message);
      }
    }

    let driverData = null;
    if ((user.role === 'driver' || user.role === 'cleaner') && roleId) {
      try {
        const logisticsRef = db.collection('logistics_staff');
        const drvQ = logisticsRef.where('staff_id', '==', roleId);
        const drvSnap = await drvQ.get();
        if (!drvSnap.empty) {
          const ld = drvSnap.docs[0].data();
          driverData = {
            bus_number: ld.bus_number || '',
            route: ld.route || '',
            assigned_area: ld.assigned_area || '',
            phone: ld.phone || '',
            status: ld.status || 'active',
          };
          // Sync schoolId from logistics_staff to user doc if mismatched
          if (ld.schoolId && ld.schoolId !== user.schoolId) {
            await db.collection('users').doc(userDoc.id).update({ schoolId: ld.schoolId });
            user.schoolId = ld.schoolId;
            console.log(`Synced schoolId for ${roleId}: ${user.schoolId} → ${ld.schoolId}`);
          }
          console.log('Fetched logistics data for role:', driverData.role);
        }
      } catch (drvErr) {
        console.error('Failed to fetch logistics data:', drvErr.message);
      }
    }

    console.log('Login success for role:', user.role);

    const hasProfileData = !!(user.mobile && user.blood_group && user.emergency_contact && user.date_of_birth);
    const isProfileDone = user.profileCompleted === true || hasProfileData;
    if (hasProfileData && !user.profileCompleted) {
      db.collection('users').doc(userDoc.id).update({ profileCompleted: true }).catch(() => {});
    }
    const responseUser = { id: userDoc.id, uid, full_name: user.full_name, email: user.email, role: user.role, role_id: user.role_id, created_at: user.created_at, profileCompleted: isProfileDone, schoolId: user.schoolId || req.schoolId || DEFAULT_SCHOOL_ID };
    if (user.mobile) responseUser.mobile = user.mobile;
    if (user.blood_group) responseUser.blood_group = user.blood_group;
    if (user.emergency_contact) responseUser.emergency_contact = user.emergency_contact;
    if (user.date_of_birth) responseUser.date_of_birth = user.date_of_birth;
    if (user.profileImage) responseUser.profileImage = user.profileImage;
    if (user.subject) responseUser.subject = user.subject;
    if (user.license) responseUser.license = user.license;
    if (user.experience) responseUser.experience = user.experience;
    if (driverData) {
      responseUser.bus_number = driverData.bus_number;
      responseUser.route = driverData.route;
      responseUser.assigned_area = driverData.assigned_area;
      responseUser.driver_status = driverData.status;
    }
    if (user.assignedClasses && Array.isArray(user.assignedClasses)) {
      responseUser.assignedClasses = user.assignedClasses;
    }
    if (user.classTeacherOf) {
      responseUser.classTeacherOf = user.classTeacherOf;
    }
    if (user.timetable && Array.isArray(user.timetable)) {
      responseUser.timetable = user.timetable;
    }

    const jwtToken = signToken({
      userId: userDoc.id,
      role: user.role,
      schoolId: user.schoolId || DEFAULT_SCHOOL_ID,
      roleId: user.role_id,
      email: user.email,
      fullName: user.full_name || ''
    });

    res.json({ token: jwtToken, user: responseUser });
  } catch (err) {
    console.error('Login error:', err.code || '', err.message || err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.post('/api/complete-profile', async (req, res) => {
  try {
    const { uid, docId, fullName, mobile, bloodGroup, emergencyContact, dateOfBirth, role, roleId } = req.body;

    if (!uid || !docId || !fullName || !mobile || !bloodGroup || !emergencyContact || !dateOfBirth) {
      return res.status(400).json({ error: 'All profile fields are required' });
    }

    if (req.user && req.user.userId !== docId && req.user.uid !== uid) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ error: 'Invalid mobile number' });
    }
    if (!/^[6-9]\d{9}$/.test(emergencyContact)) {
      return res.status(400).json({ error: 'Invalid emergency contact number' });
    }

    const profileData = {
      full_name: fullName,
      mobile: mobile,
      blood_group: bloodGroup,
      emergency_contact: emergencyContact,
      date_of_birth: dateOfBirth,
      profileCompleted: true,
      profile_completed_at: new Date().toISOString(),
    };

    await db.collection('users').doc(docId).update(profileData);
    console.log(`Profile completed for ${roleId || uid}: ${fullName}`);

    try {
      const isLogistics = /^(DRV|CLN)-\d{4}$/.test(roleId || '');
      await updateProfileInSheets({
        roleId: roleId || '',
        fullName,
        mobile,
        bloodGroup,
        emergencyContact,
        dateOfBirth,
        role: role || '',
        isLogistics,
      });
    } catch (sheetErr) {
      console.error('Google Sheets profile sync failed:', sheetErr.message);
    }

    res.json({ success: true, message: 'Profile saved successfully' });
  } catch (err) {
    console.error('Complete profile error:', err.message);
    res.status(500).json({ error: `Failed to save profile: ${err.message}` });
  }
});

app.get('/api/available-classes', async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const classesRef = db.collection('classes');
    const classesSnap = await classesRef.where('schoolId', '==', schoolId).get();
    const allClasses = classesSnap.docs.map(d => ({ id: d.id, name: d.data().name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const usersRef = db.collection('users');
    const allUsersSnap = await usersRef.where('schoolId', '==', schoolId).get();
    const assignedMap = {};
    allUsersSnap.docs.forEach(d => {
      const data = d.data();
      if (data.classTeacherOf) assignedMap[data.classTeacherOf] = { role_id: data.role_id, full_name: data.full_name };
    });

    const available = allClasses.filter(c => !assignedMap[c.name]);
    res.json({ success: true, classes: available, allClasses, assignedMap });
  } catch (err) {
    console.error('Get available classes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch available classes' });
  }
});

app.post('/api/check-timetable-conflict', async (req, res) => {
  try {
    const { className, days, startTime, endTime, excludeRoleId } = req.body;
    if (!className || !days || !startTime || !endTime) {
      return res.status(400).json({ error: 'className, days, startTime, endTime required' });
    }
    const parseTime = (t) => {
      if (!t) return null;
      const m = t.trim().match(/^(\d+):(\d+)\s*(AM|PM)$/i);
      if (!m) return null;
      let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
      const p = m[3].toUpperCase();
      if (p === 'PM' && h !== 12) h += 12;
      if (p === 'AM' && h === 12) h = 0;
      return h * 60 + min;
    };
    const s1 = parseTime(startTime), e1 = parseTime(endTime);
    if (s1 === null || e1 === null) return res.status(400).json({ error: 'Invalid time format' });
    const normalizedClass = className.replace(/^Grade\s+/i, '');
    const usersSnap = await db.collection('users').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('role', 'in', ['teacher', 'staff']).get();
    const classConflicts = [];
    for (const d of usersSnap.docs) {
      const data = d.data();
      if (data.role_id === excludeRoleId) continue;
      const timetable = data.timetable || [];
      for (const entry of timetable) {
        const entryClass = (entry.className || '').replace(/^Grade\s+/i, '');
        if (entryClass !== normalizedClass) continue;
        const sharedDays = (entry.days || []).filter(day => days.includes(day));
        if (!sharedDays.length) continue;
        const s2 = parseTime(entry.startTime), e2 = parseTime(entry.endTime);
        if (s2 !== null && e2 !== null && s1 < e2 && s2 < e1) {
          classConflicts.push({ teacherName: data.full_name || data.role_id, subject: entry.subject, days: sharedDays, startTime: entry.startTime, endTime: entry.endTime });
        }
      }
    }
    res.json({ conflicts: classConflicts });
  } catch (err) {
    console.error('Timetable conflict check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/set-class-teacher', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can assign class teachers' });
    }
    const { roleId, grade } = req.body;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snapshot = await q.get();
    if (snapshot.empty) return res.status(404).json({ error: 'Teacher not found' });

    if (grade) {
      const existingQ = usersRef.where('classTeacherOf', '==', grade);
      const existingSnap = await existingQ.get();
      for (const d of existingSnap.docs) {
        if (d.data().role_id !== roleId) {
          await db.collection('users').doc(d.id).update({ classTeacherOf: null });
        }
      }
    }

    for (const userDoc of snapshot.docs) {
      await db.collection('users').doc(userDoc.id).update({ classTeacherOf: grade || null });
    }

    if (grade) {
      try {
        const teacherName = snapshot.docs[0].data().full_name || roleId;
        await db.collection('teacher_notifications').add({
          roleId,
          type: 'class_teacher_assigned',
          title: `Class Teacher Assignment`,
          message: `You have been assigned as the Class Teacher of Grade ${grade}. You can now mark attendance and manage fee notifications for this class.`,
          icon: '\uD83C\uDFEB',
          schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
          read: false,
          createdAt: new Date().toISOString(),
        });
        console.log(`Notification sent to ${roleId}: class teacher of ${grade}`);
      } catch (notifErr) {
        console.error('Failed to send class teacher notification:', notifErr.message);
      }
    }

    console.log(`Set ${roleId} as class teacher of ${grade || 'none'}`);
    res.json({ success: true, roleId, classTeacherOf: grade || null });
  } catch (err) {
    console.error('Set class teacher error:', err.message);
    res.status(500).json({ error: 'Failed to set class teacher' });
  }
});

app.get('/api/class-teacher', async (req, res) => {
  try {
    const { grade } = req.query;
    if (!grade) return res.status(400).json({ error: 'grade required' });
    const q = db.collection('users').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classTeacherOf', '==', grade);
    const snap = await q.get();
    if (snap.empty) return res.json({ classTeacher: null });
    const t = snap.docs[0].data();
    res.json({ classTeacher: { role_id: t.role_id, full_name: t.full_name } });
  } catch (err) {
    console.error('Get class teacher error:', err.message);
    res.status(500).json({ error: 'Failed to get class teacher' });
  }
});

app.post('/api/fee-reminder', async (req, res) => {
  try {
    const { studentId, studentName, className, amount, dueDate, message, senderName, senderRole } = req.body;
    if (!studentId || !amount || !dueDate) return res.status(400).json({ error: 'studentId, amount, and dueDate required' });

    const reminder = {
      studentId,
      studentName: studentName || '',
      className: className || '',
      amount: Number(amount),
      dueDate,
      message: message || '',
      senderName: senderName || 'Admin',
      senderRole: senderRole || 'principal',
      status: 'pending',
      whatsappStatus: 'pending_whatsapp',
      parentAcknowledged: false,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      createdAt: new Date().toISOString(),
    };
    const docRef = await db.collection('fee_reminders').add(reminder);

    await db.collection('parent_notifications').add({
      studentId,
      studentName: studentName || '',
      message: `Fee Reminder: A balance of \u20B9${Number(amount).toLocaleString('en-IN')} is due for ${studentName || 'your child'} by ${dueDate}.`,
      type: 'fee_reminder',
      reminderId: docRef.id,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Fee reminder sent: ${studentName}, amount: ${amount}, due: ${dueDate}`);
    res.json({ success: true, reminderId: docRef.id });
  } catch (err) {
    console.error('Fee reminder error:', err.message);
    res.status(500).json({ error: 'Failed to send fee reminder' });
  }
});

app.get('/api/fee-students', async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const studentsRef = db.collection('fee_records');
    const q = studentsRef.where('schoolId', '==', schoolId);
    const snap = await q.get();
    const students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, students });
  } catch (err) {
    console.error('Fee students error:', err.message);
    res.status(500).json({ error: 'Failed to fetch fee students' });
  }
});

app.get('/api/fee-reminders', async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const q = db.collection('fee_reminders').where('studentId', '==', studentId);
    const snap = await q.get();
    const reminders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    reminders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ reminders });
  } catch (err) {
    console.error('Get fee reminders error:', err.message);
    res.status(500).json({ error: 'Failed to fetch fee reminders' });
  }
});

app.post('/api/fee-reminder/acknowledge', async (req, res) => {
  try {
    const { reminderId } = req.body;
    if (!reminderId) return res.status(400).json({ error: 'reminderId required' });
    const reminderRef = db.collection('fee_reminders').doc(reminderId);
    const existing = await reminderRef.get();
    if (!existing.exists) return res.status(404).json({ error: 'Reminder not found' });
    await reminderRef.update({
      parentAcknowledged: true,
      acknowledgedAt: new Date().toISOString(),
    });

    const reminderSnap = await db.collection('fee_reminders').doc(reminderId).get();
    if (reminderSnap.exists) {
      const data = reminderSnap.data();
      await db.collection('parent_notifications').add({
        studentId: data.studentId,
        studentName: data.studentName || '',
        message: `Payment Acknowledgement: Parent of ${data.studentName || 'student'} has marked the fee of \u20B9${Number(data.amount).toLocaleString('en-IN')} as paid. Please verify.`,
        type: 'payment_acknowledgement',
        reminderId,
        forAdmin: true,
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: new Date().toISOString(),
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Fee acknowledge error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge' });
  }
});

app.get('/api/admin/overview', verifyAuth, async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const [teachers, students, buses, classes] = await Promise.all([
      db.collection('users').where('schoolId', '==', schoolId).where('role', '==', 'teacher').get().then(s => s.size),
      db.collection('students').where('schoolId', '==', schoolId).get().then(s => s.size),
      db.collection('buses').where('schoolId', '==', schoolId).get().then(s => s.size),
      db.collection('classes').where('schoolId', '==', schoolId).get().then(s => s.size)
    ]);
    res.json({
      teachersCount: teachers,
      studentsCount: students,
      busesCount: buses,
      classesCount: classes,
      schoolId
    });
  } catch (err) {
    res.status(500).json({ error: 'Overview error: ' + err.message });
  }
});

app.get('/api/admin/fees/bulk-status', verifyAuth, async (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const { month, year } = req.query;
    const classFilter = req.query.class || '';
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const mon = Number(month);
    const yr = Number(year);

    const feeSnap = await db.collection('fee_records').where('schoolId', '==', schoolId).get();

    const students = [];
    feeSnap.docs.forEach(d => {
      const rec = d.data();
      if (classFilter && (rec.grade || '') !== classFilter && (rec.className || '') !== classFilter) return;

      const totalFee = Number(rec.totalFee) || 0;
      const discount = Number(rec.discount) || 0;
      const fine = Number(rec.fine) || 0;
      const amountDue = totalFee - discount + fine;

      const history = Array.isArray(rec.history) ? rec.history : [];
      let amountPaid = 0;
      let lastPaymentDate = '';
      let hasPaymentThisMonth = false;

      history.forEach(h => {
        const amt = Number(h.amount) || 0;
        amountPaid += amt;
        const dateStr = h.date || '';
        let payDate = null;
        if (dateStr.includes('-')) {
          payDate = new Date(dateStr);
        } else {
          payDate = new Date(dateStr);
        }
        if (payDate && !isNaN(payDate.getTime())) {
          if (payDate.getMonth() + 1 === mon && payDate.getFullYear() === yr) {
            hasPaymentThisMonth = true;
          }
          const iso = payDate.toISOString().split('T')[0];
          if (!lastPaymentDate || iso > lastPaymentDate) lastPaymentDate = iso;
        }
      });

      let feeStatus = 'unpaid';
      if (amountPaid >= amountDue) {
        feeStatus = 'paid';
      } else if (amountPaid > 0) {
        feeStatus = 'partial';
      }

      students.push({
        studentId: rec.studentId || rec.adm || d.id,
        docId: d.id,
        name: rec.name || '',
        class: rec.grade || rec.className || '',
        rollNumber: rec.roll || rec.rollNumber || '',
        feeStatus,
        amountDue,
        amountPaid,
        balance: Math.max(amountDue - amountPaid, 0),
        lastPaymentDate,
        hasPaymentThisMonth,
      });
    });

    const statusOrder = { unpaid: 0, partial: 1, paid: 2 };
    students.sort((a, b) => (statusOrder[a.feeStatus] || 0) - (statusOrder[b.feeStatus] || 0) || a.name.localeCompare(b.name));

    const summary = {
      total: students.length,
      paid: students.filter(s => s.feeStatus === 'paid').length,
      unpaid: students.filter(s => s.feeStatus === 'unpaid').length,
      partiallyPaid: students.filter(s => s.feeStatus === 'partial').length,
    };

    console.log(`[fees/bulk-status] month=${mon}/${yr} class=${classFilter || 'all'} — total:${summary.total} paid:${summary.paid} unpaid:${summary.unpaid} partial:${summary.partiallyPaid}`);
    res.json({ success: true, summary, students });
  } catch (err) {
    console.error('[fees/bulk-status] Error:', err.message);
    res.status(500).json({ error: 'Failed to load fee status' });
  }
});

app.post('/api/admin/fees/send-reminder', verifyAuth, async (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const { studentIds, month, year } = req.body;
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: 'studentIds array is required' });
    }
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = monthNames[Number(month) - 1] || `Month ${month}`;

    const feeSnap = await db.collection('fee_records').where('schoolId', '==', schoolId).get();
    const feeMap = {};
    feeSnap.docs.forEach(d => {
      const data = d.data();
      const key = data.studentId || data.adm || d.id;
      feeMap[key] = data;
    });

    let sentCount = 0;
    const batch = db.batch();
    for (const sid of studentIds) {
      try {
        const rec = feeMap[sid];
        const studentName = rec ? (rec.name || '') : '';
        const balance = rec ? Math.max((Number(rec.totalFee) || 0) - (Number(rec.discount) || 0) + (Number(rec.fine) || 0) - (rec.history || []).reduce((a, h) => a + (Number(h.amount) || 0), 0), 0) : 0;

        const notifRef = db.collection('parent_notifications').doc();
        batch.set(notifRef, {
          studentId: sid,
          studentName,
          title: 'Fee Reminder',
          message: `Fee reminder for ${monthLabel} ${year}: A balance of \u20B9${balance.toLocaleString('en-IN')} is pending for ${studentName || 'your child'}. Please clear it at the earliest.`,
          type: 'fee_reminder',
          schoolId,
          read: false,
          createdAt: new Date().toISOString(),
        });
        sentCount++;
        try {
          const stuQ = await db.collection('students').where('studentId', '==', sid).where('schoolId', '==', schoolId).get();
          const parentId = !stuQ.empty ? (stuQ.docs[0].data().parentId || stuQ.docs[0].data().parent_uid || '') : '';
          if (parentId) sendPushNotification(parentId, '🔔 Fee Reminder', `Fee payment reminder for ${studentName || sid}`, { type: 'fee_reminder', studentId: sid });
        } catch (pushErr) { console.error('[fee] Push error:', pushErr.message); }
      } catch (e) {
        console.warn(`[fees/send-reminder] Failed for ${sid}:`, e.message);
      }
    }
    await batch.commit();

    console.log(`[fees/send-reminder] Sent ${sentCount}/${studentIds.length} reminders for ${monthLabel} ${year}`);
    res.json({ success: true, sent: sentCount });
  } catch (err) {
    console.error('[fees/send-reminder] Error:', err.message);
    res.status(500).json({ error: 'Failed to send reminders' });
  }
});

app.post('/api/fee/structure/save', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { classId, className, tuitionFee, busFee, miscFee, dueDay, academicYear, quarter } = req.body;
    if (!classId || !academicYear || tuitionFee === undefined) {
      return res.status(400).json({ error: 'classId, academicYear and tuitionFee are required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const structureId = `${schoolId}_${classId}_${academicYear}`;
    await adminDb.collection('fee_structure').doc(structureId).set({
      structureId, schoolId, classId, className: className || classId,
      tuitionFee: Number(tuitionFee) || 0,
      busFee: Number(busFee) || 0,
      miscFee: Number(miscFee) || 0,
      totalFee: (Number(tuitionFee) || 0) + (Number(busFee) || 0) + (Number(miscFee) || 0),
      dueDay: Number(dueDay) || 10,
      academicYear, quarter: quarter || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ success: true, structureId });
  } catch (err) {
    console.error('[fee/structure/save] Error:', err.message);
    res.status(500).json({ error: 'Failed to save fee structure' });
  }
});

app.get('/api/fee/structure', verifyAuth, async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const { academicYear } = req.query;
    let query = adminDb.collection('fee_structure').where('schoolId', '==', schoolId);
    if (academicYear) query = query.where('academicYear', '==', academicYear);
    const snap = await query.get();
    const structures = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, structures });
  } catch (err) {
    console.error('[fee/structure] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch fee structures' });
  }
});

app.post('/api/fee/discount/save', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { studentId, discountType, discountValue, reason } = req.body;
    if (!studentId || !discountType) {
      return res.status(400).json({ error: 'studentId and discountType are required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const discountId = `${schoolId}_${studentId}`;
    await adminDb.collection('fee_discounts').doc(discountId).set({
      discountId, schoolId, studentId,
      discountType, discountValue: Number(discountValue) || 0,
      reason: reason || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    console.error('[fee/discount/save] Error:', err.message);
    res.status(500).json({ error: 'Failed to save discount' });
  }
});

app.get('/api/fee/discount/:studentId', verifyAuth, async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const { studentId } = req.params;
    const discountId = `${schoolId}_${studentId}`;
    const snap = await adminDb.collection('fee_discounts').doc(discountId).get();
    if (!snap.exists) return res.json({ success: true, discount: null });
    res.json({ success: true, discount: snap.data() });
  } catch (err) {
    console.error('[fee/discount] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch discount' });
  }
});

app.post('/api/fee/generate-records', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { classId, academicYear, quarter } = req.body;
    if (!classId || !academicYear || !quarter) {
      return res.status(400).json({ error: 'classId, academicYear and quarter are required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const structureId = `${schoolId}_${classId}_${academicYear}`;
    const structureSnap = await adminDb.collection('fee_structure').doc(structureId).get();
    if (!structureSnap.exists) {
      return res.status(404).json({ error: 'Fee structure not found for this class. Please save it first.' });
    }
    const structure = structureSnap.data();

    const studentsSnap = await adminDb.collection('students')
      .where('schoolId', '==', schoolId)
      .where('classId', '==', classId)
      .get();

    if (studentsSnap.empty) {
      return res.status(404).json({ error: 'No students found in this class' });
    }

    const dueDate = new Date();
    dueDate.setDate(structure.dueDay || 10);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const batch = adminDb.batch();
    let recordsCreated = 0;

    for (const studentDoc of studentsSnap.docs) {
      const student = studentDoc.data();
      const studentId = student.studentId || studentDoc.id;

      const discountId = `${schoolId}_${studentId}`;
      const discountSnap = await adminDb.collection('fee_discounts').doc(discountId).get();
      const discount = discountSnap.exists ? discountSnap.data() : null;

      let discountAmount = 0;
      if (discount) {
        if (discount.discountType === 'waiver') {
          discountAmount = structure.totalFee;
        } else if (discount.discountType === 'percentage') {
          discountAmount = Math.round((structure.totalFee * (discount.discountValue || 0)) / 100);
        } else {
          discountAmount = discount.discountValue || 0;
        }
      }

      const netAmount = Math.max(0, structure.totalFee - discountAmount);
      const recordId = `${schoolId}_${studentId}_${academicYear}_Q${quarter}`;
      const recordRef = adminDb.collection('fee_records').doc(recordId);

      batch.set(recordRef, {
        recordId, studentId, studentName: student.name || student.full_name || '',
        classId, className: structure.className, schoolId, academicYear,
        quarter: Number(quarter),
        tuitionFee: structure.tuitionFee,
        busFee: structure.busFee,
        miscFee: structure.miscFee,
        discountType: discount?.discountType || null,
        discountValue: discountAmount,
        totalAmount: structure.totalFee,
        netAmount,
        dueDate: dueDateStr,
        status: 'pending',
        paymentMethod: null, paidAt: null, receiptNumber: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: false });
      recordsCreated++;
    }

    await batch.commit();
    res.json({ success: true, recordsCreated });
  } catch (err) {
    console.error('[fee/generate-records] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate fee records' });
  }
});

async function generateReceiptNumber(schoolId) {
  const initials = (schoolId || 'SC').split(/[-_\s]+/).filter(Boolean).map(p => p[0]).join('').toUpperCase().substring(0, 2);
  const year = new Date().getFullYear();
  const counterRef = adminDb.collection('fee_counters').doc(`${schoolId}_${year}`);
  let seq = 1;
  try {
    seq = await adminDb.runTransaction(async (t) => {
      const doc = await t.get(counterRef);
      const next = (doc.exists ? (doc.data().count || 0) : 0) + 1;
      t.set(counterRef, { count: next, schoolId, year }, { merge: true });
      return next;
    });
  } catch (e) {
    seq = Math.floor(Math.random() * 9000) + 1000;
  }
  return `RCP-${initials}-${year}-${String(seq).padStart(4, '0')}`;
}

app.post('/api/fee/payment/cash', verifyAuth, validate([
  body('studentId').notEmpty().trim().withMessage('studentId is required'),
  body('academicYear').notEmpty().trim().withMessage('academicYear is required'),
  body('quarter').notEmpty().withMessage('quarter is required'),
  body('amountPaid').isNumeric().isFloat({ min: 1 }).withMessage('amountPaid must be a positive number'),
]), async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { studentId, academicYear, quarter, amountPaid, paymentMethod, receiptNumber: customReceipt, notes } = req.body;
    if (!studentId || !academicYear || !quarter || !amountPaid) {
      return res.status(400).json({ error: 'studentId, academicYear, quarter and amountPaid are required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const recordId = `${schoolId}_${studentId}_${academicYear}_Q${quarter}`;
    const recordSnap = await adminDb.collection('fee_records').doc(recordId).get();

    const receiptNumber = customReceipt || await generateReceiptNumber(schoolId);
    const paidAt = new Date().toISOString();
    const recordedBy = req.userId || 'admin';

    const updateData = {
      status: 'paid', paidAt, amountPaid: Number(amountPaid),
      paymentMethod: paymentMethod || 'cash',
      receiptNumber, recordedBy, notes: notes || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await adminDb.collection('fee_records').doc(recordId).set(updateData, { merge: true });

    const studentData = recordSnap.exists ? recordSnap.data() : {};
    const txData = {
      transactionId: receiptNumber, studentId,
      studentName: studentData.studentName || '',
      classId: studentData.classId || '', className: studentData.className || '',
      schoolId, academicYear, quarter: Number(quarter),
      amountPaid: Number(amountPaid), paymentMethod: paymentMethod || 'cash',
      receiptNumber, recordedBy, paidAt, notes: notes || '',
      type: 'manual',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await adminDb.collection('fee_transactions').add(txData);

    const studentSnap = await adminDb.collection('students').where('studentId', '==', studentId).where('schoolId', '==', schoolId).limit(1).get();
    if (!studentSnap.empty) {
      const stuData = studentSnap.docs[0].data();
      const parentId = stuData.parentId;
      const parentPhone = stuData.parentPhone || '';
      if (parentId) {
        sendPushNotification(parentId, '\u2705 Fee Payment Received',
          `Fee payment of \u20B9${Number(amountPaid).toLocaleString('en-IN')} received for Q${quarter}. Receipt: ${receiptNumber}`,
          { type: 'fee_paid', receiptNumber, quarter: String(quarter) });
      }
      if (parentPhone) {
        sendAndLog(schoolId, parentPhone, 'vl_fee_receipt',
          [stuData.name || studentId, `₹${Number(amountPaid).toLocaleString('en-IN')}`, receiptNumber, new Date(paidAt).toLocaleDateString('en-IN')],
          { studentName: stuData.name || studentId }
        ).catch(() => {});
      }
    }

    res.json({ success: true, receiptNumber });
  } catch (err) {
    console.error('[fee/payment/cash] Error:', err.message);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

app.post('/api/fee/payment/online', verifyAuth, async (req, res) => {
  try {
    const { studentId, academicYear, quarter, amountPaid, transactionId, paymentMethod } = req.body;
    if (!studentId || !academicYear || !quarter || !amountPaid) {
      return res.status(400).json({ error: 'studentId, academicYear, quarter and amountPaid are required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const recordId = `${schoolId}_${studentId}_${academicYear}_Q${quarter}`;
    const recordSnap = await adminDb.collection('fee_records').doc(recordId).get();

    const receiptNumber = await generateReceiptNumber(schoolId);
    const paidAt = new Date().toISOString();
    const recordedBy = req.userId || studentId;

    const updateData = {
      status: 'paid', paidAt, amountPaid: Number(amountPaid),
      paymentMethod: paymentMethod || 'upi',
      receiptNumber, transactionId: transactionId || '', recordedBy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await adminDb.collection('fee_records').doc(recordId).set(updateData, { merge: true });

    const studentData = recordSnap.exists ? recordSnap.data() : {};
    const txData = {
      transactionId: transactionId || receiptNumber, studentId,
      studentName: studentData.studentName || '',
      classId: studentData.classId || '', className: studentData.className || '',
      schoolId, academicYear, quarter: Number(quarter),
      amountPaid: Number(amountPaid), paymentMethod: paymentMethod || 'upi',
      receiptNumber, recordedBy, paidAt,
      type: 'online',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await adminDb.collection('fee_transactions').add(txData);

    const parentId = req.userId;
    if (parentId) {
      sendPushNotification(parentId, '\u2705 Payment Successful!',
        `Payment of \u20B9${Number(amountPaid).toLocaleString('en-IN')} confirmed. Receipt: ${receiptNumber}`,
        { type: 'fee_paid', receiptNumber, quarter: String(quarter) });
    }

    res.json({ success: true, receiptNumber });
  } catch (err) {
    console.error('[fee/payment/online] Error:', err.message);
    res.status(500).json({ error: 'Failed to record online payment' });
  }
});

app.get('/api/fee/transactions/:studentId', verifyAuth, async (req, res) => {
  try {
    const { studentId } = req.params;
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const snap = await adminDb.collection('fee_transactions')
      .where('studentId', '==', studentId)
      .where('schoolId', '==', schoolId)
      .get();
    const transactions = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.paidAt || '').localeCompare(a.paidAt || ''));
    res.json({ success: true, transactions });
  } catch (err) {
    console.error('[fee/transactions] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/fee/receipt/:receiptNumber', verifyAuth, async (req, res) => {
  try {
    const { receiptNumber } = req.params;
    const snap = await adminDb.collection('fee_transactions')
      .where('receiptNumber', '==', receiptNumber)
      .limit(1)
      .get();
    if (snap.empty) return res.status(404).json({ error: 'Receipt not found' });
    const data = snap.docs[0].data();
    const schoolId = data.schoolId || DEFAULT_SCHOOL_ID;
    let schoolName = 'Vidyalayam';
    try {
      const schoolSnap = await adminDb.collection('schools').doc(schoolId).get();
      if (schoolSnap.exists) schoolName = schoolSnap.data().name || schoolName;
    } catch (_) {}
    res.json({
      success: true,
      receipt: {
        receiptNumber: data.receiptNumber,
        studentName: data.studentName,
        studentId: data.studentId,
        className: data.className,
        schoolName,
        academicYear: data.academicYear,
        quarter: data.quarter,
        amountPaid: data.amountPaid,
        paymentMethod: data.paymentMethod,
        paidAt: data.paidAt,
        recordedBy: data.recordedBy,
        type: data.type,
      },
    });
  } catch (err) {
    console.error('[fee/receipt] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

app.post('/api/fee/reminders/send-manual', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { studentIds, quarter, academicYear, type, customMessage } = req.body;
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: 'studentIds array required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const sentBy = req.userId || 'admin';
    const sentAt = new Date().toISOString();
    let sentCount = 0;

    for (const studentId of studentIds) {
      const recordId = `${schoolId}_${studentId}_${academicYear}_Q${quarter}`;
      const recordSnap = await adminDb.collection('fee_records').doc(recordId).get();
      const record = recordSnap.exists ? recordSnap.data() : {};

      const amount = record.netAmount || record.totalAmount || 0;
      const dueDate = record.dueDate || '';
      const studentName = record.studentName || studentId;

      let message = customMessage;
      if (!message) {
        if (type === 'overdue') {
          message = `\u26A0\uFE0F Fee Overdue: \u20B9${Number(amount).toLocaleString('en-IN')} was due on ${dueDate}. Please pay immediately.`;
        } else {
          message = `\uD83D\uDCC5 Fee Reminder: \u20B9${Number(amount).toLocaleString('en-IN')} is due on ${dueDate} for Q${quarter}.`;
        }
      }

      const studentSnap = await adminDb.collection('students').where('studentId', '==', studentId).where('schoolId', '==', schoolId).limit(1).get();
      if (!studentSnap.empty) {
        const parentId = studentSnap.docs[0].data().parentId;
        if (parentId) {
          const title = type === 'overdue' ? '\u26A0\uFE0F Fee Overdue Alert' : '\uD83D\uDCC5 Fee Reminder';
          sendPushNotification(parentId, title, message, { type: 'fee_reminder', studentId, quarter: String(quarter), academicYear });
        }
      }

      await adminDb.collection('fee_reminders').add({
        studentId, studentName, quarter: Number(quarter), academicYear,
        type: type || 'reminder', sentAt, sentBy, message, schoolId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      sentCount++;
    }

    res.json({ success: true, sent: sentCount });
  } catch (err) {
    console.error('[fee/reminders/send-manual] Error:', err.message);
    res.status(500).json({ error: 'Failed to send reminders' });
  }
});

app.post('/api/fee/reminders/send-bulk', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { classId, quarter, academicYear, statusFilter, type, customMessage } = req.body;
    if (!academicYear || !quarter) {
      return res.status(400).json({ error: 'academicYear and quarter are required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const sentBy = req.userId || 'admin';
    const sentAt = new Date().toISOString();

    let query = adminDb.collection('fee_records')
      .where('schoolId', '==', schoolId)
      .where('academicYear', '==', academicYear)
      .where('quarter', '==', Number(quarter));
    if (classId) query = query.where('classId', '==', classId);
    if (statusFilter && statusFilter !== 'all') query = query.where('status', '==', statusFilter);

    const snap = await query.get();
    if (snap.empty) return res.json({ success: true, sent: 0 });

    let sentCount = 0;
    for (const doc of snap.docs) {
      const record = doc.data();
      const studentId = record.studentId;
      const amount = record.netAmount || record.totalAmount || 0;
      const dueDate = record.dueDate || '';
      const studentName = record.studentName || studentId;

      let message = customMessage;
      if (!message) {
        if (type === 'overdue') {
          message = `\u26A0\uFE0F Fee Overdue: \u20B9${Number(amount).toLocaleString('en-IN')} was due on ${dueDate}. Please pay immediately.`;
        } else {
          message = `\uD83D\uDCC5 Fee Reminder: \u20B9${Number(amount).toLocaleString('en-IN')} is due on ${dueDate} for Q${quarter}.`;
        }
      }

      const studentSnap = await adminDb.collection('students').where('studentId', '==', studentId).where('schoolId', '==', schoolId).limit(1).get();
      if (!studentSnap.empty) {
        const parentId = studentSnap.docs[0].data().parentId;
        if (parentId) {
          const title = type === 'overdue' ? '\u26A0\uFE0F Fee Overdue Alert' : '\uD83D\uDCC5 Fee Reminder';
          sendPushNotification(parentId, title, message, { type: 'fee_reminder', studentId, quarter: String(quarter), academicYear });
        }
      }

      await adminDb.collection('fee_reminders').add({
        studentId, studentName, quarter: Number(quarter), academicYear,
        type: type || 'reminder', sentAt, sentBy, message, schoolId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      sentCount++;
    }

    res.json({ success: true, sent: sentCount });
  } catch (err) {
    console.error('[fee/reminders/send-bulk] Error:', err.message);
    res.status(500).json({ error: 'Failed to send bulk reminders' });
  }
});

app.get('/api/fee/reminders/schedule', verifyAuth, async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const { academicYear, quarter } = req.query;
    let query = adminDb.collection('fee_records')
      .where('schoolId', '==', schoolId)
      .where('status', '==', 'pending');
    if (academicYear) query = query.where('academicYear', '==', academicYear);
    if (quarter) query = query.where('quarter', '==', Number(quarter));

    const snap = await query.get();
    const today = new Date();
    const schedule = [];

    snap.docs.forEach(doc => {
      const r = doc.data();
      if (!r.dueDate) return;
      const due = new Date(r.dueDate);
      const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));
      let nextReminder = null;
      if (diffDays === 7) nextReminder = 'Today (7-day reminder)';
      else if (diffDays === 1) nextReminder = 'Today (1-day reminder)';
      else if (diffDays < 0 && Math.abs(diffDays) === 1) nextReminder = 'Today (1-day overdue)';
      else if (diffDays < 0 && Math.abs(diffDays) === 7) nextReminder = 'Today (7-day overdue)';
      else if (diffDays < 0 && Math.abs(diffDays) === 30) nextReminder = 'Today (30-day overdue)';
      else if (diffDays > 0) nextReminder = `In ${diffDays} days`;
      else if (diffDays < 0) nextReminder = `${Math.abs(diffDays)} days overdue`;

      schedule.push({
        studentId: r.studentId, studentName: r.studentName,
        classId: r.classId, className: r.className,
        quarter: r.quarter, academicYear: r.academicYear,
        dueDate: r.dueDate, netAmount: r.netAmount,
        diffDays, nextReminder,
      });
    });

    schedule.sort((a, b) => a.diffDays - b.diffDays);
    res.json({ success: true, schedule });
  } catch (err) {
    console.error('[fee/reminders/schedule] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

app.post('/api/fee/reminders/auto-schedule', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { academicYear, quarter, enabled } = req.body;
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    await adminDb.collection('fee_reminder_settings').doc(schoolId).set({
      schoolId, academicYear, quarter: quarter || null,
      enabled: Boolean(enabled),
      remindDaysBefore: [7, 1],
      overdueRemindDays: [1, 7, 30],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    console.error('[fee/reminders/auto-schedule] Error:', err.message);
    res.status(500).json({ error: 'Failed to save auto-reminder settings' });
  }
});

app.get('/api/fee/reports/summary', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { academicYear, quarter } = req.query;
    if (!academicYear || !quarter) return res.status(400).json({ error: 'academicYear and quarter required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const recordsSnap = await adminDb.collection('fee_records')
      .where('schoolId', '==', schoolId)
      .where('academicYear', '==', academicYear)
      .where('quarter', '==', Number(quarter))
      .get();

    const txSnap = await adminDb.collection('fee_transactions')
      .where('schoolId', '==', schoolId)
      .where('academicYear', '==', academicYear)
      .where('quarter', '==', Number(quarter))
      .get();

    let totalExpected = 0, totalCollected = 0, totalPending = 0, totalOverdue = 0;
    const classSummaryMap = {};
    const methodBreakdown = { cash: 0, cheque: 0, upi: 0, card: 0 };

    recordsSnap.docs.forEach(doc => {
      const r = doc.data();
      const net = r.netAmount || r.totalAmount || 0;
      const paid = r.paid || 0;
      const status = (r.status || '').toLowerCase();
      totalExpected += net;
      totalCollected += paid;
      if (status === 'overdue') totalOverdue += (net - paid);
      else if (status === 'pending' || status === 'upcoming') totalPending += (net - paid);

      const cid = r.classId || 'unknown';
      if (!classSummaryMap[cid]) {
        classSummaryMap[cid] = { classId: cid, className: r.className || cid, totalStudents: 0, paid: 0, pending: 0, overdue: 0, amountCollected: 0, amountPending: 0 };
      }
      classSummaryMap[cid].totalStudents++;
      if (status === 'paid' || status === 'cleared') { classSummaryMap[cid].paid++; classSummaryMap[cid].amountCollected += paid; }
      else if (status === 'overdue') { classSummaryMap[cid].overdue++; classSummaryMap[cid].amountPending += (net - paid); }
      else { classSummaryMap[cid].pending++; classSummaryMap[cid].amountPending += (net - paid); }
    });

    txSnap.docs.forEach(doc => {
      const t = doc.data();
      const method = (t.paymentMethod || 'cash').toLowerCase();
      const amount = Number(t.amountPaid || 0);
      if (method === 'cash') methodBreakdown.cash += amount;
      else if (method === 'cheque') methodBreakdown.cheque += amount;
      else if (method === 'upi') methodBreakdown.upi += amount;
      else if (method === 'card') methodBreakdown.card += amount;
    });

    const collectionPercentage = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;

    res.json({
      success: true,
      totalExpected, totalCollected, totalPending, totalOverdue, collectionPercentage,
      classSummary: Object.values(classSummaryMap).sort((a, b) => a.className.localeCompare(b.className)),
      paymentMethodBreakdown: methodBreakdown,
    });
  } catch (err) {
    console.error('[fee/reports/summary] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

app.get('/api/fee/reports/defaulters', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { academicYear, quarter, classId } = req.query;
    if (!academicYear || !quarter) return res.status(400).json({ error: 'academicYear and quarter required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const today = new Date();

    let query = adminDb.collection('fee_records')
      .where('schoolId', '==', schoolId)
      .where('academicYear', '==', academicYear)
      .where('quarter', '==', Number(quarter));
    if (classId) query = query.where('classId', '==', classId);
    const recordsSnap = await query.get();

    const defaulters = [];
    for (const doc of recordsSnap.docs) {
      const r = doc.data();
      const status = (r.status || '').toLowerCase();
      if (status !== 'pending' && status !== 'overdue') continue;

      const net = r.netAmount || r.totalAmount || 0;
      const paid = r.paid || 0;
      if (net - paid <= 0) continue;

      let daysOverdue = 0;
      if (r.dueDate) {
        const due = new Date(r.dueDate);
        daysOverdue = Math.max(0, Math.round((today - due) / (1000 * 60 * 60 * 24)));
      }

      const lastReminderSnap = await adminDb.collection('fee_reminders')
        .where('studentId', '==', r.studentId)
        .where('schoolId', '==', schoolId)
        .where('quarter', '==', r.quarter)
        .orderBy('sentAt', 'desc')
        .limit(1)
        .get();
      const lastReminderSent = lastReminderSnap.empty ? null : lastReminderSnap.docs[0].data().sentAt;

      let contactNumber = null;
      const studentSnap = await adminDb.collection('students').where('studentId', '==', r.studentId).where('schoolId', '==', schoolId).limit(1).get();
      if (!studentSnap.empty) contactNumber = studentSnap.docs[0].data().contactNumber || studentSnap.docs[0].data().phone || null;

      defaulters.push({
        studentId: r.studentId, studentName: r.studentName || r.studentId,
        classId: r.classId, className: r.className || r.classId,
        netAmount: net - paid, totalFee: net, paid,
        dueDate: r.dueDate || null, daysOverdue, lastReminderSent,
        contactNumber, status,
      });
    }

    defaulters.sort((a, b) => b.daysOverdue - a.daysOverdue);
    res.json({ success: true, students: defaulters });
  } catch (err) {
    console.error('[fee/reports/defaulters] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch defaulters' });
  }
});

app.get('/api/fee/reports/export', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { academicYear, quarter } = req.query;
    if (!academicYear || !quarter) return res.status(400).json({ error: 'academicYear and quarter required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const recordsSnap = await adminDb.collection('fee_records')
      .where('schoolId', '==', schoolId)
      .where('academicYear', '==', academicYear)
      .where('quarter', '==', Number(quarter))
      .get();

    const txMap = {};
    const txSnap = await adminDb.collection('fee_transactions')
      .where('schoolId', '==', schoolId)
      .where('academicYear', '==', academicYear)
      .where('quarter', '==', Number(quarter))
      .get();
    txSnap.docs.forEach(doc => {
      const t = doc.data();
      if (!txMap[t.studentId]) txMap[t.studentId] = [];
      txMap[t.studentId].push(t);
    });

    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const header = ['Student ID', 'Name', 'Class', 'Tuition', 'Bus', 'Misc', 'Discount', 'Net Amount', 'Status', 'Paid Date', 'Payment Method', 'Receipt Number'];
    const rows = [header.join(',')];

    recordsSnap.docs.forEach(doc => {
      const r = doc.data();
      const txList = txMap[r.studentId] || [];
      const lastTx = txList.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))[0] || {};
      const paidDate = lastTx.paidAt ? new Date(lastTx.paidAt).toLocaleDateString('en-IN') : '';
      rows.push([
        escape(r.studentId), escape(r.studentName), escape(r.className || r.classId),
        escape(r.tuitionFee || 0), escape(r.busFee || 0), escape(r.miscFee || 0),
        escape(r.discount || 0), escape(r.netAmount || r.totalAmount || 0),
        escape(r.status), escape(paidDate), escape(lastTx.paymentMethod || ''), escape(lastTx.receiptNumber || ''),
      ].join(','));
    });

    const csv = rows.join('\n');
    const filename = `FeeReport_Q${quarter}_${academicYear.replace('-', '_')}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[fee/reports/export] Error:', err.message);
    res.status(500).json({ error: 'Failed to export report' });
  }
});

cron.schedule('0 8 * * *', async () => {
  console.log('[FeeReminderJob] Running daily fee reminder check...');
  try {
    const schoolsSnap = await adminDb.collection('fee_reminder_settings').where('enabled', '==', true).get();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    let totalSent = 0;

    for (const settingDoc of schoolsSnap.docs) {
      const settings = settingDoc.data();
      const schoolId = settings.schoolId;
      const remindBefore = settings.remindDaysBefore || [7, 1];
      const remindAfter = settings.overdueRemindDays || [1, 7, 30];

      const pendingSnap = await adminDb.collection('fee_records')
        .where('schoolId', '==', schoolId)
        .where('status', '==', 'pending')
        .get();

      for (const doc of pendingSnap.docs) {
        const record = doc.data();
        if (!record.dueDate || !record.studentId) continue;

        const dueDate = new Date(record.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const diffDays = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));

        const triggerBefore = remindBefore.includes(diffDays);
        const triggerAfter = remindAfter.includes(Math.abs(diffDays)) && diffDays < 0;
        if (!triggerBefore && !triggerAfter) continue;

        const alreadySentSnap = await adminDb.collection('fee_reminders')
          .where('studentId', '==', record.studentId)
          .where('schoolId', '==', schoolId)
          .where('quarter', '==', record.quarter)
          .where('sentAt', '>=', todayStr)
          .limit(1)
          .get();
        if (!alreadySentSnap.empty) continue;

        const amount = record.netAmount || record.totalAmount || 0;
        const isOverdue = diffDays < 0;
        const message = isOverdue
          ? `\u26A0\uFE0F Fee Overdue: \u20B9${Number(amount).toLocaleString('en-IN')} was due on ${record.dueDate}. Please pay immediately.`
          : `\uD83D\uDCC5 Fee Reminder: \u20B9${Number(amount).toLocaleString('en-IN')} is due on ${record.dueDate} for Q${record.quarter}.`;

        const studentSnap = await adminDb.collection('students').where('studentId', '==', record.studentId).where('schoolId', '==', schoolId).limit(1).get();
        if (!studentSnap.empty) {
          const parentId = studentSnap.docs[0].data().parentId;
          if (parentId) {
            const title = isOverdue ? '\u26A0\uFE0F Fee Overdue Alert' : '\uD83D\uDCC5 Fee Due Reminder';
            sendPushNotification(parentId, title, message, { type: 'fee_reminder_auto', quarter: String(record.quarter), studentId: record.studentId });
          }
        }

        await adminDb.collection('fee_reminders').add({
          studentId: record.studentId, studentName: record.studentName || '',
          quarter: record.quarter, academicYear: record.academicYear,
          type: isOverdue ? 'overdue' : 'reminder',
          sentAt: new Date().toISOString(), sentBy: 'auto',
          message, schoolId, auto: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        totalSent++;
      }
    }
    console.log(`[FeeReminderJob] Done — ${totalSent} notifications sent`);
  } catch (err) {
    console.error('[FeeReminderJob] Error:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

app.get('/api/classes', async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const ck = `classes:${schoolId}`;
    const cached = cacheGet(ck, 30000);
    if (cached) return res.json(cached);

    const [classesSnap, studentsSnap] = await Promise.all([
      db.collection('classes').where('schoolId', '==', schoolId).get(),
      db.collection('students').where('schoolId', '==', schoolId).get(),
    ]);

    const countByClass = {};
    studentsSnap.docs.forEach(d => {
      const cid = d.data().classId;
      if (cid) countByClass[cid] = (countByClass[cid] || 0) + 1;
    });

    const classes = classesSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      studentCount: countByClass[d.id] || 0,
    }));

    const result = { success: true, classes };
    cacheSet(ck, result);
    res.json(result);
  } catch (err) {
    console.error('Get classes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

app.post('/api/classes/add', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { className } = req.body;
    if (!className) return res.status(400).json({ error: 'Class name is required' });

    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const schoolSnap = await db.collection('schools').doc(schoolId).get();
    const rawName = (schoolSnap.exists && schoolSnap.data().name) ? schoolSnap.data().name : schoolId;
    const initials = rawName
      .split(/[\s_-]+/)
      .filter(w => w.length > 0)
      .map(w => w[0].toUpperCase())
      .join('');

    const cleanName = className.replace(/\s+/g, '').toUpperCase();
    const classId = `${initials}-${cleanName}`;

    const existing = await db.collection('classes')
      .where('schoolId', '==', schoolId)
      .where('name', '==', className)
      .get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'Class already exists' });
    }

    await db.collection('classes').doc(classId).set({
      classId,
      name: className,
      studentCount: 0,
      schoolId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    cacheDel('classes:');
    console.log('Class added successfully with ID:', classId);
    res.json({ success: true, id: classId });
  } catch (err) {
    console.error('Add class error:', err.message);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

app.delete('/api/classes/:id', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can delete classes' });
    }
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Class ID required' });
    await db.collection('classes').doc(id).delete();
    cacheDel('classes:');
    res.json({ success: true });
  } catch (err) {
    console.error('Delete class by ID error:', err.message);
    res.status(500).json({ error: 'Failed to delete class' });
  }
});

app.post('/api/classes/delete', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { className } = req.body;
    if (!className) return res.status(400).json({ error: 'className required' });
    
    const classesRef = db.collection('classes');
    const q = classesRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('name', '==', className);
    const snapshot = await q.get();
    
    for (const d of snapshot.docs) {
      await db.collection('classes').doc(d.id).delete();
    }
    
    cacheDel('classes:');
    res.json({ success: true });
  } catch (err) {
    console.error('Delete class error:', err.message);
    res.status(500).json({ error: 'Failed to delete class' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can add students' });
    }
    const { name, rollNumber, classId, className, parentPhone, busId, routeId } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Student name is required' });
    if (!classId) return res.status(400).json({ error: 'classId is required' });
    if (!rollNumber) return res.status(400).json({ error: 'Roll number is required' });

    const studentsRef = db.collection('students');
    const dupQ = studentsRef.where('classId', '==', classId).where('rollNumber', '==', Number(rollNumber));
    const dupSnap = await dupQ.get();
    if (!dupSnap.empty) {
      return res.status(400).json({ error: `Roll number ${rollNumber} already exists in this class` });
    }

    const studentId = 'STU' + Date.now();
    const docRef = await studentsRef.add({
      studentId,
      name: name.trim(),
      rollNumber: Number(rollNumber),
      classId,
      className: String(className || '').trim(),
      parentPhone: String(parentPhone || '').trim(),
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      busId: String(busId || '').trim(),
      routeId: String(routeId || '').trim(),
      status: 'active',
      qrCode: `SREE_PRAGATHI|${(req.schoolId || DEFAULT_SCHOOL_ID)}|${studentId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('Student added:', name.trim(), '| Class:', className, '| Roll:', rollNumber);
    res.json({ success: true, id: docRef.id, studentId });
    safeSync('syncStudent', () => syncStudent({ studentId, name: name.trim(), rollNumber: Number(rollNumber), className: className || '', classId, parentPhone: parentPhone || '', createdAt: new Date().toISOString() }), { studentId }).catch(() => {});
  } catch (err) {
    console.error('Add student error:', err.message);
    res.status(500).json({ error: 'Failed to add student' });
  }
});

app.get('/api/students/import/template', (req, res) => {
  const csv = `Admission Number,Student Name,Father Name,Class,Date of Birth\r\n1001,Venkatesh Kumar,Ramesh Kumar,6A,15-06-2012\r\n1002,Priya Sharma,Suresh Sharma,7B,22-09-2011\r\n`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="StudentImportTemplate.csv"');
  res.send(csv);
});

app.get('/api/students/list', async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const { classId, search } = req.query;
    let q = db.collection('students').where('schoolId', '==', schoolId);
    if (classId) q = q.where('classId', '==', classId);
    const snap = await q.get();
    let students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (search) {
      const s = search.toLowerCase();
      students = students.filter(st =>
        (st.studentName || st.name || '').toLowerCase().includes(s) ||
        (st.studentId   || '').toLowerCase().includes(s) ||
        (st.admissionNumber || '').toLowerCase().includes(s)
      );
    }
    students.sort((a, b) => {
      const ca = a.className || '';
      const cb = b.className || '';
      if (ca !== cb) return ca.localeCompare(cb);
      return (a.studentName || a.name || '').localeCompare(b.studentName || b.name || '');
    });
    res.json({ success: true, students, total: students.length });
  } catch (err) {
    console.error('[students/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/import', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Principal access required' });
    }
    const { students: rows, academicYear } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No students provided' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const schoolIdClean = schoolId.replace(/-/g, '').toUpperCase();

    let schoolName = '', logoUrl = '', primaryColor = '#1a3c5e', location = '';
    try {
      const schoolSnap = await adminDb.collection('schools').doc(schoolId).get();
      if (schoolSnap.exists) {
        const sd = schoolSnap.data();
        schoolName   = sd.schoolName   || '';
        logoUrl      = sd.logoUrl      || '';
        primaryColor = sd.primaryColor || '#1a3c5e';
        location     = sd.location     || '';
      }
    } catch (_) {}

    const classesSnap = await db.collection('classes').where('schoolId', '==', schoolId).get();
    const classMap = {};
    classesSnap.docs.forEach(d => {
      const data = d.data();
      classMap[(data.name || '').trim().toLowerCase()] = { classId: d.id, name: data.name };
    });

    const imported = [];
    const skippedList = [];
    const batch = db.batch();

    for (const row of rows) {
      const { admissionNumber, studentName, fatherName, className, dateOfBirth } = row;
      if (!admissionNumber || !studentName) {
        skippedList.push({ admissionNumber: admissionNumber || '?', reason: 'Missing required fields' });
        continue;
      }

      const dupQ = await db.collection('students')
        .where('schoolId', '==', schoolId)
        .where('admissionNumber', '==', String(admissionNumber))
        .limit(1).get();
      if (!dupQ.empty) {
        skippedList.push({ admissionNumber, reason: 'Already exists' });
        continue;
      }

      const studentId = `${schoolIdClean}-${admissionNumber}`;
      const clsKey    = (className || '').trim().toLowerCase();
      const classInfo = classMap[clsKey] || { classId: clsKey, name: className };

      const qrData = JSON.stringify({
        type:            'student',
        studentId,
        studentName:     String(studentName).trim(),
        fatherName:      String(fatherName  || '').trim(),
        schoolId,
        schoolName,
        location,
        logoUrl,
        primaryColor,
        className:       String(className   || '').trim(),
        admissionNumber: String(admissionNumber),
      });

      const docRef = db.collection('students').doc(studentId);
      batch.set(docRef, {
        studentId,
        admissionNumber: String(admissionNumber),
        studentName:     String(studentName).trim(),
        name:            String(studentName).trim(),
        fatherName:      String(fatherName  || '').trim(),
        dateOfBirth:     String(dateOfBirth || '').trim(),
        className:       String(className   || '').trim(),
        classId:         classInfo.classId,
        schoolId,
        academicYear:    academicYear || '',
        status:          'active',
        qrData,
        qrCode:          studentId,
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      });

      const parentRef = db.collection('parent_accounts').doc(studentId);
      batch.set(parentRef, {
        studentId,
        studentName:     String(studentName).trim(),
        schoolId,
        className:       String(className || '').trim(),
        status:          'pending_registration',
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      imported.push({ studentId, studentName: String(studentName).trim(), className: String(className || '').trim(), qrData });
    }

    await batch.commit();
    res.json({
      success:     true,
      imported:    imported.length,
      skipped:     skippedList.length,
      skippedList,
      students:    imported,
    });
  } catch (err) {
    console.error('[students/import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/qr-sheet/:classId', verifyAuth, async (req, res) => {
  try {
    const { classId } = req.params;
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const snap = await db.collection('students')
      .where('schoolId', '==', schoolId)
      .where('classId', '==', classId)
      .get();
    const students = snap.docs.map(d => {
      const s = d.data();
      return {
        studentId:      s.studentId || d.id,
        studentName:    s.studentName || s.name || '',
        fatherName:     s.fatherName  || '',
        className:      s.className   || '',
        admissionNumber: s.admissionNumber || '',
        qrData:         s.qrData || s.studentId || d.id,
      };
    });
    students.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));
    const className = students[0]?.className || classId;
    res.json({ success: true, className, students });
  } catch (err) {
    console.error('[qr-sheet]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/qr-sheet-html/:classId', verifyAuth, async (req, res) => {
  try {
    const { classId } = req.params;
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const snap = await db.collection('students')
      .where('schoolId', '==', schoolId)
      .where('classId', '==', classId)
      .get();

    const students = snap.docs.map(d => {
      const s = d.data();
      return {
        studentId:       s.studentId || d.id,
        studentName:     s.studentName || s.name || '',
        fatherName:      s.fatherName || '',
        className:       s.className || '',
        admissionNumber: s.admissionNumber || '',
        qrData:          s.qrData || s.studentId || d.id,
      };
    });
    students.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));

    let schoolName = 'School';
    try {
      const ss = await adminDb.collection('schools').doc(schoolId).get();
      if (ss.exists) schoolName = ss.data().schoolName || ss.data().name || 'School';
    } catch (_) {}

    const className = students[0]?.className || classId;

    const cardsJson = JSON.stringify(students.map(s => ({
      n: s.studentName,
      f: s.fatherName,
      c: s.className,
      a: s.admissionNumber,
      q: s.qrData,
    })));

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Sheet — ${className} | ${schoolName}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;color:#1a2b3c;padding:20px}
  .top{text-align:center;margin-bottom:24px;padding:16px;background:#1a3c5e;color:#fff;border-radius:12px}
  .top h1{font-size:20px;font-weight:800;margin-bottom:4px}
  .top p{font-size:13px;opacity:.8}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .card{background:#fff;border-radius:12px;padding:14px;text-align:center;
        border:1.5px solid #d1dce8;box-shadow:0 2px 8px rgba(0,0,0,.08);
        page-break-inside:avoid;break-inside:avoid}
  .card .qr-wrap{display:flex;justify-content:center;margin-bottom:10px}
  .card .qr-wrap canvas,.card .qr-wrap img{border-radius:6px}
  .name{font-size:13px;font-weight:700;color:#1a3c5e;margin-bottom:2px;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .father{font-size:11px;color:#5a6a7a;margin-bottom:2px;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{display:inline-flex;gap:6px;margin-top:4px}
  .chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px}
  .chip-class{background:#e8f4ff;color:#1a6ec7}
  .chip-adm{background:#e8fff4;color:#0a7a3c}
  .print-btn{display:block;margin:0 auto 20px;padding:12px 32px;
             background:#1a3c5e;color:#fff;border:none;border-radius:10px;
             font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.3px}
  .print-btn:hover{background:#0d2a45}
  .count{text-align:center;color:#5a6a7a;font-size:13px;margin-bottom:16px}
  @media print{
    body{background:#fff;padding:0}
    .print-btn,.top button{display:none!important}
    .grid{grid-template-columns:repeat(3,1fr);gap:10px}
    .card{box-shadow:none;border-color:#ccc}
    @page{size:A4;margin:12mm}
  }
</style>
</head>
<body>
<div class="top">
  <h1>${schoolName}</h1>
  <p>Student QR Code Sheet &nbsp;·&nbsp; Class ${className}</p>
</div>
<p class="count" id="cnt"></p>
<button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
<div class="grid" id="grid"></div>
<script>
const students=${cardsJson};
document.getElementById('cnt').textContent=students.length+' student'+(students.length!==1?'s':'');
const grid=document.getElementById('grid');
students.forEach(function(s,i){
  const card=document.createElement('div');
  card.className='card';
  const qWrap=document.createElement('div');
  qWrap.className='qr-wrap';
  const qEl=document.createElement('div');
  qEl.id='qr'+i;
  qWrap.appendChild(qEl);
  card.innerHTML='<div class="name">'+s.n+'</div>'
    +'<div class="father">S/o '+s.f+'</div>'
    +'<div class="badge"><span class="chip chip-class">'+s.c+'</span>'
    +'<span class="chip chip-adm">Adm: '+s.a+'</span></div>';
  card.insertBefore(qWrap,card.firstChild);
  grid.appendChild(card);
  try{
    new QRCode(qEl,{text:s.q||s.n,width:120,height:120,
      colorDark:'#1a3c5e',colorLight:'#ffffff',
      correctLevel:QRCode.CorrectLevel.M});
  }catch(e){qEl.textContent='QR Error';}
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[qr-sheet-html]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    const studentsRef = db.collection('students');
    const q = studentsRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId);
    const snapshot = await q.get();
    const students = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    students.sort((a, b) => (a.rollNumber || 0) - (b.rollNumber || 0));
    res.json({ success: true, students });
  } catch (err) {
    console.error('Get students error:', err.message);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can delete students' });
    }
    const { id } = req.params;
    await db.collection('students').doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete student error:', err.message);
    res.status(500).json({ error: 'Failed to delete student' });
  }
});

app.post('/api/students/bulk-upload/:classId', upload.single('file'), async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can bulk upload students' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { classId } = req.params;
    const { className } = req.body;

    const classSnap = await db.collection('classes').doc(classId).get();
    const resolvedClassName = className || (classSnap.exists ? classSnap.data().name : classId);

    const existingQ = db.collection('students').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId);
    const existingSnap = await existingQ.get();
    const existingRolls = new Set(existingSnap.docs.map(d => Number(d.data().rollNumber)));

    const ext = req.file.originalname.toLowerCase().split('.').pop();
    let rows = [];

    if (ext === 'csv') {
      await new Promise((resolve, reject) => {
        const stream = Readable.from(req.file.buffer);
        stream.pipe(csvParser())
          .on('data', row => rows.push(row))
          .on('end', resolve)
          .on('error', reject);
      });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.worksheets[0];
      if (worksheet) {
        const headers = [];
        worksheet.getRow(1).eachCell((cell, colNumber) => {
          headers[colNumber - 1] = String(cell.value !== null && cell.value !== undefined ? cell.value : '');
        });
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          const obj = {};
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const header = headers[colNumber - 1];
            if (header) {
              const val = cell.value;
              obj[header] = (val !== null && val !== undefined) ? String(val) : '';
            }
          });
          if (Object.keys(obj).length > 0) rows.push(obj);
        });
      }
    } else {
      return res.status(400).json({ error: 'Only .csv and .xlsx files are supported' });
    }

    const normalize = (obj, keys) => {
      const lower = {};
      for (const k of Object.keys(obj)) lower[k.toLowerCase().trim()] = obj[k];
      for (const k of keys) { if (lower[k] !== undefined) return lower[k]; }
      return '';
    };

    const unitColRegex = /^unit(\d+)[_\s](.+)$/i;
    const detectMarksCols = (headers) => {
      const cols = [];
      for (const h of headers) {
        const m = h.trim().match(unitColRegex);
        if (m) {
          const unitNum = m[1];
          const subject = m[2].trim().replace(/_/g, ' ');
          const examType = `Unit ${unitNum}`;
          cols.push({ header: h, subject, examType });
        }
      }
      return cols;
    };

    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const marksCols = detectMarksCols(headers);

    let studentsCreated = 0;
    let marksCreated = 0;
    let skipped = 0;
    const errors = [];

    const marksRef = db.collection('student_marks');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const name = String(normalize(row, ['name', 'student name', 'studentname', 'full name']) || '').trim();
        const rollRaw = normalize(row, ['rollnumber', 'roll number', 'roll no', 'roll', 'rollno']);
        const parentPhone = String(normalize(row, ['parentphone', 'parent phone', 'phone', 'mobile', 'contact']) || '').trim();

        if (!name) { skipped++; continue; }

        let rollNumber;
        if (rollRaw === '' || rollRaw === null || rollRaw === undefined) {
          let autoRoll = 1;
          while (existingRolls.has(autoRoll)) autoRoll++;
          rollNumber = autoRoll;
        } else {
          rollNumber = Number(rollRaw);
          if (isNaN(rollNumber) || rollNumber <= 0) {
            errors.push(`Row ${i + 2}: invalid roll number "${rollRaw}" for "${name}"`); skipped++; continue;
          }
          if (existingRolls.has(rollNumber)) {
            errors.push(`Row ${i + 2}: roll ${rollNumber} already exists — skipped "${name}"`); skipped++; continue;
          }
        }

        const studentId = 'STU' + Date.now() + Math.floor(Math.random() * 9000 + 1000);
        const busIdVal = String(normalize(row, ['busid', 'bus id', 'bus', 'bus_id', 'busnumber', 'bus number']) || '').trim();
        const routeIdVal = String(normalize(row, ['routeid', 'route id', 'route', 'route_id', 'busroute', 'bus route']) || '').trim();

        await db.collection('students').add({
          studentId,
          name,
          rollNumber,
          classId,
          className: resolvedClassName,
          parentPhone,
          schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
          busId: busIdVal,
          routeId: routeIdVal,
          status: 'active',
          qrCode: `SREE_PRAGATHI|${(req.schoolId || DEFAULT_SCHOOL_ID)}|${studentId}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        existingRolls.add(rollNumber);
        studentsCreated++;
        safeSync('syncStudent', () => syncStudent({ studentId, name, rollNumber, className: resolvedClassName, classId, parentPhone, createdAt: new Date().toISOString() }), { studentId }).catch(() => {});

        for (const col of marksCols) {
          const rawVal = row[col.header];
          if (rawVal === '' || rawVal === null || rawVal === undefined) continue;
          const marksObtained = Number(rawVal);
          if (isNaN(marksObtained) || marksObtained < 0) {
            errors.push(`Row ${i + 2}: invalid marks "${rawVal}" in column "${col.header}" — skipped`);
            continue;
          }
          const docId = `${studentId}_${col.examType.replace(/\s/g, '')}_${col.subject.replace(/\s/g, '')}`;
          await marksRef.doc(docId).set({
            studentId,
            studentName: name,
            classId,
            subject: col.subject,
            examType: col.examType,
            marksObtained,
            maxMarks: 20,
            recordedBy: 'bulk_import',
            schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
          marksCreated++;
        }
      } catch (rowErr) {
        errors.push(`Row ${i + 2}: ${rowErr.message}`);
        skipped++;
      }
    }

    console.log(`Bulk upload: ${studentsCreated} students, ${marksCreated} marks, ${skipped} skipped — class ${resolvedClassName}`);
    res.json({ success: true, studentsCreated, marksCreated, skipped, errors });
  } catch (err) {
    console.error('Bulk upload error:', err.message);
    res.status(500).json({ error: 'Bulk upload failed: ' + err.message });
  }
});

const STANDARD_SUBJECTS = [
  { id: 'telugu', label: 'Telugu' },
  { id: 'hindi', label: 'Hindi' },
  { id: 'english', label: 'English' },
  { id: 'mathematics', label: 'Mathematics' },
  { id: 'science', label: 'Science' },
  { id: 'social', label: 'Social Studies' },
  { id: 'urdu', label: 'Urdu' },
  { id: 'sanskrit', label: 'Sanskrit' },
  { id: 'drawing', label: 'Drawing' },
  { id: 'pt', label: 'Physical Education' },
];

function getSubjectLabel(subjectId) {
  return STANDARD_SUBJECTS.find((subject) => subject.id === subjectId)?.label || subjectId;
}

function normalizeSubjectId(subject) {
  const key = String(subject || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

  const map = {
    telugu: 'telugu',
    hindi: 'hindi',
    english: 'english',
    eng: 'english',
    mathematics: 'mathematics',
    maths: 'mathematics',
    math: 'mathematics',
    science: 'science',
    social: 'social',
    socialstudies: 'social',
    socialscience: 'social',
    urdu: 'urdu',
    sanskrit: 'sanskrit',
    drawing: 'drawing',
    art: 'drawing',
    pt: 'pt',
    pe: 'pt',
    physicaleducation: 'pt',
  };

  return map[key] || '';
}

function normalizeSubjectIds(subjects) {
  const list = Array.isArray(subjects) ? subjects : [subjects];
  return [...new Set(list.map(normalizeSubjectId).filter(Boolean))];
}

function getCurrentAcademicYearLabel() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (month >= 5) return `${year}-${String(year + 1).slice(2)}`;
  return `${year - 1}-${String(year).slice(2)}`;
}

async function getTeacherUserByRoleId(roleId) {
  const snap = await db.collection('users').where('role_id', '==', roleId).limit(1).get();
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { docId: docSnap.id, data: docSnap.data(), ref: db.collection('users').doc(docSnap.id) };
}

async function syncTeacherAggregateDoc({ schoolId, roleId, teacherDocId, subjects, assignment }) {
  const ref = db.collection('schools').doc(schoolId).collection('teacher_subjects').doc(roleId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : {};
  const currentSubjects = normalizeSubjectIds(current.subjects || []);
  const nextSubjects = normalizeSubjectIds([...(subjects || []), ...currentSubjects]);
  const currentAssignments = Array.isArray(current.assignedClasses) ? current.assignedClasses : [];

  let nextAssignments = currentAssignments;
  if (assignment) {
    nextAssignments = [
      ...currentAssignments.filter((item) =>
        !(item.classId === assignment.classId &&
          item.subject === assignment.subject &&
          (item.academicYear || getCurrentAcademicYearLabel()) === assignment.academicYear)
      ),
      assignment,
    ];
  }

  await ref.set({
    teacherId: roleId,
    teacherDocId: teacherDocId || current.teacherDocId || '',
    subjects: nextSubjects,
    assignedClasses: nextAssignments,
    schoolId,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return { subjects: nextSubjects, assignedClasses: nextAssignments };
}

async function syncTeacherCceAssignment({ schoolId, teacherDocId, teacherRoleId, subjectId, classId, className, academicYear }) {
  if (!teacherDocId || !subjectId || !classId || !academicYear) return;

  const ref = db.collection('schools')
    .doc(schoolId)
    .collection('teacher_subjects')
    .doc(`cce_${teacherDocId}_${subjectId}_${classId}_${academicYear}`);

  await ref.set({
    teacherId: teacherDocId,
    teacherRoleId: teacherRoleId || '',
    subjectId,
    classId,
    className: className || classId,
    academicYear,
    schoolId,
    assignedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

app.post('/api/assign-classes', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can assign classes' });
    }
    const {
      roleId,
      classes,
      teacherId,
      classId,
      className,
      subject,
      schoolId: bodySchoolId,
      academicYear,
    } = req.body;
    console.log('Assign classes request:', { roleId, classes, teacherId, classId, subject });

    if (teacherId && classId && subject) {
      const schoolId = bodySchoolId || req.schoolId || DEFAULT_SCHOOL_ID;
      const teacherUser = await getTeacherUserByRoleId(teacherId);
      if (!teacherUser) {
        return res.status(404).json({ error: `No user found with role_id: ${teacherId}` });
      }

      const subjectId = normalizeSubjectId(subject);
      if (!subjectId) {
        return res.status(400).json({ error: 'A valid subject is required' });
      }

      const classRef = db.collection('classes').doc(classId);
      const classSnap = await classRef.get();
      const resolvedClassName = className || (classSnap.exists ? classSnap.data().name || classId : classId);
      const teacherSubjects = normalizeSubjectIds(teacherUser.data.subjects || teacherUser.data.subject || []);
      const yearLabel = academicYear || getCurrentAcademicYearLabel();

      if (teacherSubjects.length > 0 && !teacherSubjects.includes(subjectId)) {
        return res.status(400).json({ error: `${teacherId} is not qualified for ${getSubjectLabel(subjectId)}` });
      }

      const aggregate = await syncTeacherAggregateDoc({
        schoolId,
        roleId: teacherId,
        teacherDocId: teacherUser.docId,
        subjects: teacherSubjects,
        assignment: {
          classId,
          className: resolvedClassName,
          subject: subjectId,
          academicYear: yearLabel,
          assignedAt: new Date().toISOString(),
        },
      });

      await syncTeacherCceAssignment({
        schoolId,
        teacherDocId: teacherUser.docId,
        teacherRoleId: teacherId,
        subjectId,
        classId,
        className: resolvedClassName,
        academicYear: yearLabel,
      });

      const assignedClasses = [
        ...new Set([...(teacherUser.data.assignedClasses || []).filter(Boolean), resolvedClassName]),
      ];

      await teacherUser.ref.update({
        assignedClasses,
        subjects: aggregate.subjects,
        subject: aggregate.subjects[0] || '',
      });

      if (classSnap.exists) {
        const classData = classSnap.data();
        const teachers = Array.isArray(classData.teachers) ? classData.teachers : [];
        const nextTeachers = teachers.filter((item) => !(item.teacherId === teacherId && item.subject === subjectId));
        nextTeachers.push({ teacherId, subject: subjectId, isClassTeacher: false });
        await classRef.set({ teachers: nextTeachers }, { merge: true });
      }

      return res.json({
        success: true,
        teacherId,
        classId,
        className: resolvedClassName,
        subject: subjectId,
        academicYear: yearLabel,
      });
    }

    if (!roleId) {
      return res.status(400).json({ error: 'Teacher role ID is required' });
    }
    if (!classes || !Array.isArray(classes)) {
      return res.status(400).json({ error: 'Classes must be an array' });
    }

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snapshot = await q.get();

    if (snapshot.empty) {
      return res.status(404).json({ error: `No user found with role_id: ${roleId}` });
    }

    let updatedCount = 0;
    for (const userDoc of snapshot.docs) {
      await db.collection('users').doc(userDoc.id).update({ assignedClasses: classes });
      updatedCount++;
    }

    console.log(`Assigned ${classes.length} classes to ${roleId}: ${classes.join(', ')} (${updatedCount} docs updated)`);

    let sheetSync = { success: false };
    try {
      sheetSync = await updateUserDirectoryClasses(roleId, classes);
    } catch (syncErr) {
      console.error('Google Sheets class assignment sync failed:', syncErr.message);
    }

    res.json({
      success: true,
      roleId,
      assignedClasses: classes,
      updatedDocs: updatedCount,
      sheetSync: sheetSync.success,
    });
  } catch (err) {
    console.error('Assign classes error:', err.code || '', err.message || err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.get('/api/teacher-classes', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) {
      return res.status(400).json({ error: 'roleId query param is required' });
    }

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snapshot = await q.get();

    if (snapshot.empty) {
      return res.json({ assignedClasses: [] });
    }

    const userData = snapshot.docs[0].data();
    res.json({ assignedClasses: userData.assignedClasses || [] });
  } catch (err) {
    console.error('Get teacher classes error:', err.message);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.get('/api/teacher/profile', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });
    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snap = await q.get();
    if (snap.empty) return res.status(404).json({ error: 'Teacher not found' });
    const data = snap.docs[0].data();
    res.json({
      classTeacherOf: data.classTeacherOf || null,
      timetable: data.timetable || [],
      assignedClasses: data.assignedClasses || [],
      subjects: normalizeSubjectIds(data.subjects || data.subject || []),
      subject: data.subject || '',
      full_name: data.full_name || '',
      role_id: data.role_id || roleId,
    });
  } catch (err) {
    console.error('Teacher profile error:', err.message);
    res.status(500).json({ error: 'Failed to fetch teacher profile' });
  }
});

app.get('/api/teacher/permissions', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snap = await q.get();
    if (snap.empty) return res.json({ subjects: [], classes: [], subjectClassMap: {} });

    const data = snap.docs[0].data();
    const timetable = data.timetable || [];
    const assignedClasses = data.assignedClasses || [];
    const primarySubject = data.subject || '';

    const subjectClassMap = {};
    const allSubjects = new Set();
    const allClasses = new Set();

    for (const entry of timetable) {
      const subj = entry.subject;
      const cls = entry.className;
      if (subj) {
        allSubjects.add(subj);
        if (!subjectClassMap[subj]) subjectClassMap[subj] = [];
        if (cls && !subjectClassMap[subj].includes(cls)) subjectClassMap[subj].push(cls);
      }
      if (cls) allClasses.add(cls);
    }

    if (primarySubject && !allSubjects.has(primarySubject)) {
      allSubjects.add(primarySubject);
      if (!subjectClassMap[primarySubject]) {
        subjectClassMap[primarySubject] = [...assignedClasses];
      }
    }

    for (const cls of assignedClasses) {
      allClasses.add(cls);
    }

    res.json({
      subjects: [...allSubjects],
      classes: [...allClasses],
      subjectClassMap,
      role: data.role,
    });
  } catch (err) {
    console.error('Teacher permissions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

app.get('/api/teacher/classes', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snap = await q.get();
    if (snap.empty) return res.status(404).json({ error: 'Teacher not found' });

    const data = snap.docs[0].data();
    const timetable = data.timetable || [];
    const assignedClasses = data.assignedClasses || [];

    const uniqueClassNames = [...new Set([
      ...assignedClasses,
      ...timetable.map(e => e.className).filter(Boolean),
    ])];

    const classesRef = db.collection('classes');
    const classDetails = await Promise.all(uniqueClassNames.map(async (className) => {
      try {
        const classSnap = await classesRef.where('name', '==', className).limit(1).get();
        if (!classSnap.empty) {
          const classData = classSnap.docs[0].data();
          return {
            id: classSnap.docs[0].id,
            name: className,
            studentCount: classData.studentCount || 0,
            section: classData.section || '',
          };
        }
        const studentsSnap = await db.collection('students').where('classId', '==', className).get();
        return { id: className, name: className, studentCount: studentsSnap.size, section: '' };
      } catch {
        return { id: className, name: className, studentCount: 0, section: '' };
      }
    }));

    const subjects = [...new Set(timetable.map(e => e.subject).filter(Boolean))];

    res.json({
      classes: classDetails,
      timetable,
      assignedClasses: uniqueClassNames,
      subjects,
      classTeacherOf: data.classTeacherOf || null,
    });
  } catch (err) {
    console.error('Teacher classes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch teacher classes' });
  }
});

app.get('/api/teacher/subjects', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });

    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const aggregateSnap = await db.collection('schools').doc(schoolId).collection('teacher_subjects').doc(roleId).get();
    if (aggregateSnap.exists) {
      return res.json({ subjects: normalizeSubjectIds(aggregateSnap.data().subjects || []) });
    }

    const teacherUser = await getTeacherUserByRoleId(roleId);
    if (!teacherUser) {
      return res.json({ subjects: [] });
    }

    res.json({ subjects: normalizeSubjectIds(teacherUser.data.subjects || teacherUser.data.subject || []) });
  } catch (err) {
    console.error('Teacher subjects error:', err.message);
    res.status(500).json({ error: 'Failed to fetch teacher subjects' });
  }
});

app.get('/api/teacher/assignments', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });

    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const aggregateSnap = await db.collection('schools').doc(schoolId).collection('teacher_subjects').doc(roleId).get();
    if (!aggregateSnap.exists) {
      return res.json({ assignments: [] });
    }

    const data = aggregateSnap.data();
    const rawAssignments = Array.isArray(data.assignedClasses) ? data.assignedClasses : [];
    const assignments = await Promise.all(rawAssignments.map(async (assignment) => {
      let resolvedClassName = assignment.className || assignment.classId;
      try {
        const classSnap = await db.collection('classes').doc(assignment.classId).get();
        if (classSnap.exists) {
          resolvedClassName = classSnap.data().name || resolvedClassName;
        }
      } catch (_) {}

      return {
        classId: assignment.classId,
        className: resolvedClassName,
        subject: assignment.subject,
        subjectLabel: getSubjectLabel(assignment.subject),
        academicYear: assignment.academicYear || getCurrentAcademicYearLabel(),
      };
    }));

    res.json({ assignments });
  } catch (err) {
    console.error('Teacher assignments error:', err.message);
    res.status(500).json({ error: 'Failed to fetch teacher assignments' });
  }
});

app.post('/api/save-timetable', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can save timetables' });
    }
    const { roleId, teacherName, timetable } = req.body;
    if (!roleId || !Array.isArray(timetable)) {
      return res.status(400).json({ error: 'roleId and timetable array required' });
    }

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snap = await q.get();
    if (snap.empty) return res.status(404).json({ error: 'Teacher not found' });

    const userDocRef = db.collection('users').doc(snap.docs[0].id);
    const currentData = snap.docs[0].data();
    const oldTimetable = currentData.timetable || [];
    const oldClassNames = oldTimetable.map(t => t.className);
    const newClassNames = timetable.map(t => t.className);
    const removedClasses = oldClassNames.filter(c => !newClassNames.includes(c));

    await userDocRef.update({
      timetable: timetable,
      assignedClasses: newClassNames,
    });

    const calRef = db.collection('teacher_calendar');
    if (removedClasses.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      const rmQ = calRef.where('roleId', '==', roleId);
      const rmSnap = await rmQ.get();
      const batch = db.batch();
      let deleteCount = 0;
      for (const d of rmSnap.docs) {
        const data = d.data();
        if (removedClasses.includes(data.className) && data.date >= today) {
          batch.delete(db.collection('teacher_calendar').doc(d.id));
          deleteCount++;
        }
      }
      if (deleteCount > 0) await batch.commit();
      console.log(`Deleted ${deleteCount} future calendar entries for removed classes`);
    }

    const ACADEMIC_START = new Date(process.env.ACADEMIC_START || '2025-06-02');
    const ACADEMIC_END = new Date(process.env.ACADEMIC_END || '2026-04-30');
    const DAY_MAP = { 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = today > ACADEMIC_START ? today : ACADEMIC_START;

    const existingQ = calRef.where('roleId', '==', roleId);
    const existingSnap = await existingQ.get();
    const existingKeys = new Set();
    for (const d of existingSnap.docs) {
      const data = d.data();
      existingKeys.add(`${data.className}|${data.date}|${data.startTime}`);
    }

    let generated = 0;
    for (const entry of timetable) {
      if (!entry.days || !entry.days.length) continue;
      const targetDays = entry.days.map(d => DAY_MAP[d]).filter(Boolean);

      let cursor = new Date(startDate);
      while (cursor <= ACADEMIC_END) {
        if (targetDays.includes(cursor.getDay())) {
          const dateStr = cursor.toISOString().split('T')[0];
          const key = `${entry.className}|${dateStr}|${entry.startTime}`;
          if (!existingKeys.has(key)) {
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            await calRef.add({
              roleId,
              className: entry.className,
              subject: entry.subject || '',
              date: dateStr,
              dayOfWeek: dayNames[cursor.getDay()],
              startTime: entry.startTime || '',
              endTime: entry.endTime || '',
              room: entry.room || '',
              status: 'scheduled',
              createdAt: new Date().toISOString(),
            });
            generated++;
            existingKeys.add(key);
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    let sheetSync = false;
    try {
      const sheetEntries = timetable.map(e => ({
        teacherId: roleId,
        teacherName: teacherName || currentData.full_name || '',
        className: e.className,
        subject: e.subject || '',
        days: e.days || [],
        startTime: e.startTime || '',
        endTime: e.endTime || '',
        room: e.room || '',
        status: 'Active',
      }));
      const sr = await syncMasterTimetable(sheetEntries);
      sheetSync = sr.success;

      if (removedClasses.length > 0) {
        await removeMasterTimetableEntries(roleId, removedClasses);
      }

      await updateUserDirectoryClasses(roleId, newClassNames);
    } catch (syncErr) {
      console.error('Timetable sheet sync failed:', syncErr.message);
    }

    try {
      const classList = timetable.map(t => `Grade ${t.className} (${t.subject})`).join(', ');
      await db.collection('teacher_notifications').add({
        roleId,
        type: 'timetable_updated',
        title: 'Timetable Updated',
        message: `Your academic schedule has been updated by the Admin. ${timetable.length} class${timetable.length !== 1 ? 'es' : ''} assigned: ${classList}.`,
        icon: '\uD83D\uDCC5',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: new Date().toISOString(),
      });
      console.log(`Notification sent to ${roleId}: timetable updated`);
    } catch (notifErr) {
      console.error('Failed to send timetable notification:', notifErr.message);
    }

    console.log(`Saved timetable for ${roleId}: ${timetable.length} classes, ${generated} calendar events generated`);
    res.json({ success: true, generated, removedClasses: removedClasses.length, sheetSync });
  } catch (err) {
    console.error('Save timetable error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/teacher/class-comprehensive/:classId ──────────────────────────
// Returns all marks for a teacher's assigned class across all subjects & exams
app.get('/api/teacher/class-comprehensive/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    const sid = req.schoolId || DEFAULT_SCHOOL_ID;
    const role = req.userRole || '';
    const userId = req.userId || '';

    // Authorization: Teacher must be assigned to this class
    if (!['principal', 'admin', 'staff'].includes(role)) {
      const userDoc = await db.collection('users').doc(userId).get();
      if (!userDoc.exists) {
        return res.status(403).json({ error: 'User not found' });
      }
      const userData = userDoc.data();
      const assignedClasses = (userData.assignedClasses || []).map(c => c.trim().toLowerCase());
      const timetable = userData.timetable || [];
      const classNorm = classId.replace(/^Grade\s*/i, '').trim().toLowerCase();
      const hasClassAccess = assignedClasses.some(ac => ac.replace(/^Grade\s*/i, '').trim() === classNorm) ||
        timetable.some(t => (t.className || '').replace(/^Grade\s*/i, '').trim().toLowerCase() === classNorm);
      if (!hasClassAccess) {
        return res.status(403).json({ error: 'You are not assigned to this class' });
      }
    }

    // Fetch all marks for this class from CCE collection
    const marksSnap = await db.collection('schools').doc(sid)
      .collection('cce_marks')
      .where('classId', '==', classId)
      .get();

    // Fetch all students in this class
    const studentsSnap = await db.collection('students')
      .where('classId', '==', classId)
      .where('schoolId', '==', sid)
      .get();

    // Build student list
    const studentMap = {};
    studentsSnap.docs.forEach(doc => {
      const s = doc.data();
      studentMap[s.studentId || s.id] = {
        studentId: s.studentId || s.id,
        studentName: s.studentName || s.full_name || s.name || 'Unknown',
        rollNumber: s.rollNumber || s.roll || 0,
      };
    });

    // Organize marks by student, subject, and exam
    const marksByStudent = {};
    const subjectSet = new Set();
    const examSet = new Set();
    const academicYears = new Set();

    marksSnap.docs.forEach(doc => {
      const m = doc.data();
      const studentId = m.studentId;
      const subject = m.subjectId || '';
      const exam = m.examType || '';
      const year = m.academicYear || '';

      if (!marksByStudent[studentId]) {
        marksByStudent[studentId] = studentMap[studentId] || { studentId, studentName: 'Unknown', rollNumber: 0 };
        marksByStudent[studentId].subjectMarks = {};
      }

      if (!marksByStudent[studentId].subjectMarks[subject]) {
        marksByStudent[studentId].subjectMarks[subject] = {};
      }

      marksByStudent[studentId].subjectMarks[subject][exam] = {
        marks: m.marks || 0,
        maxMarks: m.maxMarks || 20,
        examType: exam,
        subjectId: subject,
        updatedAt: m.updatedAt,
      };

      subjectSet.add(subject);
      examSet.add(exam);
      academicYears.add(year);
    });

    // Calculate subject averages
    const subjectAverages = {};
    Array.from(subjectSet).forEach(subject => {
      let total = 0;
      let count = 0;
      Object.values(marksByStudent).forEach(student => {
        Object.values(student.subjectMarks[subject] || {}).forEach(mark => {
          total += mark.marks || 0;
          count++;
        });
      });
      subjectAverages[subject] = count > 0 ? Math.round(total / count) : 0;
    });

    // Calculate exam averages
    const examAverages = {};
    Array.from(examSet).forEach(exam => {
      let total = 0;
      let count = 0;
      Object.values(marksByStudent).forEach(student => {
        Object.values(student.subjectMarks).forEach(subjectMarks => {
          if (subjectMarks[exam]) {
            total += subjectMarks[exam].marks || 0;
            count++;
          }
        });
      });
      examAverages[exam] = count > 0 ? Math.round(total / count) : 0;
    });

    res.json({
      success: true,
      classId,
      students: Object.values(marksByStudent),
      subjects: Array.from(subjectSet).sort(),
      exams: Array.from(examSet).sort(),
      academicYears: Array.from(academicYears).sort(),
      subjectAverages,
      examAverages,
      total: Object.values(marksByStudent).length,
    });
  } catch (err) {
    console.error('[teacher/class-comprehensive]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teacher-notifications', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });

    const notifsRef = db.collection('teacher_notifications');
    const q = notifsRef.where('roleId', '==', roleId);
    const snap = await q.get();

    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    notifications.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({ notifications });
  } catch (err) {
    console.error('Fetch teacher notifications error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/teacher-notifications/mark-read', async (req, res) => {
  try {
    const { notificationIds } = req.body;
    if (!notificationIds || !Array.isArray(notificationIds)) return res.status(400).json({ error: 'notificationIds array required' });

    for (const id of notificationIds) {
      await db.collection('teacher_notifications').doc(id).update({ read: true });
    }

    res.json({ success: true, marked: notificationIds.length });
  } catch (err) {
    console.error('Mark teacher notifications read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teacher-timetable', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });

    const usersRef = db.collection('users');
    const q = usersRef.where('role_id', '==', roleId);
    const snap = await q.get();
    if (snap.empty) return res.json({ timetable: [] });

    const userData = snap.docs[0].data();
    res.json({ timetable: userData.timetable || [] });
  } catch (err) {
    console.error('Get timetable error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teacher-calendar', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    const { month, year } = req.query;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });

    const calRef = db.collection('teacher_calendar');
    const q = calRef.where('roleId', '==', roleId);
    const snap = await q.get();

    let events = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (month && year) {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      events = events.filter(e => e.date && e.date.startsWith(prefix));
    }

    events.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

    res.json({ events });
  } catch (err) {
    console.error('Get teacher calendar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function normalizeExamType(type) {
  const map = {
    'fa1': 'FA1', 'fa2': 'FA2', 'fa3': 'FA3', 'fa4': 'FA4',
    'sa1': 'SA1', 'sa2': 'SA2',
  };
  return map[(type || '').toLowerCase().trim()] || type;
}

function normalizeSubjectName(name) {
  const map = {
    'math': 'Mathematics', 'maths': 'Mathematics', 'mathematics': 'Mathematics',
    'science': 'Science', 'sci': 'Science',
    'english': 'English', 'eng': 'English',
    'social': 'Social Studies', 'soc': 'Social Studies',
    'social science': 'Social Studies', 'social studies': 'Social Studies',
    'telugu': 'Telugu', 'tel': 'Telugu',
    'tamil': 'Tamil', 'tam': 'Tamil',
    'computer': 'Computer', 'comp': 'Computer',
    'computers': 'Computer', 'computer science': 'Computer',
    'hindi': 'Hindi',
  };
  const key = (name || '').toLowerCase().trim();
  return map[key] || name;
}

app.post('/api/marks/save', validate([
  body('records').isArray({ min: 1 }).withMessage('records must be a non-empty array'),
  body('subject').notEmpty().trim().withMessage('subject is required'),
  body('examType').notEmpty().trim().withMessage('examType is required'),
]), async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/marks routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const { records, subject: rawSubject, examType, teacherId, classId, className } = req.body;
    const subject = normalizeSubjectName(rawSubject);
    console.log('Marks save request:', { subject, rawSubject, examType, recordCount: records?.length, teacherId });

    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'No marks records provided' });
    }
    if (!subject || !examType) {
      return res.status(400).json({ error: 'Subject and exam type are required' });
    }

    if (teacherId) {
      const usersRef = db.collection('users');
      const tq = usersRef.where('role_id', '==', teacherId);
      const tSnap = await tq.get();
      if (!tSnap.empty) {
        const teacherData = tSnap.docs[0].data();
        if (teacherData.role !== 'principal') {
          const timetable = teacherData.timetable || [];
          const assignedClasses = teacherData.assignedClasses || [];
          const primarySubject = teacherData.subject || '';

          const allowedSubjects = new Set();
          const subjectClassMap = {};
          for (const entry of timetable) {
            if (entry.subject) {
              allowedSubjects.add(entry.subject.toLowerCase());
              if (!subjectClassMap[entry.subject.toLowerCase()]) subjectClassMap[entry.subject.toLowerCase()] = [];
              if (entry.className) subjectClassMap[entry.subject.toLowerCase()].push(entry.className);
            }
          }
          if (primarySubject) allowedSubjects.add(primarySubject.toLowerCase());

          if (!allowedSubjects.has(subject.toLowerCase())) {
            console.log(`Permission denied: ${teacherId} not assigned subject "${subject}"`);
            return res.status(403).json({ error: `Permission denied: You are not assigned to teach ${subject}.` });
          }

          const gradeToCheck = (className || '').trim().replace(/^Grade\s+/i, '');
          if (gradeToCheck) {
            const hasClassAccess = assignedClasses.some(ac =>
              ac.trim().replace(/^Grade\s+/i, '').toLowerCase() === gradeToCheck.toLowerCase()
            );
            if (!hasClassAccess) {
              console.log(`Permission denied: ${teacherId} not assigned class "${gradeToCheck}"`);
              return res.status(403).json({ error: `Permission denied: You are not assigned to class ${gradeToCheck}.` });
            }

            const subjectLower = subject.toLowerCase();
            if (subjectClassMap[subjectLower] && subjectClassMap[subjectLower].length > 0) {
              const hasSubjectInClass = subjectClassMap[subjectLower].some(sc =>
                sc.trim().replace(/^Grade\s+/i, '').toLowerCase() === gradeToCheck.toLowerCase()
              );
              if (!hasSubjectInClass) {
                console.log(`Permission denied: ${teacherId} does not teach "${subject}" in class "${gradeToCheck}"`);
                return res.status(403).json({ error: `Permission denied: You are not assigned to teach ${subject} in Grade ${gradeToCheck}.` });
              }
            }
          }
        }
      }
    }

    for (const record of records) {
      if (!record.studentId || !record.studentName || !record.classId) {
        return res.status(400).json({ error: 'Each record must have studentId, studentName, and classId' });
      }
      if (classId && record.classId !== classId) {
        return res.status(400).json({ error: `Record classId mismatch: expected ${classId}, got ${record.classId} for ${record.studentName}` });
      }
      if (typeof record.marksObtained !== 'number' || record.marksObtained < 0) {
        return res.status(400).json({ error: `Invalid marks for ${record.studentName}. Must be a non-negative number.` });
      }
      if (typeof record.maxMarks !== 'number' || record.maxMarks <= 0) {
        return res.status(400).json({ error: `Invalid maxMarks for ${record.studentName}. Must be a positive number.` });
      }
      if (record.marksObtained > record.maxMarks) {
        return res.status(400).json({ error: `Marks (${record.marksObtained}) cannot exceed max marks (${record.maxMarks}) for ${record.studentName}` });
      }
    }

    const marksRef = db.collection('student_marks');
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const now = new Date().toISOString();

    const docEntries = records.map(r => ({
      record: r,
      ref: doc(marksRef, `${r.studentId}_${examType}_${subject}`),
    }));

    let conflicts = [];
    try {
      await db.runTransaction(async (transaction) => {
        const existingDocs = await Promise.all(docEntries.map(({ ref }) => transaction.get(ref)));

        const conflictsFound = [];
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          const existing = existingDocs[i];
          if (existing.exists && record.version !== undefined) {
            const currentVersion = existing.data().version || 1;
            if (Number(record.version) !== currentVersion) {
              conflictsFound.push({
                studentId: record.studentId,
                studentName: record.studentName,
                existingVersion: currentVersion,
                attemptedVersion: Number(record.version),
              });
            }
          }
        }

        if (conflictsFound.length > 0) {
          conflicts = conflictsFound;
          const err = new Error('VERSION_CONFLICT');
          err.isVersionConflict = true;
          throw err;
        }

        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          const { ref } = docEntries[i];
          const existing = existingDocs[i];
          const currentVersion = existing.exists ? (existing.data().version || 1) : 0;
          transaction.set(ref, {
            studentId: record.studentId,
            studentName: record.studentName,
            classId: record.classId,
            className: className || record.classId || '',
            subject,
            examType,
            marksObtained: record.marksObtained,
            maxMarks: record.maxMarks,
            recordedBy: record.recordedBy || teacherId || 'teacher',
            schoolId,
            version: currentVersion === 0 ? 1 : currentVersion + 1,
            updatedAt: now,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
    } catch (txErr) {
      if (txErr.isVersionConflict) {
        try {
          await Promise.all(conflicts.map(c => db.collection('marks_conflict_logs').add({
            studentId: c.studentId,
            classId,
            subject,
            examType,
            attemptedBy: teacherId || 'teacher',
            existingVersion: c.existingVersion,
            attemptedVersion: c.attemptedVersion,
            timestamp: now,
            schoolId,
          })));
        } catch (logErr) {
          console.error('[marks/save] Conflict log error:', logErr.message);
        }
        return res.status(409).json({
          error: 'Version conflict: these marks were updated by someone else since you last loaded them.',
          conflicts: conflicts.map(c => ({ studentId: c.studentId, studentName: c.studentName })),
        });
      }
      throw txErr;
    }

    const avg = Math.round(records.reduce((s, r) => s + r.marksObtained, 0) / records.length);
    console.log(`[student_marks] Saved/updated ${records.length} records | subject: ${subject} | exam: ${examType} | class: ${className} | avg: ${avg}`);

    // Admin notification — marks submitted
    try {
      const notifMsg = `${teacherId || 'Teacher'} submitted ${subject} marks for ${examType} — Class ${className || classId}. ${records.length} students, Class Avg: ${avg}/${records[0]?.maxMarks || 20}.`;
      await db.collection('admin_notifications').add({
        type: 'marks_submitted',
        icon: '📝',
        title: 'Marks Submitted',
        message: notifMsg,
        details: {
          teacherId: teacherId || '',
          subject,
          examType,
          classId,
          className: className || classId,
          studentCount: records.length,
          classAvg: avg,
        },
        priority: 'normal',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: new Date().toISOString(),
      });
      console.log(`[marks] Admin notification sent: ${subject} ${examType} for class ${classId}`);
      sendPushToAdmins(req.schoolId || DEFAULT_SCHOOL_ID, '📝 Marks Submitted', `${teacherId || 'Teacher'} submitted ${subject} marks for ${examType} — Class ${className || classId}`, { type: 'marks_submitted', classId, subject, examType });
    } catch (notifErr) {
      console.error('[marks] Admin notification error:', notifErr.message);
    }

    // Parent notifications — one per student
    try {
      await Promise.all(records.map(async (record) => {
        try {
          const studentQuery = db.collection('students').where('studentId', '==', record.studentId);
          const studentSnap = await studentQuery.get();
          const parentPhone = !studentSnap.empty ? studentSnap.docs[0].data().parentPhone || null : null;

          const pct = Math.round((record.marksObtained / record.maxMarks) * 100);
          await db.collection('parent_notifications').add({
            studentId: record.studentId,
            studentName: record.studentName,
            type: 'marks_published',
            title: 'Marks Published',
            message: `Dear Parent, ${record.studentName}'s ${subject} marks for ${examType} have been published. Score: ${record.marksObtained}/${record.maxMarks} (${pct}%).`,
            subject,
            examType,
            classId,
            marksObtained: record.marksObtained,
            maxMarks: record.maxMarks,
            pct,
            parentPhone: parentPhone || null,
            schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
            read: false,
            createdAt: new Date().toISOString(),
          });
          const parentId = !studentSnap.empty ? (studentSnap.docs[0].data().parentId || studentSnap.docs[0].data().parent_uid || '') : '';
          if (parentId) sendPushNotification(parentId, '📝 Marks Updated', `${record.studentName}'s marks have been updated`, { type: 'marks', studentId: record.studentId });
        } catch (e) {
          console.error('[marks] Parent notif error for', record.studentId, e.message);
        }
      }));
      console.log(`[marks] Parent notifications sent for ${records.length} students`);
    } catch (parentErr) {
      console.error('[marks] Parent notifications batch error:', parentErr.message);
    }

    let sheetSync = { success: false };
    try {
      sheetSync = await syncMarks(records, subject, examType);
    } catch (syncErr) {
      console.error('Google Sheets sync (marks) failed:', syncErr.message);
    }

    res.status(200).json({
      success: true,
      message: `Marks saved for ${records.length} students`,
      summary: { total: records.length, subject, examType, classAvg: avg },
      sheetSync: sheetSync.success,
    });
  } catch (err) {
    console.error('Marks save error:', err.code || '', err.message || err);
    res.status(500).json({ error: 'Marks failed to save. Please check your connection.' });
  }
});

app.get('/api/marks/submitted-exams', async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/marks routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const { classId, subject } = req.query;
    if (!classId || !subject) return res.status(400).json({ error: 'classId and subject required' });

    const q = db.collection('student_marks').where('classId', '==', classId).where('subject', '==', subject.trim());
    const snap = await q.get();
    const examTypes = new Set();
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.examType) examTypes.add(normalizeExamType(data.examType));
    });

    res.json({ success: true, submittedExams: [...examTypes] });
  } catch (err) {
    console.error('Submitted exams check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/marks/edit', async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/marks routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const { studentId, studentName, classId, className, subject: rawSubject, examType, newMarks, maxMarks, reason, editedBy, version: submittedVersion } = req.body;
    if (!studentId || !classId || !rawSubject || !examType || newMarks === undefined || !reason?.trim()) {
      return res.status(400).json({ error: 'studentId, classId, subject, examType, newMarks, and reason are required' });
    }

    const subject = (rawSubject || '').trim();
    const editedAt = new Date().toISOString();
    const docId = `${studentId}_${examType}_${subject}`;
    const docRef = db.collection('student_marks').doc(docId);

    let oldMarks = null;
    let existingVersion = null;
    try {
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(docRef);
        oldMarks = existing.exists ? existing.data().marksObtained : null;
        existingVersion = existing.exists ? (existing.data().version || 1) : null;

        if (existing.exists && submittedVersion !== undefined) {
          const currentVersion = existing.data().version || 1;
          if (Number(submittedVersion) !== currentVersion) {
            const err = new Error('VERSION_CONFLICT');
            err.isVersionConflict = true;
            throw err;
          }
        }

        const currentVersion = existing.exists ? (existing.data().version || 1) : 0;
        const existingData = existing.exists ? existing.data() : {};
        transaction.set(docRef, {
          ...existingData,
          marksObtained: Number(newMarks),
          maxMarks: Number(maxMarks) || 20,
          recordedBy: editedBy || 'teacher',
          updatedAt: editedAt,
          version: currentVersion === 0 ? 1 : currentVersion + 1,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    } catch (txErr) {
      if (txErr.isVersionConflict) {
        try {
          await db.collection('marks_conflict_logs').add({
            studentId, classId, subject, examType,
            attemptedBy: editedBy || 'teacher',
            existingVersion,
            attemptedVersion: submittedVersion !== undefined ? Number(submittedVersion) : null,
            timestamp: editedAt,
            schoolId: req.schoolId || DEFAULT_SCHOOL_ID,
          });
        } catch (logErr) {
          console.error('[marks/edit] Conflict log error:', logErr.message);
        }
        return res.status(409).json({ error: 'Version conflict: these marks were updated by someone else since you last loaded them.' });
      }
      throw txErr;
    }

    console.log(`[marks/edit] ${studentName} ${subject} ${examType}: ${oldMarks} → ${newMarks}`);

    // Write to marks_edit_logs collection for audit trail
    try {
      await db.collection('marks_edit_logs').add({
        studentId,
        studentName: studentName || '',
        classId,
        className: className || '',
        subject,
        examType: normalizeExamType(examType),
        oldMarks: oldMarks !== null ? Number(oldMarks) : null,
        newMarks: Number(newMarks),
        maxMarks: Number(maxMarks) || 20,
        editedByTeacher: editedBy || 'teacher',
        editReason: reason.trim(),
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        timestamp: editedAt,
      });
    } catch (logErr) {
      console.error('[marks/edit] Edit log error:', logErr.message);
    }

    // Admin notification
    try {
      await db.collection('admin_notifications').add({
        type: 'marks_edited',
        icon: '✏️',
        title: 'Marks Edited',
        message: `Marks edited for Student: ${studentName} | Subject: ${subject} | Old: ${oldMarks ?? '?'} | New: ${newMarks} | Teacher: ${editedBy || 'Unknown'} | Reason: ${reason.trim()}`,
        details: { editedBy, studentId, studentName, classId, className, subject, examType: normalizeExamType(examType), oldMarks, newMarks: Number(newMarks), maxMarks: Number(maxMarks) || 20, reason: reason.trim() },
        studentId,
        teacherName: editedBy || 'teacher',
        priority: 'high',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        isRead: false,
        createdAt: editedAt,
      });
      sendPushToAdmins(req.schoolId || DEFAULT_SCHOOL_ID, '✏️ Marks Edit', `${editedBy || 'Teacher'} changed ${studentName}'s ${subject} marks from ${oldMarks ?? '?'} to ${newMarks}. Reason: ${reason.trim()}`, { type: 'marks_edited', studentId, subject, examType });
    } catch (notifErr) {
      console.error('[marks/edit] Admin notification error:', notifErr.message);
    }

    try {
      const studentQuery = db.collection('students').where('studentId', '==', studentId);
      const studentSnap = await studentQuery.get();
      const parentId = !studentSnap.empty ? (studentSnap.docs[0].data().parentId || studentSnap.docs[0].data().parent_uid || '') : '';
      if (parentId) {
        sendPushNotification(parentId, '📝 Marks Updated', `${studentName}'s ${subject} marks changed to ${newMarks}/${Number(maxMarks) || 20}. Reason: ${reason.trim()}`, { type: 'marks_edit', studentId, subject, examType });
      }
      await db.collection('parent_notifications').add({
        studentId,
        studentName: studentName || '',
        type: 'marks_edited',
        title: 'Marks Updated',
        message: `Dear Parent, ${studentName}'s ${subject} marks (${normalizeExamType(examType)}) were updated to ${newMarks}/${Number(maxMarks) || 20}. Previous: ${oldMarks ?? '?'}. Reason: ${reason.trim()}`,
        subject,
        examType: normalizeExamType(examType),
        classId,
        oldMarks: oldMarks !== null ? Number(oldMarks) : null,
        newMarks: Number(newMarks),
        maxMarks: Number(maxMarks) || 20,
        reason: reason.trim(),
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: editedAt,
      });
    } catch (parentMarkErr) {
      console.error('[marks/edit] Parent notification error:', parentMarkErr.message);
    }

    res.json({ success: true, message: 'Marks updated successfully.', oldMarks, newMarks: Number(newMarks) });
  } catch (err) {
    console.error('[marks/edit] Error:', err.message);
    res.status(500).json({ error: 'Failed to update marks.' });
  }
});

app.get('/api/marks/view', async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/marks routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const { examType, classId } = req.query;
    console.log('Marks view request:', { examType, classId });

    if (!examType) {
      return res.status(400).json({ error: 'Exam type is required' });
    }

    const marksRef = db.collection('student_marks');
    const examVariants = new Set([examType]);

    const allDocs = [];
    const seenIds = new Set();
    for (const variant of examVariants) {
      let q;
      if (classId) {
        q = marksRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('examType', '==', variant).where('classId', '==', classId);
      } else {
        q = marksRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('examType', '==', variant);
      }
      const snapshot = await q.get();
      snapshot.docs.forEach(d => {
        if (!seenIds.has(d.id)) {
          seenIds.add(d.id);
          allDocs.push(d);
        }
      });
    }

    const marks = allDocs.map(d => ({
      id: d.id,
      ...d.data(),
      examType: normalizeExamType(d.data().examType),
      timestamp: d.data().timestamp?.toDate?.()?.toISOString() || null,
    }));

    marks.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));
    console.log(`Marks view: ${marks.length} records found for ${examType} (variants: ${[...examVariants].join(', ')})`);

    res.json({ marks, total: marks.length });
  } catch (err) {
    console.error('Marks view error:', err.code || '', err.message || err);
    res.status(500).json({ error: 'Failed to load marks. Please try again.' });
  }
});

app.get('/api/marks/summary', async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const snapshot = await db.collection('student_marks').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    const subjectMap = {};
    snapshot.docs.forEach(d => {
      const { subject: rawSubj, marksObtained, maxMarks } = d.data();
      const subject = normalizeSubjectName(rawSubj);
      if (!subject || marksObtained === undefined) return;
      if (!subjectMap[subject]) subjectMap[subject] = { total: 0, count: 0, maxTotal: 0 };
      subjectMap[subject].total += (Number(marksObtained) || 0);
      subjectMap[subject].count++;
      subjectMap[subject].maxTotal += (Number(maxMarks) || 20);
    });
    console.log('Marks summary: subjects found =', Object.keys(subjectMap));
    console.log('Marks summary: counts =', Object.fromEntries(Object.entries(subjectMap).map(([k,v])=>[k,v.count])));
    const subjects = Object.entries(subjectMap).map(([subject, s]) => ({
      subject,
      avg: Math.round((s.total / s.count) * 10) / 10,
      pct: Math.round((s.total / s.maxTotal) * 100),
      count: s.count,
    })).sort((a, b) => a.subject.localeCompare(b.subject));
    console.log('Marks summary result:', subjects.map(s => s.subject + '=' + s.pct + '%'));
    res.json({ success: true, subjects });
  } catch (err) {
    console.error('Marks summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/marks/class/:classId', async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/results/halfyear routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const { classId } = req.params;
    const [marksSnap, studentsSnap] = await Promise.all([
      db.collection('student_marks').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId).get(),
      db.collection('students').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId).get(),
    ]);

    const studentBase = {};
    studentsSnap.docs.forEach(d => {
      const s = d.data();
      studentBase[s.studentId] = { studentId: s.studentId, name: s.name, rollNumber: s.rollNumber };
    });

    const studentAccum = {};
    marksSnap.docs.forEach(d => {
      const m = d.data();
      if (!studentAccum[m.studentId]) {
        studentAccum[m.studentId] = {
          ...(studentBase[m.studentId] || { studentId: m.studentId, name: m.studentName || '', rollNumber: 0 }),
          bySubject: {}, byExam: {},
        };
      }
      const sa = studentAccum[m.studentId];
      const mSubject = normalizeSubjectName(m.subject);
      if (!sa.bySubject[mSubject]) sa.bySubject[mSubject] = { total: 0, maxTotal: 0 };
      sa.bySubject[mSubject].total += (Number(m.marksObtained) || 0);
      sa.bySubject[mSubject].maxTotal += (Number(m.maxMarks) || 20);
      const mExam = normalizeExamType(m.examType);
      if (!sa.byExam[mExam]) sa.byExam[mExam] = { total: 0, maxTotal: 0, subjects: [] };
      sa.byExam[mExam].total += (Number(m.marksObtained) || 0);
      sa.byExam[mExam].maxTotal += (Number(m.maxMarks) || 20);
      sa.byExam[mExam].subjects.push({ subject: mSubject, marks: Number(m.marksObtained) || 0, maxMarks: Number(m.maxMarks) || 20 });
    });

    const FIXED_SUBJ = ['English', 'Mathematics', 'Science', 'Social Studies', 'Telugu'];

    const students = Object.values(studentAccum).map(s => {
      const allTotal = Object.values(s.bySubject).reduce((a, v) => a + v.total, 0);
      const allMax = Object.values(s.bySubject).reduce((a, v) => a + v.maxTotal, 0);

      const byExam = Object.entries(s.byExam).map(([examType, v]) => {
        // Pad each exam's subjects with the full fixed list so every student shows all 5
        const entered = new Set(v.subjects.map(sub => sub.subject));
        FIXED_SUBJ.forEach(subject => {
          if (!entered.has(subject)) {
            v.subjects.push({ subject, marks: null, maxMarks: 20, notEntered: true });
          }
        });
        v.subjects.sort((a, b) => a.subject.localeCompare(b.subject));
        return {
          examType, total: v.total, maxTotal: v.maxTotal,
          pct: v.maxTotal > 0 ? Math.round((v.total / v.maxTotal) * 100) : 0,
          subjects: v.subjects,
        };
      }).sort((a, b) => a.examType.localeCompare(b.examType));

      return {
        studentId: s.studentId, name: s.name, rollNumber: s.rollNumber,
        overallPct: allMax > 0 ? Math.round((allTotal / allMax) * 100) : 0,
        bySubject: Object.entries(s.bySubject).map(([subject, v]) => ({
          subject, pct: Math.round((v.total / v.maxTotal) * 100),
          avg: Math.round((v.total / v.maxTotal) * 20 * 10) / 10,
        })).sort((a, b) => a.subject.localeCompare(b.subject)),
        byExam,
      };
    }).sort((a, b) => b.overallPct - a.overallPct);

    const classSubjectMap = {};
    const classExamMap = {};
    marksSnap.docs.forEach(d => {
      const m = d.data();
      const csSubject = normalizeSubjectName(m.subject);
      if (!classSubjectMap[csSubject]) classSubjectMap[csSubject] = { total: 0, maxTotal: 0 };
      classSubjectMap[csSubject].total += (Number(m.marksObtained) || 0);
      classSubjectMap[csSubject].maxTotal += (Number(m.maxMarks) || 20);
      const cExam = normalizeExamType(m.examType);
      if (!classExamMap[cExam]) classExamMap[cExam] = { total: 0, maxTotal: 0 };
      classExamMap[cExam].total += m.marksObtained;
      classExamMap[cExam].maxTotal += (m.maxMarks || 20);
    });
    const classAvgBySubject = Object.entries(classSubjectMap).map(([subject, v]) => ({
      subject, pct: Math.round((v.total / v.maxTotal) * 100),
    })).sort((a, b) => a.subject.localeCompare(b.subject));
    const classAvgByExam = Object.entries(classExamMap).map(([examType, v]) => ({
      examType, pct: Math.round((v.total / v.maxTotal) * 100),
    })).sort((a, b) => a.examType.localeCompare(b.examType));
    const allTotal = marksSnap.docs.reduce((a, d) => a + d.data().marksObtained, 0);
    const allMax = marksSnap.docs.reduce((a, d) => a + (d.data().maxMarks || 20), 0);
    const classOverallPct = allMax > 0 ? Math.round((allTotal / allMax) * 100) : 0;

    res.json({ success: true, students, classAvgBySubject, classAvgByExam, classOverallPct, total: marksSnap.size });
  } catch (err) {
    console.error('Class marks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const FIXED_SUBJECTS = ['English', 'Mathematics', 'Science', 'Social Studies', 'Telugu'];

app.get('/api/marks/student/:studentId', async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/student-summary routes instead');
  console.warn('[DEPRECATED] Old marks route called:', req.path);
  try {
    const { studentId } = req.params;
    const snapshot = await db.collection('student_marks').where('studentId', '==', studentId).get();
    const examMap = {};
    const subjectMap = {};
    console.log(`[marks/student] studentId=${studentId} | total records in DB: ${snapshot.size}`);

    snapshot.docs.forEach(d => {
      const m = d.data();
      const mSubject = normalizeSubjectName(m.subject);
      const mExamN = normalizeExamType(m.examType);
      if (!examMap[mExamN]) examMap[mExamN] = { subjects: [] };
      examMap[mExamN].subjects.push({ subject: mSubject, marks: Number(m.marksObtained), maxMarks: Number(m.maxMarks) || 20, notEntered: false });
      if (!subjectMap[mSubject]) subjectMap[mSubject] = [];
      subjectMap[mSubject].push({ examType: mExamN, marks: Number(m.marksObtained) || 0, maxMarks: Number(m.maxMarks) || 20 });
    });

    // Pad every exam with the full fixed subject list — subjects with no data show as notEntered
    Object.keys(examMap).forEach(examType => {
      const enteredSubjects = new Set(examMap[examType].subjects.map(s => s.subject));
      FIXED_SUBJECTS.forEach(subject => {
        if (!enteredSubjects.has(subject)) {
          examMap[examType].subjects.push({ subject, marks: null, maxMarks: 20, notEntered: true });
        }
      });
      examMap[examType].subjects.sort((a, b) => a.subject.localeCompare(b.subject));
    });

    const byExam = Object.entries(examMap).map(([examType, v]) => {
      // Only count entered subjects in totals and percentages
      const entered = v.subjects.filter(s => !s.notEntered);
      const total = entered.reduce((a, s) => a + s.marks, 0);
      const maxTotal = entered.reduce((a, s) => a + s.maxMarks, 0);
      console.log(`[marks/student] ${examType}: ${entered.length}/${v.subjects.length} subjects entered — ${v.subjects.map(s => s.subject + (s.notEntered ? '(-)' : `(${s.marks})`)).join(', ')}`);
      return {
        examType,
        subjects: v.subjects,
        total, maxTotal,
        pct: maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0,
        avg: entered.length > 0 ? Math.round((total / entered.length) * 10) / 10 : 0,
      };
    }).sort((a, b) => a.examType.localeCompare(b.examType));

    const bySubject = Object.entries(subjectMap).map(([subject, exams]) => {
      const total = exams.reduce((a, e) => a + e.marks, 0);
      const maxTotal = exams.reduce((a, e) => a + e.maxMarks, 0);
      return { subject, exams: exams.sort((a, b) => a.examType.localeCompare(b.examType)),
        pct: maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0,
        avg: exams.length > 0 ? Math.round((total / exams.length) * 10) / 10 : 0 };
    }).sort((a, b) => a.subject.localeCompare(b.subject));

    const allTotal = snapshot.docs.reduce((a, d) => a + (Number(d.data().marksObtained) || 0), 0);
    const allMax = snapshot.docs.reduce((a, d) => a + (Number(d.data().maxMarks) || 20), 0);
    const overallPct = allMax > 0 ? Math.round((allTotal / allMax) * 100) : 0;
    res.json({ success: true, byExam, bySubject, overallPct, total: snapshot.size });
  } catch (err) {
    console.error('Student marks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function getGrade(pct) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B+';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  return 'F';
}

app.post('/api/reports/report-card/:studentId', verifyAuth, async (req, res) => {
  // DEPRECATED — remove after CCE migration confirmed
  res.set('X-Deprecated', 'Use /api/cce/student-summary routes instead');
  console.warn('[DEPRECATED] Old report-card route called:', req.path);
  try {
    const { studentId } = req.params;
    const { examName, academicYear } = req.body;
    if (!examName) return res.status(400).json({ error: 'examName is required' });
    const year = academicYear || `${new Date().getFullYear()}-${String(new Date().getFullYear() + 1).slice(2)}`;
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    if (req.userRole === 'parent') {
      const parentSnap = await db.collection('parent_accounts').where('studentIds', 'array-contains', studentId).get();
      const parentDoc = parentSnap.docs.find(d => d.data().email === req.user.email);
      if (!parentDoc) return res.status(403).json({ error: 'Access denied' });
    }

    const studentSnap = await db.collection('students').where('studentId', '==', studentId).where('schoolId', '==', schoolId).get();
    let student;
    if (!studentSnap.empty) {
      student = studentSnap.docs[0].data();
    } else {
      const studentDocById = await db.collection('students').doc(studentId).get();
      if (!studentDocById.exists || (studentDocById.data().schoolId && studentDocById.data().schoolId !== schoolId)) {
        return res.status(404).json({ error: 'Student not found' });
      }
      student = studentDocById.data();
    }

    const settingsDoc = await db.collection('settings').doc(schoolId).get();
    const schoolInfo = settingsDoc.exists ? settingsDoc.data() : {};
    const schoolName = schoolInfo.school_name || schoolInfo.schoolName || 'Sree Pragathi High School';

    const marksSnap = await db.collection('student_marks').where('studentId', '==', studentId).where('schoolId', '==', schoolId).where('examType', '==', examName).get();

    let marksDocs;
    if (marksSnap.empty) {
      const normalizedExam = normalizeExamType(examName);
      const allMarksSnap = await db.collection('student_marks').where('studentId', '==', studentId).where('schoolId', '==', schoolId).get();
      const filtered = allMarksSnap.docs.filter(d => normalizeExamType(d.data().examType) === normalizedExam);
      if (filtered.length === 0) return res.status(404).json({ error: 'No marks found for this exam' });
      marksDocs = filtered;
    } else {
      marksDocs = marksSnap.docs;
    }

    const subjects = marksDocs.map(d => {
      const m = d.data();
      const max = Number(m.maxMarks) || 20;
      const obtained = Number(m.marksObtained) || 0;
      const pct = max > 0 ? Math.round((obtained / max) * 100) : 0;
      return { subject: normalizeSubjectName(m.subject), maxMarks: max, marksObtained: obtained, grade: getGrade(pct) };
    }).sort((a, b) => a.subject.localeCompare(b.subject));

    const totalObtained = subjects.reduce((a, s) => a + s.marksObtained, 0);
    const totalMax = subjects.reduce((a, s) => a + s.maxMarks, 0);
    const overallPct = totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : 0;
    const overallGrade = getGrade(overallPct);

    let attendanceSummary = { present: 0, total: 0, pct: 0 };
    try {
      const studentAttSnap = await db.collection('student_attendance').doc(studentId).collection('dates').get();
      if (!studentAttSnap.empty) {
        const total = studentAttSnap.size;
        const present = studentAttSnap.docs.filter(d => d.data().status === 'Present').length;
        attendanceSummary = { present, total, pct: total > 0 ? Math.round((present / total) * 100) : 0 };
      }
    } catch (attErr) {
      console.warn('[report-card] Attendance fetch failed:', attErr.message);
    }

    const pdfDoc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    pdfDoc.on('data', chunk => chunks.push(chunk));

    const pdfDone = new Promise((resolve, reject) => {
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);
    });

    const pageW = pdfDoc.page.width - 100;

    pdfDoc.fontSize(20).font('Helvetica-Bold').text(schoolName, { align: 'center' });
    pdfDoc.moveDown(0.3);
    pdfDoc.fontSize(10).font('Helvetica').fillColor('#666666').text('Gopalraopet, Telangana', { align: 'center' });
    pdfDoc.moveDown(0.5);
    pdfDoc.moveTo(50, pdfDoc.y).lineTo(50 + pageW, pdfDoc.y).strokeColor('#333333').lineWidth(1.5).stroke();
    pdfDoc.moveDown(0.5);
    pdfDoc.fontSize(14).font('Helvetica-Bold').fillColor('#000000').text('REPORT CARD', { align: 'center' });
    pdfDoc.moveDown(0.3);
    pdfDoc.fontSize(10).font('Helvetica').fillColor('#444444').text(`${examName}  |  Academic Year: ${year}`, { align: 'center' });
    pdfDoc.moveDown(1);

    const infoY = pdfDoc.y;
    pdfDoc.fontSize(10).font('Helvetica').fillColor('#000000');
    pdfDoc.text(`Student Name:`, 50, infoY, { continued: true }).font('Helvetica-Bold').text(`  ${student.full_name || student.name || 'N/A'}`);
    pdfDoc.font('Helvetica').text(`Class:`, 50, infoY + 18, { continued: true }).font('Helvetica-Bold').text(`  ${student.className || student.classId || 'N/A'}`);
    pdfDoc.font('Helvetica').text(`Roll Number:`, 50, infoY + 36, { continued: true }).font('Helvetica-Bold').text(`  ${student.rollNumber || student.roll_number || 'N/A'}`);
    pdfDoc.y = infoY + 60;
    pdfDoc.moveDown(0.5);

    const tableTop = pdfDoc.y;
    const colWidths = [pageW * 0.40, pageW * 0.20, pageW * 0.25, pageW * 0.15];
    const colX = [50, 50 + colWidths[0], 50 + colWidths[0] + colWidths[1], 50 + colWidths[0] + colWidths[1] + colWidths[2]];
    const rowH = 24;

    pdfDoc.rect(50, tableTop, pageW, rowH).fill('#2c3e50');
    pdfDoc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff');
    pdfDoc.text('Subject', colX[0] + 6, tableTop + 7);
    pdfDoc.text('Max Marks', colX[1] + 6, tableTop + 7);
    pdfDoc.text('Obtained', colX[2] + 6, tableTop + 7);
    pdfDoc.text('Grade', colX[3] + 6, tableTop + 7);

    let y = tableTop + rowH;
    subjects.forEach((s, i) => {
      const bgColor = i % 2 === 0 ? '#f9f9f9' : '#ffffff';
      pdfDoc.rect(50, y, pageW, rowH).fill(bgColor);
      pdfDoc.fontSize(9).font('Helvetica').fillColor('#000000');
      pdfDoc.text(s.subject, colX[0] + 6, y + 7, { width: colWidths[0] - 12 });
      pdfDoc.text(String(s.maxMarks), colX[1] + 6, y + 7);
      pdfDoc.text(String(s.marksObtained), colX[2] + 6, y + 7);
      const gradeColor = s.grade === 'A+' || s.grade === 'A' ? '#27ae60' : s.grade === 'F' ? '#e74c3c' : '#2c3e50';
      pdfDoc.font('Helvetica-Bold').fillColor(gradeColor).text(s.grade, colX[3] + 6, y + 7);
      y += rowH;
    });

    pdfDoc.rect(50, y, pageW, rowH).fill('#ecf0f1');
    pdfDoc.fontSize(10).font('Helvetica-Bold').fillColor('#2c3e50');
    pdfDoc.text('Total', colX[0] + 6, y + 7);
    pdfDoc.text(String(totalMax), colX[1] + 6, y + 7);
    pdfDoc.text(String(totalObtained), colX[2] + 6, y + 7);
    pdfDoc.text(overallGrade, colX[3] + 6, y + 7);
    y += rowH;

    pdfDoc.rect(50, y, pageW, 1).fill('#333333');
    y += 10;

    pdfDoc.fontSize(11).font('Helvetica-Bold').fillColor('#2c3e50').text(`Percentage: ${overallPct}%`, 50, y);
    y += 18;
    pdfDoc.text(`Overall Grade: ${overallGrade}`, 50, y);
    y += 30;

    pdfDoc.fontSize(11).font('Helvetica-Bold').fillColor('#2c3e50').text('Attendance Summary', 50, y);
    y += 18;
    pdfDoc.fontSize(10).font('Helvetica').fillColor('#000000');
    pdfDoc.text(`Days Present: ${attendanceSummary.present} / ${attendanceSummary.total}`, 50, y);
    y += 16;
    pdfDoc.text(`Attendance Percentage: ${attendanceSummary.pct}%`, 50, y);
    y += 40;

    pdfDoc.moveTo(50, y).lineTo(50 + pageW, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
    y += 10;
    pdfDoc.fontSize(8).font('Helvetica').fillColor('#999999').text(`Generated on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}`, 50, y);

    pdfDoc.end();
    const pdfBuffer = await pdfDone;

    const safeName = (student.full_name || student.name || 'student').replace(/[^a-zA-Z0-9]/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="report-card-${safeName}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
    console.log(`[report-card] Generated for student ${studentId} exam ${examName} — ${subjects.length} subjects, ${overallPct}%`);
  } catch (err) {
    console.error('[report-card] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate report card' });
  }
});

app.get('/api/admin/promotion/preview', verifyAuth, async (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const { fromClass, academicYear } = req.query;
    if (!fromClass || !academicYear) return res.status(400).json({ error: 'fromClass and academicYear are required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const studentsSnap = await db.collection('students').where('schoolId', '==', schoolId).where('className', '==', fromClass).get();

    if (studentsSnap.empty) {
      const studentsById = await db.collection('students').where('schoolId', '==', schoolId).where('classId', '==', fromClass).get();
      if (studentsById.empty) return res.json({ success: true, students: [] });
      var studentDocs = studentsById.docs;
    } else {
      var studentDocs = studentsSnap.docs;
    }

    const students = [];
    for (const sDoc of studentDocs) {
      const s = sDoc.data();
      const sid = s.studentId || sDoc.id;

      let attendancePercent = 0;
      try {
        const attSnap = await db.collection('student_attendance').doc(sid).collection('dates').get();
        if (!attSnap.empty) {
          const present = attSnap.docs.filter(d => d.data().status === 'Present').length;
          attendancePercent = Math.round((present / attSnap.size) * 100);
        }
      } catch (e) {}

      const marksSnap = await db.collection('student_marks').where('studentId', '==', sid).where('schoolId', '==', schoolId).get();

      let averageMarks = 0;
      let passStatus = 'pass';
      if (!marksSnap.empty) {
        const subjectBest = {};
        marksSnap.docs.forEach(d => {
          const m = d.data();
          const subj = normalizeSubjectName(m.subject);
          const pct = (Number(m.maxMarks) || 20) > 0 ? Math.round((Number(m.marksObtained) || 0) / (Number(m.maxMarks) || 20) * 100) : 0;
          if (!subjectBest[subj] || pct > subjectBest[subj]) subjectBest[subj] = pct;
        });
        const pcts = Object.values(subjectBest);
        averageMarks = pcts.length > 0 ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
        if (pcts.some(p => p < 35)) passStatus = 'fail';
      } else {
        passStatus = 'fail';
      }

      students.push({
        studentId: sid,
        docId: sDoc.id,
        name: s.full_name || s.name || 'Unknown',
        rollNumber: s.rollNumber || s.roll_number || '',
        className: s.className || fromClass,
        attendancePercent,
        averageMarks,
        passStatus,
      });
    }

    students.sort((a, b) => {
      const ra = Number(a.rollNumber) || 999;
      const rb = Number(b.rollNumber) || 999;
      return ra - rb;
    });

    console.log(`[promotion/preview] class=${fromClass} year=${academicYear} — ${students.length} students, ${students.filter(s => s.passStatus === 'pass').length} passing`);
    res.json({ success: true, students });
  } catch (err) {
    console.error('[promotion/preview] Error:', err.message);
    res.status(500).json({ error: 'Failed to load promotion preview' });
  }
});

function getNextClass(className) {
  const match = className.match(/(\d+)/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return className.replace(/\d+/, String(num + 1));
}

app.post('/api/admin/promotion/execute', verifyAuth, async (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const { promotions, academicYear } = req.body;
    if (!promotions || !Array.isArray(promotions) || promotions.length === 0) {
      return res.status(400).json({ error: 'promotions array is required' });
    }
    if (!academicYear) return res.status(400).json({ error: 'academicYear is required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const performedBy = req.userId || req.user?.email || 'admin';

    const results = { promoted: 0, retained: 0, graduated: 0, errors: [] };
    const batchSize = 400;
    let batch = db.batch();
    let opCount = 0;

    const flushBatch = async () => {
      if (opCount > 0) {
        await batch.commit();
        batch = db.batch();
        opCount = 0;
      }
    };

    for (const p of promotions) {
      try {
        const { studentId, action } = p;
        if (!studentId || !['promote', 'retain', 'graduate'].includes(action)) {
          results.errors.push({ studentId, error: 'Invalid action' });
          continue;
        }

        let studentDocRef;
        let studentData;
        const byFieldSnap = await db.collection('students').where('studentId', '==', studentId).where('schoolId', '==', schoolId).get();
        if (!byFieldSnap.empty) {
          studentDocRef = byFieldSnap.docs[0].ref;
          studentData = byFieldSnap.docs[0].data();
        } else {
          const directDoc = await db.collection('students').doc(studentId).get();
          if (!directDoc.exists) {
            results.errors.push({ studentId, error: 'Student not found' });
            continue;
          }
          studentDocRef = db.collection('students').doc(studentId);
          studentData = directDoc.data();
        }

        const fromClass = studentData.className || studentData.classId || '';
        let toClass = fromClass;
        const updates = {};

        if (action === 'promote') {
          toClass = getNextClass(fromClass);
          if (!toClass) {
            results.errors.push({ studentId, error: 'Cannot determine next class' });
            continue;
          }
          updates.className = toClass;
          updates.classId = toClass;
          results.promoted++;
        } else if (action === 'retain') {
          updates.notes = `Retained - ${academicYear}`;
          results.retained++;
        } else if (action === 'graduate') {
          updates.status = 'alumni';
          updates.className = '';
          updates.classId = '';
          toClass = 'Alumni';
          results.graduated++;
        }

        batch.update(studentDocRef, updates);
        opCount++;

        const historyRef = db.collection('promotionHistory').doc();
        batch.set(historyRef, {
          studentId,
          studentName: studentData.full_name || studentData.name || '',
          fromClass,
          toClass: action === 'retain' ? fromClass : toClass,
          action,
          academicYear,
          schoolId,
          performedBy,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        opCount++;

        if (opCount >= batchSize) await flushBatch();
      } catch (pErr) {
        results.errors.push({ studentId: p.studentId, error: pErr.message });
      }
    }

    await flushBatch();

    console.log(`[promotion/execute] year=${academicYear} by=${performedBy} — promoted:${results.promoted} retained:${results.retained} graduated:${results.graduated} errors:${results.errors.length}`);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[promotion/execute] Error:', err.message);
    res.status(500).json({ error: 'Failed to execute promotions' });
  }
});

app.get('/api/onboarded-users', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can view staff directory' });
    }
    const usersRef = db.collection('users');
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const q = usersRef.where('schoolId', '==', schoolId).where('role', 'in', ['teacher', 'staff', 'driver', 'cleaner']);
    const snapshot = await q.get();

    const users = snapshot.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        full_name: data.full_name,
        role: data.role,
        role_id: data.role_id,
        subjects: normalizeSubjectIds(data.subjects || data.subject || []),
        subject: data.subject || '',
        email: data.email || '',
        phone: data.phone || '',
        mobile: data.mobile || '',
        blood_group: data.blood_group || '',
        emergency_contact: data.emergency_contact || '',
        date_of_birth: data.date_of_birth || '',
        join_date: data.join_date || data.joined_date || '',
        profileCompleted: data.profileCompleted || false,
        status: data.status || 'pending_registration',
        created_at: data.created_at,
        classTeacherOf: data.classTeacherOf || null,
        assignedClasses: data.assignedClasses || [],
      };
    });

    res.json({ users });
  } catch (err) {
    console.error('Onboarded users fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch onboarded users' });
  }
});

app.post('/api/admin/fix-missing-auth', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can fix auth accounts' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const usersRef = db.collection('users');
    const snap1 = await usersRef.where('schoolId', '==', schoolId).get();
    const snap2 = await usersRef.where('schoolId', '==', null).get();
    const snap3 = await usersRef.where('onboarded_by', 'in', ['principal', 'admin']).get();
    const allDocs = new Map();
    [...snap1.docs, ...snap2.docs, ...snap3.docs].forEach(d => allDocs.set(d.id, d));
    const fixed = [];
    const skipped = [];
    const errors = [];
    for (const [docId, doc] of allDocs) {
      const u = doc.data();
      if (u.uid || !u.email) { skipped.push(u.role_id || docId); continue; }
      const phone = u.phone || u.mobile || '000000';
      const defaultPassword = `${phone.slice(-4)}@Vidyalayam`;
      try {
        let fbUser;
        try {
          fbUser = await adminAuth.createUser({ email: u.email.trim().toLowerCase(), password: defaultPassword });
        } catch (authErr) {
          if (authErr.code === 'auth/email-already-exists') {
            fbUser = await adminAuth.getUserByEmail(u.email.trim().toLowerCase());
          } else { throw authErr; }
        }
        const updateData = { uid: fbUser.uid, status: 'onboarded' };
        if (!u.schoolId) updateData.schoolId = schoolId;
        await usersRef.doc(doc.id).update(updateData);
        fixed.push({ roleId: u.role_id, email: u.email, defaultPassword });
        console.log(`[FixAuth] Created auth for ${u.email} (${u.role_id})`);
      } catch (e) {
        errors.push({ roleId: u.role_id, email: u.email, error: e.message });
        console.error(`[FixAuth] Failed for ${u.email}:`, e.message);
      }
    }
    res.json({ success: true, fixed, skipped: skipped.length, errors });
  } catch (err) {
    console.error('Fix auth error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-user-password', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can reset passwords' });
    }
    const { email, newPassword } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const password = newPassword || `${Date.now().toString().slice(-4)}@Vidyalayam`;
    try {
      const fbUser = await adminAuth.getUserByEmail(email.trim().toLowerCase());
      await adminAuth.updateUser(fbUser.uid, { password });
      console.log(`[AdminReset] Password reset for ${email}`);
      res.json({ success: true, email, newPassword: password });
    } catch (authErr) {
      if (authErr.code === 'auth/user-not-found') {
        const fbUser = await adminAuth.createUser({ email: email.trim().toLowerCase(), password });
        const usersRef = db.collection('users');
        const userSnap = await usersRef.where('email', '==', email.trim().toLowerCase()).limit(1).get();
        if (!userSnap.empty) {
          await usersRef.doc(userSnap.docs[0].id).update({ uid: fbUser.uid, status: 'onboarded' });
        }
        console.log(`[AdminReset] Created new auth account for ${email}`);
        res.json({ success: true, email, newPassword: password, created: true });
      } else {
        throw authErr;
      }
    }
  } catch (err) {
    console.error('Admin reset password error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/onboard-teacher', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can onboard staff' });
    }
    const { fullName, role, subject, subjects, email, phone, joinDate } = req.body;
    const subjectIds = normalizeSubjectIds(subjects || subject || []);
    console.log('Onboard teacher request:', { fullName, role, subjectIds });

    if (!fullName || !role) {
      return res.status(400).json({ error: 'Full name and role are required' });
    }
    if (!['teacher', 'staff'].includes(role)) {
      return res.status(400).json({ error: 'Role must be teacher or staff' });
    }
    if (!phone) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (subjectIds.length === 0) {
      return res.status(400).json({ error: 'At least one subject is required' });
    }

    const year = new Date().getFullYear();
    const usersRef = db.collection('users');
    let teacherId;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 20) {
      const rand = Math.floor(1000 + Math.random() * 9000);
      teacherId = `TCH-${year}-${rand}`;
      const q = usersRef.where('role_id', '==', teacherId);
      const snap = await q.get();
      if (snap.empty) isUnique = true;
      attempts++;
    }

    if (!isUnique) {
      return res.status(500).json({ error: 'Could not generate unique Teacher ID. Please try again.' });
    }

    const defaultPassword = `${phone.slice(-4)}@Vidyalayam`;
    let uid = null;
    let authCreated = false;
    if (email) {
      try {
        const fbUser = await adminAuth.createUser({ email: email.trim().toLowerCase(), password: defaultPassword });
        uid = fbUser.uid;
        authCreated = true;
        console.log(`Firebase Auth account created for ${email} (uid: ${uid})`);
      } catch (authErr) {
        if (authErr.code === 'auth/email-already-exists') {
          try {
            const existing = await adminAuth.getUserByEmail(email.trim().toLowerCase());
            uid = existing.uid;
            console.log(`Firebase Auth account already exists for ${email} (uid: ${uid})`);
          } catch (e2) { console.error('Could not fetch existing auth user:', e2.message); }
        } else {
          console.error('Firebase Auth create failed for teacher:', authErr.code, authErr.message);
        }
      }
    }

    const userData = {
      full_name: fullName,
      email: email || '',
      role: role,
      role_id: teacherId,
      subject: subjectIds[0] || '',
      subjects: subjectIds,
      phone: phone || '',
      status: authCreated ? 'onboarded' : 'pending_registration',
      join_date: joinDate || new Date().toISOString().split('T')[0],
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      created_at: new Date().toISOString(),
      onboarded_by: req.userRole || 'principal',
    };
    if (uid) userData.uid = uid;

    const docRef = await usersRef.add(userData);
    console.log(`Onboarded ${role}: ${fullName} | ID: ${teacherId} | Firestore doc: ${docRef.id}`);

    await syncTeacherAggregateDoc({
      schoolId: req.schoolId || DEFAULT_SCHOOL_ID,
      roleId: teacherId,
      teacherDocId: docRef.id,
      subjects: subjectIds,
    });

    let sheetSync = { success: false };
    try {
      sheetSync = await syncUserDirectory({
        teacherId,
        fullName,
        role,
        subject: subjectIds.map(getSubjectLabel).join(', '),
        email: email || '',
        phone: phone || '',
        status: authCreated ? 'Active' : 'Pending Registration',
        onboardedDate: joinDate || new Date().toISOString().split('T')[0],
      });
    } catch (syncErr) {
      console.error('Google Sheets sync (user directory) failed:', syncErr.message);
    }
    safeSync('syncTeacher', () => syncTeacher({ teacherId, name: fullName, email: email || '', phone: phone || '', subject: subjectIds.map(getSubjectLabel).join(', '), designation: role, joiningDate: joinDate || new Date().toISOString().split('T')[0], createdAt: new Date().toISOString() }), { teacherId }).catch(() => {});

    res.status(201).json({
      success: true,
      teacherId,
      defaultPassword: authCreated ? defaultPassword : undefined,
      user: {
        id: docRef.id,
        full_name: fullName,
        role,
        role_id: teacherId,
        subject: subjectIds[0] || '',
        subjects: subjectIds,
        email: email || '',
        phone: phone || '',
        status: authCreated ? 'onboarded' : 'pending_registration',
      },
      sheetSync: sheetSync.success,
    });
  } catch (err) {
    console.error('Onboard teacher error:', err.code || '', err.message || err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.post('/api/add-logistics-staff', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can add logistics staff' });
    }
    const { fullName, type, busNumber, route, assignedArea, phone, license, experience, email, joinDate } = req.body;
    console.log('Add logistics staff request:', { fullName, type });

    if (!fullName || !type) {
      return res.status(400).json({ error: 'Full name and type are required' });
    }
    if (!['driver', 'cleaner'].includes(type)) {
      return res.status(400).json({ error: 'Type must be driver or cleaner' });
    }
    if (!phone) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }
    if (type === 'driver' && !license) {
      return res.status(400).json({ error: 'License number is required for drivers' });
    }
    if (type === 'driver' && !experience) {
      return res.status(400).json({ error: 'Years of experience is required for drivers' });
    }

    const prefix = type === 'driver' ? 'DRV' : 'CLN';
    const logisticsRef = db.collection('logistics_staff');
    let staffId;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 20) {
      const rand = Math.floor(1000 + Math.random() * 9000);
      staffId = `${prefix}-${rand}`;
      const q = logisticsRef.where('staff_id', '==', staffId);
      const snap = await q.get();
      if (snap.empty) isUnique = true;
      attempts++;
    }

    if (!isUnique) {
      return res.status(500).json({ error: 'Could not generate unique Staff ID. Please try again.' });
    }

    const defaultPassword = `${phone.slice(-4)}@Vidyalayam`;
    let uid = null;
    let authCreated = false;
    if (email) {
      try {
        const fbUser = await adminAuth.createUser({ email: email.trim().toLowerCase(), password: defaultPassword });
        uid = fbUser.uid;
        authCreated = true;
        console.log(`Firebase Auth account created for ${type} ${email} (uid: ${uid})`);
      } catch (authErr) {
        if (authErr.code === 'auth/email-already-exists') {
          try {
            const existing = await adminAuth.getUserByEmail(email.trim().toLowerCase());
            uid = existing.uid;
            console.log(`Firebase Auth account already exists for ${email} (uid: ${uid})`);
          } catch (e2) { console.error('Could not fetch existing auth user:', e2.message); }
        } else {
          console.error('Firebase Auth create failed for logistics staff:', authErr.code, authErr.message);
        }
      }
    }

    const staffData = {
      full_name: fullName,
      type: type,
      staff_id: staffId,
      bus_number: busNumber || '',
      route: route || '',
      assigned_area: assignedArea || '',
      phone: phone || '',
      license: license || '',
      experience: experience || '',
      email: email || '',
      status: 'active',
      join_date: joinDate || new Date().toISOString().split('T')[0],
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      created_at: new Date().toISOString(),
      added_by: 'principal',
    };
    if (uid) staffData.uid = uid;

    const docRef = await logisticsRef.add(staffData);
    console.log(`Added ${type}: ${fullName} | ID: ${staffId} | Firestore doc: ${docRef.id}`);

    if (uid && email) {
      const usersRef = db.collection('users');
      await usersRef.add({
        uid: uid,
        full_name: fullName,
        email: email.trim().toLowerCase(),
        role: type,
        role_id: staffId,
        phone: phone || '',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        status: 'onboarded',
        created_at: new Date().toISOString(),
        onboarded_by: 'principal',
      });
      console.log(`Created users doc for ${type} ${staffId} so they can log in`);
    }

    let sheetSync = { success: false };
    try {
      sheetSync = await syncLogisticsStaff({
        staffId,
        fullName,
        type: type === 'driver' ? 'Bus Driver' : 'General Staff',
        busNumber: busNumber || '',
        route: route || '',
        assignedArea: assignedArea || '',
        phone: phone || '',
        email: email || '',
        license: license || '',
        experience: experience || '',
        status: 'Active',
        addedDate: joinDate || new Date().toISOString().split('T')[0],
      });
    } catch (syncErr) {
      console.error('Google Sheets sync (logistics staff) failed:', syncErr.message);
    }

    res.status(201).json({
      success: true,
      staffId,
      defaultPassword: authCreated ? defaultPassword : undefined,
      staff: {
        id: docRef.id,
        full_name: fullName,
        type,
        staff_id: staffId,
        bus_number: busNumber || '',
        route: route || '',
        assigned_area: assignedArea || '',
        phone: phone || '',
        status: 'active',
      },
      sheetSync: sheetSync.success,
    });
  } catch (err) {
    console.error('Add logistics staff error:', err.code || '', err.message || err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.get('/api/logistics-staff', async (req, res) => {
  try {
    const logisticsRef = db.collection('logistics_staff');
    const snapshot = await logisticsRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    const staff = snapshot.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        full_name: data.full_name,
        type: data.type,
        staff_id: data.staff_id,
        bus_number: data.bus_number || '',
        route: data.route || '',
        assigned_area: data.assigned_area || '',
        phone: data.phone || '',
        email: data.email || '',
        license: data.license || '',
        experience: data.experience || '',
        blood_group: data.blood_group || '',
        emergency_contact: data.emergency_contact || '',
        date_of_birth: data.date_of_birth || '',
        profileCompleted: data.profileCompleted || false,
        status: data.status || 'active',
        created_at: data.created_at,
      };
    });
    res.json({ staff });
  } catch (err) {
    console.error('Logistics staff fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch logistics staff' });
  }
});

app.post('/api/delete-user', async (req, res) => {
  try {
    if (req.userRole !== 'principal' && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin or principal can deactivate users' });
    }
    const { roleId, collection: collName } = req.body;
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });

    let sheetName = 'User_Directory';
    let firestoreCollection = 'users';
    let idField = 'role_id';

    if (collName === 'logistics_staff') {
      firestoreCollection = 'logistics_staff';
      idField = 'staff_id';
      sheetName = 'Logistics_Staff';
    }

    const colRef = db.collection(firestoreCollection);
    const q = colRef.where(idField, '==', roleId);
    const snapshot = await q.get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = snapshot.docs[0];
    await db.collection(firestoreCollection).doc(userDoc.id).update({ status: 'inactive' });

    let sheetSync = false;
    try {
      const result = await markUserInactiveInSheets({ roleId, sheetName });
      sheetSync = result.success;
    } catch (sheetErr) {
      console.error('Sheet sync failed during delete:', sheetErr.message);
    }

    console.log(`Marked ${roleId} as inactive in ${firestoreCollection}`);
    res.json({ success: true, sheetSync });
  } catch (err) {
    console.error('Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.post('/api/attendance/save', validate([
  body('records').isArray({ min: 1 }).withMessage('records must be a non-empty array'),
  body('date').notEmpty().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date must be in YYYY-MM-DD format'),
  body('records.*.studentId').notEmpty().withMessage('Each record must have a studentId'),
  body('records.*.status').isIn(['Present', 'Absent']).withMessage('Each record status must be Present or Absent'),
]), async (req, res) => {
  try {
    const { records, date, teacherName, className } = req.body;
    console.log('Attendance save request:', { date, recordCount: records?.length, markedBy: records?.[0]?.markedBy || 'NOT SET' });

    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'No attendance records provided' });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    for (const record of records) {
      if (!record.studentId || !record.studentName || !record.classId || !record.schoolId) {
        return res.status(400).json({ error: 'Each record must have studentId, studentName, classId, and schoolId' });
      }
      if (!['Present', 'Absent'].includes(record.status)) {
        return res.status(400).json({ error: `Invalid status "${record.status}" for student ${record.studentId}. Must be "Present" or "Absent"` });
      }
      if (record.date !== date) {
        return res.status(400).json({ error: `Record date "${record.date}" does not match request date "${date}"` });
      }
    }

    const submittedAt = new Date().toISOString();
    const markedBy = records[0]?.markedBy || 'teacher';
    const classId = records[0]?.classId;
    const resolvedClassName = className || records[0]?.className || classId || '';
    const submissionDocId = `${classId}_${date}`;

    const existingSubmission = await db.collection('attendance_submissions').doc(submissionDocId).get();
    if (existingSubmission.exists) {
      return res.status(409).json({ error: `Attendance already submitted for ${resolvedClassName} on ${date}` });
    }

    // ── LEGACY write (attendance_records) — keeps existing UI working ──
    const batch = db.batch();
    const attendanceRef = db.collection('attendance_records');

    for (const record of records) {
      const docId = `${record.studentId}_${record.date}`;
      const docRef = attendanceRef.doc(docId);
      batch.set(docRef, {
        studentId: record.studentId,
        studentName: record.studentName,
        rollNumber: record.rollNumber || 0,
        classId: record.classId,
        className: record.className || '',
        schoolId: record.schoolId,
        date: record.date,
        month: record.month || (record.date ? record.date.substring(0, 7) : date.substring(0, 7)),
        status: record.status,
        markedBy,
        submittedAt,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    console.log(`[attendance_records] Legacy write complete: ${records.length} records for ${date}`);

    // ── NEW write 1: class_attendance — one doc per class per date ──
    try {
      const studentsMap = {};
      for (const record of records) {
        studentsMap[record.studentId] = record.status;
      }
      await db.collection('class_attendance').doc(classId).collection('dates').doc(date).set(
        {
          students: studentsMap,
          markedBy,
          teacherName: teacherName || markedBy,
          className: resolvedClassName,
          schoolId: records[0]?.schoolId || (req.schoolId || DEFAULT_SCHOOL_ID),
          submittedAt,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        }
      );
      console.log(`[class_attendance] Saved class ${classId} for date ${date} — ${records.length} students`);
    } catch (classAttErr) {
      console.error('[class_attendance] Write failed (non-blocking):', classAttErr.message);
    }

    // ── NEW write 2: student_attendance — one doc per student per date ──
    try {
      const studentAttBatch = db.batch();
      for (const record of records) {
        const studentAttRef = db.collection('student_attendance').doc(record.studentId).collection('dates').doc(record.date);
        studentAttBatch.set(studentAttRef, {
          status: record.status,
          classId: record.classId,
          className: record.className || '',
          schoolId: record.schoolId || (req.schoolId || DEFAULT_SCHOOL_ID),
          rollNumber: record.rollNumber || 0,
          studentName: record.studentName,
          recordedBy: markedBy,
          teacherName: teacherName || markedBy,
          month: record.month,
          submittedAt,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await studentAttBatch.commit();
      console.log(`[student_attendance] Saved ${records.length} student docs for date ${date}`);
    } catch (studentAttErr) {
      console.error('[student_attendance] Write failed (non-blocking):', studentAttErr.message);
    }

    const presentCount = records.filter(r => r.status === 'Present').length;
    const absentCount = records.filter(r => r.status === 'Absent').length;
    console.log(`Attendance saved: ${records.length} records | ${presentCount} present, ${absentCount} absent | Date: ${date}`);

    const submissionsRef = db.collection('attendance_submissions');
    await submissionsRef.doc(submissionDocId).set({
      classId,
      className: resolvedClassName,
      date,
      submittedBy: markedBy,
      teacherName: teacherName || markedBy,
      submittedAt,
      presentCount,
      absentCount,
      totalCount: records.length,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });

    try {
      const adminMsg = `${teacherName || markedBy} has submitted attendance for Grade ${resolvedClassName} on ${date}. Present: ${presentCount} | Absent: ${absentCount}`;
      await db.collection('admin_notifications').add({
        type: 'attendance_submitted',
        icon: '\u2705',
        title: 'Attendance Submitted',
        message: adminMsg,
        details: { teacherName: teacherName || markedBy, teacherId: markedBy, className: resolvedClassName, classId, date, presentCount, absentCount, totalCount: records.length },
        priority: 'normal',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: submittedAt,
      });
      sendPushToAdmins(req.schoolId || DEFAULT_SCHOOL_ID, '✅ Attendance Submitted', `${teacherName || markedBy} marked attendance for Grade ${resolvedClassName} on ${date}. Present: ${presentCount} | Absent: ${absentCount}`, { type: 'attendance_submitted', classId, date });
    } catch (notifErr) {
      console.error('Admin notification error:', notifErr.message);
    }

    const absentRecords = records.filter(r => r.status === 'Absent');
    if (absentRecords.length > 0) {
      try {
        await Promise.all(absentRecords.map(async r => {
          try {
            const studentDoc = await db.collection('students').doc(r.studentId).get();
            const parentPhone = studentDoc.exists ? studentDoc.data().parentPhone : null;
            await db.collection('parent_notifications').add({
              studentId: r.studentId,
              studentName: r.studentName,
              type: 'attendance_absent',
              title: 'Attendance Alert',
              message: `Dear Parent, your child ${r.studentName} (Roll #${r.rollNumber || '–'}) was marked Absent in Grade ${resolvedClassName} on ${date}. Please contact the school for details.`,
              className: resolvedClassName,
              classId,
              date,
              parentPhone: parentPhone || null,
              schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
              read: false,
              createdAt: submittedAt,
            });
            const parentId = studentDoc.exists ? (studentDoc.data().parentId || studentDoc.data().parent_uid || '') : '';
            if (parentId) sendPushNotification(parentId, '📋 Attendance Alert', `${r.studentName} was marked absent today`, { type: 'attendance', studentId: r.studentId });
            if (parentPhone) {
              sendAndLog(req.schoolId || DEFAULT_SCHOOL_ID, parentPhone, 'vl_attendance',
                ['Dear Parent', r.studentName, resolvedClassName, 'Absent', date, ''],
                { studentName: r.studentName, classId: resolvedClassName }
              ).catch(() => {});
            }
          } catch (e) {
            console.error('Parent notif error for', r.studentId, e.message);
          }
        }));
        console.log(`Parent notifications sent for ${absentRecords.length} absent students`);
      } catch (parentErr) {
        console.error('Parent notifications batch error:', parentErr.message);
      }
    }

    let sheetSync = { success: false };
    try {
      sheetSync = await syncAttendance(records, date);
    } catch (syncErr) {
      console.error('Google Sheets sync (attendance) failed:', syncErr.message);
    }

    res.status(200).json({
      success: true,
      message: `Attendance saved for ${records.length} students`,
      summary: { total: records.length, present: presentCount, absent: absentCount, date },
      sheetSync: sheetSync.success,
    });
  } catch (err) {
    console.error('Attendance save error:', err.code || '', err.message || err);
    res.status(500).json({ error: 'Attendance failed to save. Please check your connection.' });
  }
});

app.get('/api/attendance/submission-status', async (req, res) => {
  try {
    const { classId, date } = req.query;
    if (!classId || !date) return res.status(400).json({ error: 'classId and date required' });
    const submissionDocId = `${classId}_${date}`;
    const snap = await db.collection('attendance_submissions').doc(submissionDocId).get();
    if (!snap.exists) return res.json({ submitted: false });
    const data = snap.data();
    res.json({
      submitted: true,
      submittedBy: data.submittedBy || '',
      teacherName: data.teacherName || '',
      submittedAt: data.submittedAt || '',
      presentCount: data.presentCount || 0,
      absentCount: data.absentCount || 0,
      totalCount: data.totalCount || 0,
      lastEditedAt: data.lastEditedAt || null,
      lastEditedBy: data.lastEditedBy || null,
    });
  } catch (err) {
    console.error('Submission status error:', err.message);
    res.status(500).json({ error: 'Failed to check submission status' });
  }
});

app.post('/api/attendance/edit', async (req, res) => {
  try {
    const { studentId, studentName, rollNumber, classId, className, date, oldStatus, newStatus, reason, editedBy, teacherName } = req.body;
    if (!studentId || !classId || !date || !newStatus || !reason || !reason.trim()) {
      return res.status(400).json({ error: 'studentId, classId, date, newStatus, and reason are required' });
    }
    if (!['Present', 'Absent'].includes(newStatus)) {
      return res.status(400).json({ error: 'newStatus must be Present or Absent' });
    }
    if (!reason.trim()) {
      return res.status(400).json({ error: 'Reason cannot be empty' });
    }

    const editedAt = new Date().toISOString();

    // ── LEGACY update (attendance_records) — keeps existing UI working ──
    const docId = `${studentId}_${date}`;
    const attendanceRef = db.collection('attendance_records').doc(docId);
    await attendanceRef.set({
      studentId,
      studentName: studentName || '',
      rollNumber: rollNumber || 0,
      classId,
      className: className || '',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      date,
      month: date.substring(0, 7),
      status: newStatus,
      markedBy: editedBy || 'teacher',
      submittedAt: editedAt,
      lastEditedAt: editedAt,
      lastEditedBy: editedBy || 'teacher',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[attendance_records] Legacy edit: ${studentId} on ${date} → ${newStatus}`);

    // ── NEW update: class_attendance ──
    try {
      const classAttendanceRef = db.collection('class_attendance').doc(classId).collection('dates').doc(date);
      const classAttendanceSnap = await classAttendanceRef.get();
      const classAttendanceData = classAttendanceSnap.exists ? (classAttendanceSnap.data() || {}) : {};
      const existingStudents = classAttendanceData.students || {};
      const cleanupFieldName = `students.${studentId}`;
      await classAttendanceRef.update(
        new admin.firestore.FieldPath(cleanupFieldName),
        admin.firestore.FieldValue.delete()
      ).catch(() => null);
      await classAttendanceRef.update(
        new admin.firestore.FieldPath('students', String(studentId)),
        admin.firestore.FieldValue.delete()
      ).catch(() => null);
      await classAttendanceRef.set({
        students: {
          ...existingStudents,
          [studentId]: newStatus,
        },
        lastEditedAt: editedAt,
        lastEditedBy: teacherName || editedBy || 'teacher',
      }, { merge: true });
      console.log(`[class_attendance] Edit synced: class ${classId} date ${date} student ${studentId} → ${newStatus}`);
    } catch (classEditErr) {
      console.error('[class_attendance] Edit sync failed (non-blocking):', classEditErr.message);
    }

    // ── NEW update: student_attendance ──
    try {
      await db.collection('student_attendance').doc(studentId).collection('dates').doc(date).set(
        {
          status: newStatus,
          classId,
          className: className || '',
          schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
          rollNumber: rollNumber || 0,
          studentName: studentName || '',
          recordedBy: editedBy || 'teacher',
          teacherName: teacherName || editedBy || 'teacher',
          month: date.substring(0, 7),
          lastEditedAt: editedAt,
          lastEditedBy: editedBy || 'teacher',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`[student_attendance] Edit synced: student ${studentId} date ${date} → ${newStatus}`);
    } catch (studentEditErr) {
      console.error('[student_attendance] Edit sync failed (non-blocking):', studentEditErr.message);
    }

    await db.collection('attendance_edits').add({
      studentId,
      studentName: studentName || '',
      rollNumber: rollNumber || 0,
      classId,
      className: className || '',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      date,
      oldStatus: oldStatus || 'Unknown',
      newStatus,
      reason: reason.trim(),
      editedBy: editedBy || 'teacher',
      teacherName: teacherName || editedBy || 'Teacher',
      editedAt,
    });

    const allRecordsQ = db.collection('attendance_records').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId).where('date', '==', date);
    const allSnap = await allRecordsQ.get();
    const allRecs = allSnap.docs.map(d => d.data());
    const newPresentCount = allRecs.filter(r => r.status === 'Present').length;
    const newAbsentCount = allRecs.filter(r => r.status === 'Absent').length;
    const newTotalCount = allRecs.length;

    const submissionDocId = `${classId}_${date}`;
    await db.collection('attendance_submissions').doc(submissionDocId).set({
      presentCount: newPresentCount,
      absentCount: newAbsentCount,
      totalCount: newTotalCount,
      lastEditedAt: editedAt,
      lastEditedBy: teacherName || editedBy || 'Teacher',
    }, { merge: true });

    try {
      const editMsg = `${teacherName || editedBy} edited attendance for ${studentName} (Roll #${rollNumber || '\u2013'}) in Grade ${className} on ${date}. ${oldStatus} \u2192 ${newStatus}. Reason: ${reason.trim()}. Updated totals \u2014 Present: ${newPresentCount} | Absent: ${newAbsentCount} | Total: ${newTotalCount}.`;
      await db.collection('admin_notifications').add({
        type: 'attendance_edited',
        icon: '\u270F\uFE0F',
        title: 'Attendance Edited',
        message: editMsg,
        details: { teacherName: teacherName || editedBy, teacherId: editedBy, studentName, studentId, rollNumber, className, classId, date, oldStatus, newStatus, reason: reason.trim(), presentCount: newPresentCount, absentCount: newAbsentCount, totalCount: newTotalCount },
        priority: 'high',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: editedAt,
      });
      sendPushToAdmins(req.schoolId || DEFAULT_SCHOOL_ID, '✏️ Attendance Edit', `${teacherName || editedBy} changed ${studentName} from ${oldStatus} to ${newStatus} on ${date}. Reason: ${reason.trim()}`, { type: 'attendance_edited', studentId, classId, date });
    } catch (notifErr) {
      console.error('Admin edit notification error:', notifErr.message);
    }

    if (newStatus === 'Absent') {
      try {
        const studentDoc = await db.collection('students').doc(studentId).get();
        const parentId = studentDoc.exists ? (studentDoc.data().parentId || studentDoc.data().parent_uid || '') : '';
        if (parentId) {
          sendPushNotification(parentId, '📋 Attendance Updated', `${studentName} was marked Absent on ${date}. Reason: ${reason.trim()}`, { type: 'attendance_edit_absent', studentId, date });
        }
        await db.collection('parent_notifications').add({
          studentId,
          studentName: studentName || '',
          type: 'attendance_edit_absent',
          title: 'Attendance Updated',
          message: `Dear Parent, ${studentName}'s attendance was updated to Absent on ${date} in Grade ${className}. Reason: ${reason.trim()}`,
          className,
          classId,
          date,
          oldStatus,
          newStatus,
          reason: reason.trim(),
          schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
          read: false,
          createdAt: editedAt,
        });
      } catch (parentEditErr) {
        console.error('Parent edit notification error:', parentEditErr.message);
      }
    }

    let sheetSync = { success: false };
    try {
      const record = { studentId, studentName, classId, className, status: newStatus, markedBy: editedBy || 'teacher', date, month: date.substring(0, 7), schoolId: (req.schoolId || DEFAULT_SCHOOL_ID), rollNumber: rollNumber || 0 };
      sheetSync = await syncAttendance([record], date);
    } catch (syncErr) {
      console.error('Sheet re-sync on edit failed:', syncErr.message);
    }

    res.json({
      success: true,
      message: 'Attendance updated successfully.',
      sheetSync: sheetSync.success,
      newCounts: {
        presentCount: newPresentCount,
        absentCount: newAbsentCount,
        totalCount: newTotalCount,
        lastEditedAt: editedAt,
        lastEditedBy: teacherName || editedBy || 'Teacher',
      },
    });
  } catch (err) {
    console.error('Attendance edit error:', err.message);
    res.status(500).json({ error: 'Failed to update attendance.' });
  }
});

app.get('/api/admin/notifications', async (req, res) => {
  try {
    const { unreadOnly } = req.query;
    const notifsRef = db.collection('admin_notifications');
    let q;
    if (unreadOnly === 'true') {
      q = notifsRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('read', '==', false);
    } else {
      q = notifsRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID));
    }
    const snap = await q.get();
    let notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    // Sort in-memory to avoid index requirement
    notifications.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    if (unreadOnly === 'true') {
      return res.json({ count: notifications.length });
    }
    res.json({ notifications, unreadCount: notifications.filter(n => !n.read).length });
  } catch (err) {
    console.error('Admin notifications error:', err.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/admin/notifications/mark-read', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      const allQ = db.collection('admin_notifications').where('read', '==', false);
      const snap = await allQ.get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
      return res.json({ success: true, updated: snap.docs.length });
    }
    const batch = db.batch();
    ids.forEach(id => batch.update(db.collection('admin_notifications').doc(id), { read: true }));
    await batch.commit();
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    console.error('Mark notifications read error:', err.message);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// ── School-scoped notifications (marks submitted / edited) ───────────────────
app.get('/api/school-notifications', verifyAuth, async (req, res) => {
  try {
    const sid = req.schoolId || DEFAULT_SCHOOL_ID;
    const { unreadOnly } = req.query;
    const colRef = db.collection('schools').doc(sid).collection('notifications');

    if (unreadOnly === 'true') {
      const snap = await colRef.where('read', '==', false).get();
      return res.json({ count: snap.size });
    }

    const snap = await colRef.orderBy('createdAt', 'desc').limit(50).get();
    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unreadCount   = notifications.filter(n => !n.read).length;
    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('[school-notifications GET]', err.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/school-notifications/mark-read', verifyAuth, async (req, res) => {
  try {
    const sid    = req.schoolId || DEFAULT_SCHOOL_ID;
    const { ids } = req.body;
    const colRef = db.collection('schools').doc(sid).collection('notifications');

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      const snap  = await colRef.where('read', '==', false).get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
      return res.json({ success: true, updated: snap.size });
    }

    const batch = db.batch();
    ids.forEach(id => batch.update(colRef.doc(id), { read: true }));
    await batch.commit();
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    console.error('[school-notifications mark-read]', err.message);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

app.get('/api/attendance/records', async (req, res) => {
  try {
    const { classId, date } = req.query;
    if (!classId || !date) return res.status(400).json({ error: 'classId and date required' });
    const q = db.collection('attendance_records').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId).where('date', '==', date);
    const snap = await q.get();
    const records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ records });
  } catch (err) {
    console.error('Attendance records error:', err.message);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

app.get('/api/attendance/class-summary', async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const classesRef = db.collection('classes');
    const classQ = classesRef.where('schoolId', '==', schoolId);
    const classSnap = await classQ.get();
    const classes = classSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const today = new Date().toISOString().split('T')[0];
    const attendanceRef = db.collection('attendance_records');
    const result = [];
    for (const cls of classes) {
      const attQ = attendanceRef.where('schoolId', '==', schoolId).where('classId', '==', cls.id).where('date', '==', today);
      const attSnap = await attQ.get();
      const records = attSnap.docs.map(d => d.data());
      const total = records.length;
      const present = records.filter(r => r.status === 'Present').length;
      const pct = total > 0 ? Math.round((present / total) * 100) : 0;
      result.push({ cls: cls.name || cls.id, pct, present, total });
    }
    res.json({ success: true, classes: result });
  } catch (err) {
    console.error('Attendance class summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

app.get('/api/attendance/class-stats', async (req, res) => {
  try {
    const { date, classIds } = req.query;
    if (!date || !classIds) return res.status(400).json({ error: 'date and classIds required' });
    const ids = classIds.split(',').map(s => s.trim()).filter(Boolean);
    const attendanceRef = db.collection('attendance_records');
    const stats = {};
    await Promise.all(ids.map(async classId => {
      const q = attendanceRef.where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('classId', '==', classId).where('date', '==', date);
      const snap = await q.get();
      const records = snap.docs.map(d => d.data());
      const present = records.filter(r => r.status === 'Present').length;
      const total = records.length;
      stats[classId] = { present, absent: total - present, total, submitted: total > 0 };
    }));
    res.json({ stats });
  } catch (err) {
    console.error('Class stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


app.post('/api/leave-request/submit', async (req, res) => {
  try {
    const { staffId, staffName, role, dept, reasonId, reasonLabel, reasonIcon, customReason, dates, leaveType, fromDate, toDate } = req.body;
    if (!staffId || !staffName || !reasonId) {
      return res.status(400).json({ error: 'staffId, staffName, reasonId are required' });
    }
    const sorted = dates && dates.length > 0 ? [...dates].sort() : (fromDate ? [fromDate] : []);
    if (sorted.length === 0 && !fromDate) return res.status(400).json({ error: 'dates or fromDate required' });
    const effectiveFrom = sorted[0] || fromDate;
    const effectiveTo = sorted[sorted.length - 1] || toDate || fromDate;
    const effectiveDays = sorted.length || Math.max(1, Math.ceil((new Date(effectiveTo) - new Date(effectiveFrom)) / 86400000) + 1);
    const newReq = {
      staffId, staffName,
      role: role || 'teacher',
      dept: dept || '',
      reasonId,
      reasonLabel: reasonLabel || reasonId,
      icon: reasonIcon || '📅',
      customReason: customReason || '',
      dates: sorted,
      from: effectiveFrom,
      to: effectiveTo,
      days: effectiveDays,
      leaveType: leaveType || 'casual',
      status: 'Pending',
      type: 'staff',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      submittedAt: new Date().toISOString(),
    };
    const ref = await db.collection('leave_requests').add(newReq);
    
    // Admin notification — staff leave submitted
    try {
      const roleLabel = role === 'driver' ? 'Driver' : role === 'cleaner' ? 'Cleaner' : 'Staff';
      await db.collection('admin_notifications').add({
        type: 'staff_leave_submitted',
        icon: '📋',
        title: `${roleLabel} Leave Request`,
        message: `${staffName || 'A staff member'} (${roleLabel}) has applied for leave from ${effectiveFrom} to ${effectiveTo}. Reason: ${customReason || reasonLabel || 'Not specified'}.`,
        details: {
          staffId: staffId || '',
          staffName: staffName || '',
          role: role || '',
          fromDate: effectiveFrom,
          toDate: effectiveTo,
          days: effectiveDays,
          reason: customReason || reasonLabel || '',
          leaveType: leaveType || ''
        },
        priority: 'normal',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: new Date().toISOString()
      });
      console.log('[Leave Submit] Admin notification sent for staff leave:', staffId);
    } catch (notifErr) {
      console.error('Admin staff leave notification error:', notifErr.message);
    }
    
    res.json({ success: true, id: ref.id });
    safeSync('syncLeaveRequest', () => syncLeaveRequest({ leaveId: ref.id, type: 'staff', applicantId: staffId, applicantName: staffName, class: dept || '', leaveType: leaveType || 'casual', fromDate: effectiveFrom, toDate: effectiveTo, reason: customReason || '', status: 'Pending', submittedAt: newReq.submittedAt }), { leaveId: ref.id }).catch(() => {});
  } catch (err) {
    console.error('Leave request submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leave-requests/mine', async (req, res) => {
  try {
    const { staffId } = req.query;
    if (!staffId) return res.status(400).json({ error: 'staffId required' });
    const q = db.collection('leave_requests').where('staffId', '==', staffId);
    const snap = await q.get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    requests.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
    res.json({ requests });
  } catch (err) {
    console.error('Fetch my leave requests error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leave-requests', async (req, res) => {
  try {
    const snap = await db.collection('leave_requests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    let requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    requests.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));

    const needsName = requests.filter(r => !r.staffName || r.staffName === 'Unknown');
    if (needsName.length > 0) {
      await Promise.all(needsName.map(async r => {
        if (!r.staffId) return;
        try {
          const q1 = db.collection('users').where('role_id', '==', r.staffId);
          const s1 = await q1.get();
          if (!s1.empty) {
            r.staffName = s1.docs[0].data().full_name || s1.docs[0].data().name || r.staffId;
            return;
          }
          const q2 = db.collection('onboarded_users').where('role_id', '==', r.staffId);
          const s2 = await q2.get();
          if (!s2.empty) {
            r.staffName = s2.docs[0].data().full_name || s2.docs[0].data().name || r.staffId;
          }
        } catch (e) {
          console.error('staffName lookup error for', r.staffId, e.message);
        }
      }));
    }

    res.json({ requests });
  } catch (err) {
    console.error('Fetch leave requests error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leave-request/update-status', async (req, res) => {
  try {
    const { requestId, status, adminName, adminId, actorRole, rejectReason } = req.body;
    if (!requestId || !status) return res.status(400).json({ error: 'requestId and status required' });
    if (!['Approved', 'Rejected', 'Pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const resolvedAdmin = adminName || 'Admin';
    const resolvedActorRole = actorRole || 'Admin';
    const approvedAt = new Date().toISOString();

    let leaveDocRef = db.collection('leaveRequests').doc(requestId);
    let leaveSnap = await leaveDocRef.get();
    if (!leaveSnap.exists) {
      leaveDocRef = db.collection('leave_requests').doc(requestId);
      leaveSnap = await leaveDocRef.get();
    }
    if (!leaveSnap.exists) return res.status(404).json({ error: 'Leave request not found' });
    const leaveData = leaveSnap.data();

    const updatePayload = { status, updatedAt: approvedAt, approvedBy: resolvedAdmin, approvedByRole: resolvedActorRole, approvedAt };
    if (rejectReason) updatePayload.rejectReason = rejectReason;
    await leaveDocRef.update(updatePayload);

    const isStudentLeave = leaveData.type === 'student';

    if (isStudentLeave) {
      if (status === 'Approved') {
        try {
          let dates = leaveData.dates && leaveData.dates.length > 0 ? [...leaveData.dates] : [];
          if (dates.length === 0 && leaveData.from) {
            const fromD = new Date(leaveData.from);
            const toD = new Date(leaveData.to || leaveData.from);
            for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate() + 1)) {
              dates.push(d.toISOString().slice(0, 10));
            }
          }
          const schoolId = leaveData.schoolId || (req.schoolId || DEFAULT_SCHOOL_ID);
          const attBatch = db.batch();
          for (const dateStr of dates) {
            const docId = `${leaveData.studentId}_${dateStr}`;
            attBatch.set(db.collection('attendance_records').doc(docId), {
              studentId: leaveData.studentId,
              studentName: leaveData.studentName || '',
              rollNumber: leaveData.rollNumber || 0,
              classId: leaveData.studentClass || '',
              className: leaveData.studentClass || '',
              schoolId,
              date: dateStr,
              month: dateStr.slice(0, 7),
              status: 'Leave',
              leaveId: requestId,
              markedBy: resolvedAdmin,
              submittedAt: approvedAt,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          await attBatch.commit();
          console.log(`Student leave attendance marked for ${leaveData.studentName}: ${dates.join(', ')}`);
        } catch (attErr) {
          console.error('Student leave attendance mark error:', attErr.message);
        }
      }

      if (status === 'Approved' || status === 'Rejected') {
        try {
          const icon = status === 'Approved' ? '✅' : '❌';
          const studentName = leaveData.studentName || 'your child';
          const fromDate = leaveData.from || '';
          const toDate = leaveData.to || leaveData.from || '';
          const leaveType = leaveData.reasonLabel || 'Leave';
          const message = status === 'Approved'
            ? `Your child ${studentName}'s leave request (${leaveType}) from ${fromDate} to ${toDate} has been Approved by ${resolvedAdmin} (${resolvedActorRole}).`
            : `Your child ${studentName}'s leave request has been Rejected by ${resolvedAdmin}.${rejectReason ? ' Reason: ' + rejectReason : ''}`;
          await db.collection('parent_notifications').add({
            studentId: leaveData.studentId || '',
            parentId: leaveData.parentId || '',
            type: 'student_leave_status',
            icon,
            title: status === 'Approved' ? 'Student Leave Approved' : 'Student Leave Rejected',
            message,
            leaveId: requestId,
            status,
            approvedBy: resolvedAdmin,
            approvedByRole: resolvedActorRole,
            schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
            read: false,
            createdAt: approvedAt,
          });
          if (leaveData.parentId) sendPushNotification(leaveData.parentId, status === 'Approved' ? '✅ Leave Approved' : '❌ Leave Rejected', status === 'Approved' ? `${leaveData.studentName || 'Your child'}'s leave request has been approved` : `${leaveData.studentName || 'Your child'}'s leave request was not approved`, { type: 'leave_status', status });
        } catch (notifErr) {
          console.error('Parent leave notification error:', notifErr.message);
        }
      }
    } else {
      if (status === 'Approved' && leaveData.staffId && leaveData.days > 0) {
        try {
          const balRef = db.collection('leave_balance').doc(leaveData.staffId);
          const balSnap = await balRef.get();
          const bal = balSnap.exists ? balSnap.data() : { casual: 12, sick: 12, earned: 6 };
          const lt = (leaveData.leaveType || 'casual').toLowerCase();
          const field = lt === 'sick' ? 'sick' : lt === 'earned' ? 'earned' : 'casual';
          const current = bal[field] || 0;
          const deduct = Math.min(current, leaveData.days);
          await balRef.set({ ...bal, [field]: Math.max(0, current - deduct), updatedAt: new Date().toISOString() });
        } catch (balErr) {
          console.error('Leave balance deduct error:', balErr.message);
        }
      }

      if ((status === 'Approved' || status === 'Rejected') && leaveData.staffId) {
        try {
          const icon = status === 'Approved' ? '✅' : '❌';
          const title = status === 'Approved' ? 'Leave Approved' : 'Leave Rejected';
          const fromDate = leaveData.from || '';
          const toDate = leaveData.to || leaveData.from || '';
          const leaveType = leaveData.reasonLabel || leaveData.reasonId || 'Leave';
          const message = `Your leave request for ${leaveType} from ${fromDate} to ${toDate} has been ${status} by ${resolvedAdmin}.`;
          await db.collection('teacher_notifications').add({
            roleId: leaveData.staffId,
            type: 'leave_status',
            icon,
            title,
            message,
            leaveId: requestId,
            leaveType,
            status,
            from: fromDate,
            to: toDate,
            approvedBy: resolvedAdmin,
            schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
            read: false,
            createdAt: approvedAt,
          });
          sendPushNotification(leaveData.staffId, status === 'Approved' ? '✅ Leave Approved' : '❌ Leave Rejected', `Your leave request has been ${status} by ${resolvedAdmin}`, { type: 'leave_status', status });
          console.log(`Teacher notification sent to ${leaveData.staffId}: Leave ${status}`);
        } catch (notifErr) {
          console.error('Teacher leave notification error:', notifErr.message);
        }
      }
    }

    res.json({ success: true });
    safeSync('syncLeaveRequest', () => syncLeaveRequest({ leaveId: requestId, type: leaveData.type || 'student', applicantId: leaveData.studentId || leaveData.staffId || '', applicantName: leaveData.studentName || leaveData.employeeName || '', class: leaveData.studentClass || '', leaveType: leaveData.reasonLabel || '', fromDate: leaveData.from || '', toDate: leaveData.to || '', reason: leaveData.customReason || '', status, actionedBy: resolvedAdmin, actionedAt: approvedAt, submittedAt: leaveData.submittedAt || '' }), { leaveId: requestId }).catch(() => {});
  } catch (err) {
    console.error('Update leave status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function normalizeClassName(name) {
  return name?.toLowerCase().replace(/\s+/g, '').replace('grade', '').trim() || '';
}

app.post('/api/leave-request/student/submit', async (req, res) => {
  try {
    const { studentId, studentName, rollNumber, studentClass, schoolId, parentId, parentName, reasonId, reasonLabel, reasonIcon, customReason, dates, from, to } = req.body;
    if (!studentId || !studentName || !studentClass || !from) {
      return res.status(400).json({ error: 'studentId, studentName, studentClass, from are required' });
    }

    console.log('STEP 1 - Student data:', { studentId, studentClass, studentName });

    const effectiveDates = dates && dates.length > 0 ? [...dates].sort() : [];
    const effectiveFrom = effectiveDates.length > 0 ? effectiveDates[0] : from;
    const effectiveTo = effectiveDates.length > 0 ? effectiveDates[effectiveDates.length - 1] : (to || from);
    const days = Math.max(1, Math.ceil((new Date(effectiveTo) - new Date(effectiveFrom)) / 86400000) + 1);
    let allDates = effectiveDates;
    if (allDates.length === 0) {
      const fD = new Date(effectiveFrom);
      const tD = new Date(effectiveTo);
      for (let d = new Date(fD); d <= tD; d.setDate(d.getDate() + 1)) {
        allDates.push(d.toISOString().slice(0, 10));
      }
    }

    const studentClassNormalized = normalizeClassName(studentClass);
    console.log('STEP 2 - Querying teacher where classTeacherOf =', studentClass);

    let assignedTeacherId = '';
    let assignedTeacherName = '';
    let assignedTeacherUid = '';
    let noClassTeacherAssigned = false;
    try {
      const teacherSnap = await db.collection('users').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('role', '==', 'teacher').get();
      for (const teacherDoc of teacherSnap.docs) {
        const td = teacherDoc.data();
        const teacherNorm = normalizeClassName(td.classTeacherOf || '');
        if (teacherNorm && teacherNorm === studentClassNormalized) {
          assignedTeacherId = td.role_id || '';
          assignedTeacherUid = td.uid || '';
          assignedTeacherName = td.full_name || '';
          break;
        }
      }
      console.log('STEP 3 - Teacher found:', { teacherId: assignedTeacherId, teacherName: assignedTeacherName });
      if (!assignedTeacherId) {
        noClassTeacherAssigned = true;
        console.warn(`[Leave Submit] No class teacher assigned for "${studentClass}" (normalized: "${studentClassNormalized}") — routed to Admin only`);
      }
    } catch (ctErr) {
      console.error('[Leave Submit] Class teacher lookup failed:', ctErr.message);
      noClassTeacherAssigned = true;
    }

    const newReq = {
      type: 'student',
      studentId,
      studentName,
      rollNumber: rollNumber || 0,
      studentClass,
      studentClassNormalized,
      schoolId: schoolId || (req.schoolId || DEFAULT_SCHOOL_ID),
      parentId: parentId || '',
      parentName: parentName || '',
      reasonId: reasonId || 'other',
      reasonLabel: reasonLabel || reasonId || 'Leave',
      leaveType: reasonLabel || reasonId || 'Leave',
      icon: reasonIcon || '📅',
      customReason: customReason || '',
      dates: allDates,
      from: effectiveFrom,
      to: effectiveTo,
      days,
      status: 'Pending',
      visibleToAdmin: true,
      assignedTeacherId,
      assignedTeacherUid,
      assignedTeacherName,
      noClassTeacherAssigned,
      submittedAt: new Date().toISOString(),
    };
    console.log('STEP 4 - Saving leave request with:', newReq);
    const ref = await db.collection('leaveRequests').add(newReq);
    
    // Admin notification — student leave submitted
    try {
      await db.collection('admin_notifications').add({
        type: 'leave_submitted',
        icon: '📋',
        title: 'Leave Request Submitted',
        message: `Leave request submitted for ${studentName || 'a student'} (Class ${studentClass || ''}) from ${effectiveFrom} to ${effectiveTo}. Reason: ${customReason || 'Not specified'}.`,
        details: {
          studentId,
          studentName: studentName || '',
          studentClass: studentClass || '',
          startDate: effectiveFrom,
          endDate: effectiveTo,
          reason: customReason || '',
          assignedTeacherId: assignedTeacherId || ''
        },
        priority: 'normal',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: new Date().toISOString()
      });
      console.log('[Leave Submit] Admin notification sent for student leave:', studentId);
    } catch (notifErr) {
      console.error('Admin leave notification error:', notifErr.message);
    }
    
    const result = { success: true, id: ref.id, assignedTeacherName: assignedTeacherName || null, noClassTeacherAssigned };
    console.log('STEP 5 - Save result:', result);
    res.json(result);
    safeSync('syncLeaveRequest', () => syncLeaveRequest({ leaveId: ref.id, type: 'student', applicantId: studentId, applicantName: studentName, class: studentClass, leaveType: reasonLabel || reasonId || '', fromDate: effectiveFrom, toDate: effectiveTo, reason: customReason || '', status: 'Pending', submittedAt: newReq.submittedAt }), { leaveId: ref.id }).catch(() => {});
  } catch (err) {
    console.error('[Leave Submit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leave-requests/students', async (req, res) => {
  try {
    const { studentId } = req.query;
    const seen = new Set();
    let requests = [];

    const fetchFrom = async (colName, extraWhere) => {
      try {
        let q;
        if (studentId) {
          q = db.collection(colName).where('type', '==', 'student').where('studentId', '==', studentId);
        } else {
          q = db.collection(colName).where('type', '==', 'student');
        }
        const snap = await q.get();
        for (const d of snap.docs) {
          if (!seen.has(d.id)) { seen.add(d.id); requests.push({ id: d.id, ...d.data() }); }
        }
      } catch (e) { }
    };

    await Promise.all([fetchFrom('leaveRequests'), fetchFrom('leave_requests')]);
    requests.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
    res.json({ requests });
  } catch (err) {
    console.error('Fetch student leave requests error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leave-requests/student-class', async (req, res) => {
  try {
    const { teacherRoleId } = req.query;
    if (!teacherRoleId) return res.status(400).json({ error: 'teacherRoleId required' });

    const userQ = db.collection('users').where('role_id', '==', teacherRoleId);
    const userSnap = await userQ.get();
    if (userSnap.empty) return res.status(404).json({ error: 'Teacher not found' });
    const teacherData = userSnap.docs[0].data();
    const classTeacherOf = teacherData.classTeacherOf || null;
    const teacherUid = teacherData.uid || '';

    console.log('TEACHER classTeacherOf value:', classTeacherOf);

    if (!classTeacherOf) {
      return res.json({ requests: [], classTeacherOf: null, notClassTeacher: true });
    }

    const normalizedTeacherClass = normalizeClassName(classTeacherOf);

    const queryDetails = {
      q1: `leaveRequests where studentClass == "${classTeacherOf}"`,
      q2: `leaveRequests where studentClassNormalized == "${normalizedTeacherClass}"`,
      q3: `leaveRequests where assignedTeacherId == "${teacherRoleId}"`,
    };
    console.log('QUERY used:', queryDetails);

    const [snap1, snap2, snap3, snapOld] = await Promise.all([
      db.collection('leaveRequests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID).get().where('studentClass', '==', classTeacherOf)),
      db.collection('leaveRequests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID).get().where('studentClassNormalized', '==', normalizedTeacherClass)),
      db.collection('leaveRequests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID).get().where('assignedTeacherId', '==', teacherRoleId)),
      db.collection('leave_requests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('type', '==', 'student').get(),
    ]);

    const seen = new Set();
    const allResults = [];

    const addDocs = (snap) => {
      for (const d of snap.docs) {
        if (!seen.has(d.id)) { seen.add(d.id); allResults.push({ id: d.id, ...d.data() }); }
      }
    };

    addDocs(snap1);
    addDocs(snap2);
    addDocs(snap3);

    for (const d of snapOld.docs) {
      if (seen.has(d.id)) continue;
      const data = d.data();
      const rawClass = data.studentClass || '';
      const normLeave = data.normalizedStudentClass || data.studentClassNormalized || normalizeClassName(rawClass);
      const matchByClass = normalizedTeacherClass && normLeave === normalizedTeacherClass;
      const matchByTeacherId = data.assignedTeacherId && data.assignedTeacherId === teacherRoleId;
      const matchByUid = teacherUid && data.assignedTeacherUid === teacherUid;
      if (matchByClass || matchByTeacherId || matchByUid) {
        seen.add(d.id);
        allResults.push({ id: d.id, ...data });
      }
    }

    console.log('RAW results:', allResults.map(r => ({ id: r.id, studentClass: r.studentClass, status: r.status, studentName: r.studentName })));

    allResults.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
    console.log(`[Teacher Leave Query] Returning ${allResults.length} requests for ${teacherRoleId}`);
    res.json({ requests: allResults, classTeacherOf, notClassTeacher: false });
  } catch (err) {
    console.error('[Teacher Leave Query] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leave-requests/backfill-teacher', async (req, res) => {
  try {
    const [snap1, snap2] = await Promise.all([
      db.collection('leaveRequests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID).get()),
      db.collection('leave_requests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('type', '==', 'student').get(),
    ]);
    const allLeaveDocs = [...snap1.docs, ...snap2.docs];
    const teacherSnap = await db.collection('users').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('role', '==', 'teacher').get();
    const teacherMap = {};
    for (const td of teacherSnap.docs) {
      const d = td.data();
      if (d.classTeacherOf) {
        teacherMap[normalizeClassName(d.classTeacherOf)] = { role_id: d.role_id || '', full_name: d.full_name || '', uid: d.uid || '' };
      }
    }
    let updated = 0;
    for (const ld of allLeaveDocs) {
      const data = ld.data();
      if (data.assignedTeacherId) continue;
      const norm = normalizeClassName(data.studentClass || '');
      const teacher = teacherMap[norm];
      const colName = snap1.docs.find(d => d.id === ld.id) ? 'leaveRequests' : 'leave_requests';
      if (teacher) {
        await db.collection(colName).doc(ld.id).update({
          studentClassNormalized: norm,
          assignedTeacherId: teacher.role_id,
          assignedTeacherUid: teacher.uid,
          assignedTeacherName: teacher.full_name,
          noClassTeacherAssigned: false,
        });
        updated++;
        console.log(`[Backfill] Updated ${ld.id}: assigned to ${teacher.full_name}`);
      } else {
        await db.collection(colName).doc(ld.id).update({
          studentClassNormalized: norm,
          noClassTeacherAssigned: true,
        });
      }
    }
    res.json({ success: true, updated, total: allLeaveDocs.length });
  } catch (err) {
    console.error('[Backfill] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/forgot-password', loginLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const usersRef = db.collection('users');
    const q = usersRef.where('email', '==', email.trim().toLowerCase());
    const snap = await q.get();
    if (snap.empty) {
      const logQ = db.collection('logistics_staff').where('email', '==', email.trim().toLowerCase());
      const logSnap = await logQ.get();
      if (logSnap.empty) {
        return res.status(404).json({ error: 'This email is not registered with our school.' });
      }
    }
    const apiKey = process.env.FIREBASE_API_KEY;
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: email.trim().toLowerCase() }),
    });
    res.json({ success: true, message: 'Password reset link sent! Please check your inbox.' });
  } catch (err) {
    console.error('Forgot password error:', err.code, err.message);
    if (err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'This email is not registered with our school.' });
    }
    if (err.code === 'auth/invalid-email') {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (err.code === 'auth/too-many-requests') {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
});

app.post('/api/change-password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword, uid } = req.body;

    if (!email || !currentPassword || !newPassword || !uid) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const usersRef = db.collection('users');
    const q = usersRef.where('email', '==', email).where('uid', '==', uid);
    const snapshot = await q.get();
    if (snapshot.empty) {
      return res.status(403).json({ error: 'User verification failed' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    const userCredential = await firebaseSignIn(email, currentPassword);
    const user = userCredential.user;

    await adminAuth.updateUser(user.uid, { password: newPassword });

    console.log(`Password changed successfully for: ${email}`);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err.code, err.message);
    if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (err.code === 'auth/too-many-requests') {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    if (err.code === 'auth/weak-password') {
      return res.status(400).json({ error: 'Password is too weak. Use at least 6 characters.' });
    }
    res.status(500).json({ error: 'Failed to change password. Please try again.' });
  }
});

app.post('/api/admin/update-profile', verifyAuth, async (req, res) => {
  try {
    const uid = req.userId || req.body.uid;
    const { mobile, bloodGroup } = req.body;
    if (!uid) return res.status(400).json({ error: 'User ID is required' });

    const usersRef = db.collection('users');
    const q = usersRef.where('uid', '==', uid);
    const snapshot = await q.get();
    if (snapshot.empty) return res.status(404).json({ error: 'User not found' });

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();
    if (userData.role !== 'principal') return res.status(403).json({ error: 'Only the principal can update admin profile' });

    const updates = {};
    if (mobile) updates.mobile = mobile;
    if (bloodGroup) updates.blood_group = bloodGroup;
    updates.profile_updated_at = new Date().toISOString();

    await db.collection('users').doc(userDoc.id).update(updates);
    console.log(`Admin profile updated: ${uid}`);

    try {
      const { updateAdminProfileInSheets } = require('./src/services/googleSheets');
      await updateAdminProfileInSheets({
        roleId: userData.role_id || 'ADMIN',
        fullName: userData.full_name,
        email: userData.email,
        mobile: mobile || userData.mobile || '',
        bloodGroup: bloodGroup || userData.blood_group || '',
        profileImage: userData.profileImage || '',
      });
    } catch (syncErr) {
      console.error('Sheets sync error (admin profile):', syncErr.message);
    }

    res.json({ success: true, updates });
  } catch (err) {
    console.error('Admin profile update error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.post('/api/admin/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid || !req.file) return res.status(400).json({ error: 'User ID and photo are required' });

    const usersRef = db.collection('users');
    const q = usersRef.where('uid', '==', uid);
    const snapshot = await q.get();
    if (snapshot.empty) return res.status(404).json({ error: 'User not found' });

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();
    if (userData.role !== 'principal') return res.status(403).json({ error: 'Access denied' });

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `profile_photos/${uid}_${Date.now()}.${ext}`;
    const storageRef = ref(storage, fileName);

    await uploadBytes(storageRef, req.file.buffer, { contentType: req.file.mimetype });
    const downloadURL = await getDownloadURL(storageRef);

    await db.collection('users').doc(userDoc.id).update({
      profileImage: downloadURL,
      profile_updated_at: new Date().toISOString(),
    });

    console.log(`Admin photo uploaded: ${uid} -> ${downloadURL}`);

    try {
      const { updateAdminProfileInSheets } = require('./src/services/googleSheets');
      await updateAdminProfileInSheets({
        roleId: userData.role_id || 'ADMIN',
        fullName: userData.full_name,
        email: userData.email,
        mobile: userData.mobile || '',
        bloodGroup: userData.blood_group || '',
        profileImage: downloadURL,
      });
    } catch (syncErr) {
      console.error('Sheets sync error (admin photo):', syncErr.message);
    }

    res.json({ success: true, profileImage: downloadURL });
  } catch (err) {
    console.error('Admin photo upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

app.post('/api/bus/start-trip', async (req, res) => {
  try {
    const { driverId, driverName, busNumber, route, tripType, lat, lng } = req.body;
    if (!driverId || !busNumber) return res.status(400).json({ error: 'driverId and busNumber required' });

    const tripDoc = {
      driverId,
      driverName: driverName || '',
      busNumber,
      route: route || '',
      tripType: tripType || 'school',
      status: 'active',
      startTime: new Date().toISOString(),
      endTime: null,
      lat: lat || null,
      lng: lng || null,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
    };
    const tripRef = await db.collection('bus_trips').add(tripDoc);

    await db.collection('live_bus_locations').add({
      tripId: tripRef.id,
      driverId,
      busNumber,
      route: route || '',
      lat: lat || 0,
      lng: lng || 0,
      speed: 0,
      status: 'active',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      updatedAt: new Date().toISOString(),
    });

    await db.collection('parent_notifications').add({
      busNumber,
      message: `Bus ${busNumber} has started from school. You can now track its live location in the app.`,
      type: 'bus_departure',
      tripId: tripRef.id,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });

    await db.collection('parent_notifications').add({
      type: 'admin_alert',
      message: `Driver ${driverName || driverId} has started the ${tripType || 'school'} route for Bus ${busNumber}.`,
      tripId: tripRef.id,
      forAdmin: true,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Trip started: ${driverName} - Bus ${busNumber}`);
    res.json({ success: true, tripId: tripRef.id });
  } catch (err) {
    console.error('Start trip error:', err.message);
    res.status(500).json({ error: 'Failed to start trip' });
  }
});

const proximityNotified = {};

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function checkProximityAlerts(busNumber, route, lat, lng) {
  try {
    if (!route || !lat || !lng) return;
    const stopsQ = db.collection('student_stops').where('route', '==', route);
    const stopsSnap = await stopsQ.get();
    if (stopsSnap.empty) return;

    const now = new Date();
    const tripKey = `${busNumber}_${now.toISOString().slice(0, 10)}`;

    for (const stopDoc of stopsSnap.docs) {
      const stop = stopDoc.data();
      if (!stop.lat || !stop.lng || !stop.studentId) continue;

      const dist = haversineDistance(lat, lng, stop.lat, stop.lng);
      const alertKey = `${tripKey}_${stop.studentId}`;

      if (dist <= 500 && !proximityNotified[alertKey]) {
        proximityNotified[alertKey] = true;
        const studentId = `student-${stop.studentId}`;
        const alertMsg = `🚌 Your child's school bus is arriving in approximately 2–3 minutes. Please be ready at the stop.`;
        await db.collection('parent_notifications').add({
          studentId,
          studentName: stop.studentName || '',
          message: alertMsg,
          type: 'proximity_alert',
          busNumber,
          route,
          distance: Math.round(dist),
          schoolId: DEFAULT_SCHOOL_ID,
          read: false,
          createdAt: now.toISOString(),
        });
        await db.collection('proximity_alert_logs').add({
          studentId: String(stop.studentId),
          studentName: stop.studentName || '',
          busNumber,
          route,
          driverLat: lat,
          driverLng: lng,
          studentLat: stop.lat,
          studentLng: stop.lng,
          distanceAtAlert: Math.round(dist),
          message: alertMsg,
          schoolId: DEFAULT_SCHOOL_ID,
          sentAt: now.toISOString(),
          tripDate: now.toISOString().slice(0, 10),
        });
        console.log(`Proximity alert: Bus ${busNumber} is ${Math.round(dist)}m from ${stop.studentName}'s stop`);
        try {
          const stuSnap = await adminDb.collection('students').where('studentId', '==', String(stop.studentId)).limit(1).get();
          if (!stuSnap.empty) {
            const parentId = stuSnap.docs[0].data().parentId || stuSnap.docs[0].data().parent_uid || '';
            if (parentId) sendPushNotification(parentId, '🚌 Bus Approaching!', `Bus is approaching your stop — get ready!`, { type: 'proximity_alert', busNumber });
          }
        } catch (pushErr) { console.error('Proximity push error:', pushErr.message); }
      }
    }
  } catch (err) {
    console.error('Proximity alert error:', err.message);
  }
}

app.post('/api/bus/update-location', async (req, res) => {
  try {
    const { busNumber, lat, lng, speed } = req.body;
    if (!busNumber) return res.status(400).json({ error: 'busNumber required' });

    const q = db.collection('live_bus_locations').where('busNumber', '==', busNumber).where('status', '==', 'active');
    const snap = await q.get();
    if (snap.empty) return res.status(404).json({ error: 'No active trip for this bus' });

    let tripRoute = null;
    for (const d of snap.docs) {
      const data = d.data();
      tripRoute = data.route || null;
      await db.collection('live_bus_locations').doc(d.id).update({
        lat: lat || 0,
        lng: lng || 0,
        speed: speed || 0,
        updatedAt: new Date().toISOString(),
      });
    }

    if (lat && lng && tripRoute) {
      checkProximityAlerts(busNumber, tripRoute, lat, lng);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update location error:', err.message);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

app.post('/api/bus/end-trip', async (req, res) => {
  try {
    const { tripId, driverId, driverName, busNumber, route, totalDistance, studentsBoarded } = req.body;
    if (!tripId) return res.status(400).json({ error: 'tripId required' });

    const tripSnap = await db.collection('bus_trips').doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: 'Trip not found' });
    const tripData = tripSnap.data();

    const endTime = new Date().toISOString();
    const startMs = new Date(tripData.startTime).getTime();
    const endMs = new Date(endTime).getTime();
    const durationMin = Math.round((endMs - startMs) / 60000);
    const finalBusNumber = busNumber || tripData.busNumber;
    const finalDriverId = driverId || tripData.driverId;
    const finalDriverName = driverName || tripData.driverName;

    await db.collection('bus_trips').doc(tripId).update({ status: 'completed', endTime, totalDistance: totalDistance || 0, studentsBoarded: studentsBoarded || 0 });

    const locQ = db.collection('live_bus_locations').where('busNumber', '==', finalBusNumber).where('status', '==', 'active');
    const locSnap = await locQ.get();
    for (const d of locSnap.docs) {
      await db.collection('live_bus_locations').doc(d.id).update({ status: 'inactive', updatedAt: endTime });
    }

    await db.collection('parent_notifications').add({
      busNumber: finalBusNumber,
      message: `Bus ${finalBusNumber} has successfully completed the route.`,
      type: 'bus_arrival',
      tripId,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: endTime,
    });

    const startUTC = new Date(tripData.startTime);
    const istMinutes = startUTC.getUTCHours() * 60 + startUTC.getUTCMinutes() + 330;
    const istHour = Math.floor(istMinutes % 1440 / 60);
    const tripType = istHour < 12 ? 'morning' : 'evening';
    const istTripDate = new Date(startUTC.getTime() + 330 * 60000);
    const tripDate = istTripDate.toISOString().slice(0, 10);
    const summaryDocId = `${finalDriverId}_${tripDate}`;
    const summaryRef = db.collection('trip_summaries').doc(summaryDocId);
    const summarySnap = await summaryRef.get();
    const summaryData = summarySnap.exists ? summarySnap.data() : {};
    const updateData = {
      driverId: finalDriverId,
      driverName: finalDriverName,
      busNumber: finalBusNumber,
      route: route || tripData.route,
      tripDate,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      updatedAt: endTime,
      [`${tripType}Duration`]: durationMin,
      [`${tripType}StartTime`]: new Date(tripData.startTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      [`${tripType}EndTime`]: new Date(endTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    };
    if (totalDistance) updateData[`${tripType}Distance`] = totalDistance;
    if (studentsBoarded) updateData[`${tripType}StudentsBoarded`] = studentsBoarded;
    if (summarySnap.exists) {
      await summaryRef.update(updateData);
    } else {
      await summaryRef.set(updateData);
    }

    await db.collection('tripLogs').add({
      tripId,
      driverId: finalDriverId,
      driverName: finalDriverName,
      busId: finalBusNumber,
      busNumber: finalBusNumber,
      route: route || tripData.route || '',
      date: tripDate,
      tripType,
      startTime: tripData.startTime,
      endTime,
      duration: durationMin,
      studentsBoarded: studentsBoarded || 0,
      totalDistance: totalDistance || 0,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      createdAt: endTime,
    });

    const startFmt = new Date(tripData.startTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const endFmt = new Date(endTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    syncBusTripHistory({
      driverId: finalDriverId,
      driverName: finalDriverName,
      busNumber: finalBusNumber,
      route: route || tripData.route,
      tripType: tripData.tripType || 'school',
      startTime: startFmt,
      endTime: endFmt,
      duration: String(durationMin),
    }).catch(e => console.error('Sheets bus trip sync error:', e.message));

    console.log(`Trip ended: Bus ${finalBusNumber}, duration: ${durationMin} min, distance: ${totalDistance || 0}km`);
    res.json({ success: true, durationMin });
  } catch (err) {
    console.error('End trip error:', err.message);
    res.status(500).json({ error: 'Failed to end trip' });
  }
});

app.get('/api/trip/onboard-count', async (req, res) => {
  try {
    const { busId, date } = req.query;
    if (!busId) return res.status(400).json({ error: 'busId required' });

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const today = date || new Date(now.getTime() + istOffset).toISOString().slice(0, 10);

    const scansRef = db.collection('trip_scans');
    const scansQ = scansRef.where('date', '==', today).where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID));
    const snap = await scansQ.get();
    const scans = snap.docs.map(d => d.data()).filter(s => s.busId === busId || s.busNumber === busId);
    const boardCount = scans.filter(s => s.type === 'board').length;

    const busQ = db.collection('buses').where('busNumber', '==', busId);
    const busSnap = await busQ.get();
    let totalStudents = 0;
    if (!busSnap.empty) {
      const busData = busSnap.docs[0].data();
      totalStudents = (busData.studentIds || []).length;
    }
    if (totalStudents === 0) {
      const studQ = db.collection('students').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('busRoute', '==', busId);
      const studSnap = await studQ.get();
      totalStudents = studSnap.size;
    }

    res.json({ success: true, boardCount, totalStudents });
  } catch (err) {
    console.error('Get onboard count error:', err.message);
    res.status(500).json({ error: 'Failed to get onboard count' });
  }
});

app.get('/api/admin/buses', async (req, res) => {
  try {
    const snap = await db.collection('buses').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    const buses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, buses });
  } catch (err) {
    console.error('Get admin buses error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/buses/add', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { busNumber, route, driverId, driverName, cleanerId, cleanerName } = req.body;
    if (!busNumber) return res.status(400).json({ error: 'Bus number is required' });

    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const schoolSnap = await db.collection('schools').doc(schoolId).get();
    const rawName = (schoolSnap.exists && schoolSnap.data().name) ? schoolSnap.data().name : schoolId;
    const initials = rawName
      .split(/[\s_-]+/)
      .filter(w => w.length > 0)
      .map(w => w[0].toUpperCase())
      .join('');

    const busSnap = await db.collection('buses')
      .where('schoolId', '==', schoolId)
      .get();
    const nextNumber = String(busSnap.size + 1).padStart(3, '0');
    const busId = `${initials}-Route-${nextNumber}`;
    const routeId = busId;

    const existing = await db.collection('buses')
      .where('schoolId', '==', schoolId)
      .where('busNumber', '==', busNumber)
      .get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'Bus number already exists' });
    }

    await db.collection('buses').doc(busId).set({
      busId,
      busNumber,
      route: route || '',
      routeId,
      driverId: driverId || '',
      driverName: driverName || '',
      cleanerId: cleanerId || '',
      cleanerName: cleanerName || '',
      schoolId,
      studentIds: [],
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Bus added: ${busNumber} (${busId})`);
    res.json({ success: true, busId, routeId });
  } catch (err) {
    console.error('Add bus error:', err.message);
    res.status(500).json({ error: 'Failed to create bus route' });
  }
});

app.post('/api/admin/buses/assign-students', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { busId, studentIds } = req.body;
    if (!busId || !Array.isArray(studentIds)) {
      return res.status(400).json({ error: 'busId and studentIds array required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const busSnap = await db.collection('buses').doc(busId).get();
    if (!busSnap.exists) {
      return res.status(404).json({ error: 'Bus not found' });
    }
    const busData = busSnap.data();
    if (busData.schoolId && busData.schoolId !== schoolId) {
      return res.status(403).json({ error: 'Bus not found in your school' });
    }

    await db.collection('buses').doc(busId).update({
      assignedStudents: studentIds,
      studentIds,
      updatedAt: new Date().toISOString()
    });

    for (const sid of studentIds) {
      try {
        const studentQ = db.collection('students').where('studentId', '==', sid).where('schoolId', '==', schoolId);
        const studentSnap = await studentQ.get();
        if (!studentSnap.empty) {
          await studentSnap.docs[0].ref.update({ busId, updatedAt: new Date().toISOString() });
        }
      } catch (studentErr) {
        console.warn(`[assign-students] Could not update student ${sid}:`, studentErr.message);
      }
    }

    console.log(`Assigned ${studentIds.length} students to bus ${busId}`);
    res.json({ success: true, count: studentIds.length });
  } catch (err) {
    console.error('Assign students to bus error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bus/onboard-students', async (req, res) => {
  try {
    const { busId, date } = req.query;
    if (!busId) return res.status(400).json({ error: 'busId required' });
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const today = date || new Date(now.getTime() + istOffset).toISOString().slice(0, 10);
    const scansQ = db.collection('trip_scans').where('date', '==', today).where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID));
    const snap = await scansQ.get();
    const scans = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.busId === busId || s.busNumber === busId);

    const studentMap = {};
    for (const scan of scans) {
      if (!studentMap[scan.studentId] || scan.timestamp > studentMap[scan.studentId].timestamp) {
        studentMap[scan.studentId] = scan;
      }
    }

    const students = Object.values(studentMap).map(scan => ({
      studentId: scan.studentId,
      studentName: scan.studentName || '',
      status: scan.type === 'board' ? 'Onboard' : 'Arrived at School',
      boardTime: scan.type === 'board' ? scan.timestamp : null,
      arrivalTime: scan.type === 'alight' ? scan.timestamp : null,
      lastScan: scan.timestamp
    }));

    students.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));
    res.json({ success: true, students, total: students.length, date: today });
  } catch (err) {
    console.error('Get onboard students error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trip/scans', async (req, res) => {
  try {
    const { tripId, busNumber, driverId } = req.query;
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const today = new Date(now.getTime() + istOffset).toISOString().slice(0, 10);

    if (!tripId && !busNumber && !driverId) {
      return res.status(400).json({ error: 'tripId, busNumber, or driverId required' });
    }

    const scansRef = db.collection('trip_scans');
    const baseQ = scansRef.where('date', '==', today).where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID));
    const snap = await baseQ.get();

    let resolvedBusNumber = busNumber || '';
    if (!resolvedBusNumber && driverId) {
      const userQ = db.collection('users').where('role_id', '==', driverId);
      const userSnap = await userQ.get();
      if (!userSnap.empty) {
        resolvedBusNumber = userSnap.docs[0].data().bus_number || '';
      }
    }

    let scans = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (resolvedBusNumber) {
      scans = scans.filter(s => s.busId === resolvedBusNumber || s.busNumber === resolvedBusNumber);
    } else if (driverId) {
      scans = scans.filter(s => s.driverId === driverId);
    }

    scans.sort((a, b) => (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || ''));

    const boardCount = scans.filter(s => s.type === 'board').length;
    const alightCount = scans.filter(s => s.type === 'alight').length;

    res.json({ success: true, scans, boardCount, alightCount, total: scans.length });
  } catch (err) {
    console.error('Get trip scans error:', err.message);
    res.status(500).json({ error: 'Failed to get trip scans' });
  }
});

const recentScans = {};

app.post('/api/trip/scan', scanLimiter, validate([
  body().custom((value, { req: r }) => {
    if (!r.body.qrData && !r.body.studentId) {
      throw new Error('Either qrData or studentId is required');
    }
    return true;
  }),
  body('qrData').optional().isString().trim(),
  body('studentId').optional().isString().trim(),
  body('busId').optional().isString().trim(),
]), async (req, res) => {
  try {
    const { qrData, studentId: legacyStudentId, driverId, busId, scannedBy, role, timestamp } = req.body;
    const scanTime = timestamp || new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);

    let studentId = '';

    if (qrData && typeof qrData === 'string') {
      const parts = qrData.split('|');
      if (parts.length !== 3 || parts[0] !== 'SREE_PRAGATHI') {
        await logRejectedScan({ scannedData: qrData, driverId, busId, reason: 'QR format mismatch', timestamp: scanTime });
        return res.status(400).json({ success: false, error: 'Invalid QR format — must be SREE_PRAGATHI|schoolId|studentId', code: 'INVALID_QR' });
      }

      const [, qrSchoolId, qrStudentId] = parts;
      studentId = qrStudentId;

      if (qrSchoolId !== (req.schoolId || DEFAULT_SCHOOL_ID)) {
        await logRejectedScan({ scannedData: qrData, driverId, busId, reason: 'School mismatch', timestamp: scanTime, studentId });
        return res.status(403).json({ success: false, error: 'Student does not belong to this school', code: 'SCHOOL_MISMATCH' });
      }
    } else if (legacyStudentId) {
      studentId = String(legacyStudentId);
    } else {
      await logRejectedScan({ scannedData: qrData || '', driverId, busId, reason: 'No QR data provided', timestamp: scanTime });
      return res.status(400).json({ success: false, error: 'qrData or studentId required', code: 'INVALID_QR' });
    }

    let studentData = null;
    try {
      const studentQ = db.collection('students').where('studentId', '==', studentId);
      const studentSnap = await studentQ.get();
      if (!studentSnap.empty) {
        studentData = { id: studentSnap.docs[0].id, ...studentSnap.docs[0].data() };
      }
    } catch (e) {
      console.error('[QR Scan] Student lookup error:', e.message);
    }

    if (!studentData) {
      await logRejectedScan({ scannedData: qrData || studentId, driverId, busId, reason: 'Student not found', timestamp: scanTime, studentId });
      return res.status(404).json({ success: false, error: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    }

    if (studentData.status && studentData.status !== 'active') {
      await logRejectedScan({ scannedData: qrData || studentId, driverId, busId, reason: 'Student inactive', timestamp: scanTime, studentId });
      return res.status(403).json({ success: false, error: 'Student account is inactive', code: 'STUDENT_INACTIVE' });
    }

    let driverData = null;
    if (driverId) {
      try {
        const driverQ = db.collection('users').where('role_id', '==', driverId);
        const driverSnap = await driverQ.get();
        if (!driverSnap.empty) driverData = driverSnap.docs[0].data();
      } catch (e) {
        console.error('[QR Scan] Driver lookup error:', e.message);
      }
    }

    let busData = null;
    if (busId) {
      try {
        const busQ = db.collection('buses').where('busId', '==', busId);
        const busSnap = await busQ.get();
        if (busSnap.empty) {
          const busQ2 = db.collection('buses').where('busNumber', '==', busId);
          const busSnap2 = await busQ2.get();
          if (!busSnap2.empty) busData = { id: busSnap2.docs[0].id, ...busSnap2.docs[0].data() };
        } else {
          busData = { id: busSnap.docs[0].id, ...busSnap.docs[0].data() };
        }
      } catch (e) {
        console.error('[QR Scan] Bus lookup error:', e.message);
      }
    }

    if (studentData.schoolId && studentData.schoolId !== (req.schoolId || DEFAULT_SCHOOL_ID)) {
      await logRejectedScan({ scannedData: qrData || studentId, driverId, busId, reason: 'School mismatch (student doc)', timestamp: scanTime, studentId });
      return res.status(403).json({ success: false, error: 'Student does not belong to this school', code: 'SCHOOL_MISMATCH' });
    }

    const studentBusId = studentData.busId || '';
    const isWrongBus = studentBusId && busId && studentBusId !== busId;

    if (isWrongBus) {
      console.warn(`[QR Scan] WRONG BUS — Student ${studentData.name} assigned to ${studentBusId} but boarding ${busId}`);

      try {
        await db.collection('admin_notifications').add({
          type: 'wrong_bus_boarding',
          icon: '⚠️',
          title: 'Wrong Bus Alert',
          message: `${studentData.name} (Class ${studentData.className || studentData.classId}) has boarded Bus ${busData?.busNumber || busId} but is assigned to Bus ${studentBusId}. Immediate attention required.`,
          details: {
            studentId,
            studentName: studentData.name,
            studentClass: studentData.className || studentData.classId || '',
            assignedBusId: studentBusId,
            actualBusId: busId,
            actualBusNumber: busData?.busNumber || busId,
            driverId,
            driverName: driverData?.full_name || driverId,
            scanTime
          },
          priority: 'high',
          schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
          read: false,
          createdAt: scanTime
        });
      } catch (notifErr) {
        console.error('[QR Scan] Wrong bus admin notification error:', notifErr.message);
      }

      try {
        const parentPhone = studentData.parentPhone || '';
        if (parentPhone) {
          await db.collection('parent_notifications').add({
            type: 'wrong_bus_alert',
            icon: '⚠️',
            title: 'Wrong Bus Alert',
            message: `Alert: ${studentData.name} has boarded Bus ${busData?.busNumber || busId} instead of their assigned bus. Please contact the school immediately.`,
            details: { studentId, studentName: studentData.name, busId, busNumber: busData?.busNumber || busId },
            parentPhone,
            schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
            read: false,
            createdAt: scanTime
          });
        }
      } catch (notifErr) {
        console.error('[QR Scan] Wrong bus parent notification error:', notifErr.message);
      }
    }

    const scanKey = `${studentId}_${today}`;
    const lastScanTime = recentScans[scanKey];
    if (lastScanTime) {
      const diffMs = new Date(scanTime).getTime() - new Date(lastScanTime).getTime();
      if (diffMs < 5 * 60 * 1000) {
        return res.status(429).json({ success: false, error: 'Student already scanned within last 5 minutes', code: 'DUPLICATE_SCAN' });
      }
    }
    recentScans[scanKey] = scanTime;

    const prevScansQ = db.collection('trip_scans').where('studentId', '==', studentId).where('date', '==', today);
    const prevScansSnap = await prevScansQ.get();
    const scanCount = prevScansSnap.size;
    const isBoarding = scanCount % 2 === 0;
    const scanType = isBoarding ? 'board' : 'alight';

    const scanDoc = {
      studentId,
      studentName: studentData.name || '',
      className: studentData.className || studentData.classId || '',
      schoolId: studentData.schoolId || (req.schoolId || DEFAULT_SCHOOL_ID),
      busId: busId || '',
      busNumber: busData?.busNumber || '',
      assignedBusId: studentBusId || busId,
      isWrongBus,
      driverId: driverId || '',
      scannedBy: scannedBy || '',
      role: role || 'cleaner',
      type: scanType,
      date: today,
      timestamp: scanTime,
      createdAt: new Date().toISOString()
    };

    const scanRef = await db.collection('trip_scans').add(scanDoc);
    const _pushParentId = studentData.parentId || studentData.parent_uid || '';
    if (_pushParentId) {
      if (isBoarding) {
        sendPushNotification(_pushParentId, '✅ Boarded Bus', `${studentData.name} has boarded the bus`, { type: 'bus_board', studentId });
      } else {
        sendPushNotification(_pushParentId, '🏠 Safely Home', `${studentData.name} has deboarded the bus safely`, { type: 'bus_deboard', studentId });
      }
    }
    console.log(`[QR Scan] ${studentData.name} ${scanType} Bus ${busData?.busNumber || busId} (scan #${scanCount + 1})`);

    if (!isWrongBus) {
      try {
        const parentPhone = studentData.parentPhone || '';
        if (parentPhone) {
          const boardMsg = `${studentData.name} has boarded Bus ${busData?.busNumber || busId}. 🚌 Have a safe journey!`;
          const arrivalMsg = `${studentData.name} has arrived at school safely. ✅`;
          await db.collection('parent_notifications').add({
            type: isBoarding ? 'student_boarded' : 'student_arrived',
            icon: isBoarding ? '🚌' : '🏫',
            title: isBoarding ? 'Child Boarded Bus' : 'Child Arrived at School',
            message: isBoarding ? boardMsg : arrivalMsg,
            details: {
              studentId,
              studentName: studentData.name,
              busId,
              busNumber: busData?.busNumber || '',
              scanType,
              timestamp: scanTime
            },
            parentPhone,
            schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
            read: false,
            createdAt: scanTime
          });
          sendAndLog(
            studentData.schoolId || (req.schoolId || DEFAULT_SCHOOL_ID),
            parentPhone,
            isBoarding ? 'vl_bus_board' : 'vl_bus_arrived',
            [studentData.name, busData?.busNumber || busId, new Date(scanTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })],
            { studentName: studentData.name }
          ).catch(() => {});
        }
      } catch (notifErr) {
        console.error('[QR Scan] Parent notification error:', notifErr.message);
      }
    }

    res.json({
      success: true,
      scanId: scanRef.id,
      studentName: studentData.name,
      studentClass: studentData.className || studentData.classId || '',
      scanType,
      scanNumber: scanCount + 1,
      isWrongBus,
      busNumber: busData?.busNumber || busId,
      message: isWrongBus
        ? `⚠️ Wrong bus alert sent. ${studentData.name} is assigned to Bus ${studentBusId}.`
        : isBoarding
          ? `✅ ${studentData.name} boarded successfully`
          : `✅ ${studentData.name} arrived at school`
    });

  } catch (err) {
    console.error('[QR Scan] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/bus/attendance', verifyAuth, async (req, res) => {
  try {
    const { busId, date, records } = req.body;
    if (!busId || !date || !records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'busId, date, and records (array) are required' });
    }

    const batch = db.batch();
    const attendanceRef = db.collection('bus_attendance');

    for (const record of records) {
      if (!record.studentId) continue;
      const docId = `${record.studentId}_${busId}_${date}`;
      const docRef = attendanceRef.doc(docId);
      batch.set(docRef, {
          studentId: record.studentId,
          studentName: record.studentName || '',
          busId,
          date,
          status: record.status || 'Present',
          schoolId: req.schoolId || DEFAULT_SCHOOL_ID,
          markedBy: req.userId,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();
    res.json({ success: true, message: `Bus attendance saved for ${records.length} students` });
  } catch (err) {
    console.error('Bus attendance error:', err.message);
    res.status(500).json({ error: 'Failed to save bus attendance' });
  }
});

app.get('/api/bus/passengers', verifyAuth, async (req, res) => {
  try {
    const { busId } = req.query;
    if (!busId) return res.status(400).json({ error: 'busId required' });

    const studentsRef = db.collection('students');
    const q = studentsRef.where('schoolId', '==', req.schoolId || DEFAULT_SCHOOL_ID).where('busId', '==', busId);
    const snapshot = await q.get();
    
    const students = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, passengers: students });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bus passengers' });
  }
});

async function logRejectedScan({ scannedData, driverId, busId, reason, timestamp, studentId }) {
  try {
    await db.collection('scan_rejection_logs').add({
      scannedData: scannedData || '',
      driverId: driverId || '',
      busId: busId || '',
      studentId: studentId || '',
      reason,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      timestamp: timestamp || new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    if (driverId || busId) {
      await checkInvalidScanThreshold(driverId, busId, timestamp || new Date().toISOString());
    }
  } catch (e) {
    console.error('[QR Scan] Failed to log rejection:', e.message);
  }
}

const invalidScanLog = {};
async function checkInvalidScanThreshold(driverId, busId, timestamp) {
  try {
    const key = `${driverId}_${busId}`;
    if (!invalidScanLog[key]) invalidScanLog[key] = [];
    invalidScanLog[key].push(timestamp);

    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    invalidScanLog[key] = invalidScanLog[key].filter(t => t > tenMinAgo);

    if (invalidScanLog[key].length >= 3) {
      await db.collection('admin_notifications').add({
        type: 'repeated_invalid_scans',
        icon: '🚨',
        title: 'Security Alert — Repeated Invalid Scans',
        message: `Driver ${driverId} on Bus ${busId} has had ${invalidScanLog[key].length} invalid scan attempts in the last 10 minutes. Please investigate.`,
        details: { driverId, busId, count: invalidScanLog[key].length },
        priority: 'high',
        schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
        read: false,
        createdAt: new Date().toISOString()
      });
      invalidScanLog[key] = [];
    }
  } catch (e) {
    console.error('[QR Scan] Threshold check error:', e.message);
  }
}

app.get('/api/student/qr/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const studentQ = db.collection('students').where('studentId', '==', studentId);
    const studentSnap = await studentQ.get();
    if (studentSnap.empty) return res.status(404).json({ error: 'Student not found' });

    const studentData = studentSnap.docs[0].data();
    const qrCode = studentData.qrCode || `SREE_PRAGATHI|${(req.schoolId || DEFAULT_SCHOOL_ID)}|${studentId}`;

    if (!studentData.qrCode) {
      await studentSnap.docs[0].ref.update({ qrCode });
    }

    res.json({ success: true, studentId, studentName: studentData.name, qrCode });
  } catch (err) {
    console.error('Get student QR error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/school/info/:schoolId', async (req, res) => {
  try {
    const { schoolId } = req.params;
    const id = schoolId.trim().toUpperCase();

    // 1️⃣ Try exact document ID match (fast path)
    let schoolSnap = await adminDb.collection('schools').doc(id).get();
    let docData = schoolSnap.exists ? schoolSnap.data() : null;

    // 2️⃣ Fallback: query by schoolId field
    if (!docData) {
      const q1 = await adminDb.collection('schools').where('schoolId', '==', id).limit(1).get();
      if (!q1.empty) docData = q1.docs[0].data();
    }

    // 3️⃣ Fallback: query by school_code field (used by some Super Admin dashboards)
    if (!docData) {
      const q2 = await adminDb.collection('schools').where('school_code', '==', id).limit(1).get();
      if (!q2.empty) docData = q2.docs[0].data();
    }

    // 4️⃣ Fallback: query by name field
    if (!docData) {
      const q3 = await adminDb.collection('schools').where('schoolName', '==', id).limit(1).get();
      if (!q3.empty) docData = q3.docs[0].data();
    }

    if (!docData) return res.status(404).json({ error: 'School not found. Please check your School ID.' });

    // Auto-repair: if found via fallback but doc was stored under wrong ID, migrate it
    if (!schoolSnap.exists && docData) {
      try {
        await adminDb.collection('schools').doc(id).set({ ...docData, schoolId: id });
        console.log(`[School Lookup] Auto-migrated school to correct ID: ${id}`);
      } catch (migrateErr) {
        console.warn('[School Lookup] Auto-migration skipped:', migrateErr.message);
      }
    }

    res.json({
      schoolId:     id,
      schoolName:   docData.schoolName || docData.name || '',
      location:     docData.location || docData.city || docData.district || '',
      logoUrl:      docData.logoUrl || '',
      primaryColor: docData.primaryColor || '#1a3c5e',
      tagline:      docData.tagline || '',
      isActive:     docData.status === 'active',
    });
  } catch (err) {
    console.error('[School Lookup] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/verify/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const studentData = await lookupStudentById(studentId.trim());
    if (!studentData) return res.status(404).json({ error: 'Student not found. Please check the ID.' });
    const sid = studentData.schoolId || DEFAULT_SCHOOL_ID;
    let schoolName = '';
    try {
      const schoolSnap = await adminDb.collection('schools').doc(sid).get();
      if (schoolSnap.exists) schoolName = schoolSnap.data().schoolName || '';
    } catch (_) {}
    res.json({
      studentId: studentData.studentId,
      studentName: studentData.name || studentData.studentName || '',
      className: studentData.className || studentData.class || '',
      admissionNumber: studentData.admissionNumber || studentData.studentId,
      schoolId: sid,
      schoolName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/qr/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const studentQ = await db.collection('students').where('studentId', '==', studentId).get();
    if (studentQ.empty) return res.status(404).json({ error: 'Student not found' });
    const s = studentQ.docs[0].data();
    const schoolId = s.schoolId || DEFAULT_SCHOOL_ID;
    let schoolName = '', logoUrl = '', primaryColor = '#1a3c5e', location = '';
    try {
      const schoolSnap = await adminDb.collection('schools').doc(schoolId).get();
      if (schoolSnap.exists) {
        const sd = schoolSnap.data();
        schoolName    = sd.schoolName    || '';
        logoUrl       = sd.logoUrl       || '';
        primaryColor  = sd.primaryColor  || '#1a3c5e';
        location      = sd.location      || '';
      }
    } catch (_) {}
    res.json({
      studentId:       s.studentId,
      studentName:     s.name || s.studentName || '',
      schoolId,
      schoolName,
      logoUrl,
      primaryColor,
      className:       s.className || s.class || '',
      admissionNumber: s.admissionNumber || s.studentId,
      location,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/generate-qr', verifyAuth, async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const studentQ = await db.collection('students').where('studentId', '==', studentId).get();
    if (studentQ.empty) return res.status(404).json({ error: 'Student not found' });
    const s = studentQ.docs[0].data();
    let schoolName = '', logoUrl = '', primaryColor = '#1a3c5e', location = '';
    try {
      const schoolSnap = await adminDb.collection('schools').doc(schoolId).get();
      if (schoolSnap.exists) {
        const sd = schoolSnap.data();
        schoolName   = sd.schoolName   || '';
        logoUrl      = sd.logoUrl      || '';
        primaryColor = sd.primaryColor || '#1a3c5e';
        location     = sd.location     || '';
      }
    } catch (_) {}
    const qrData = JSON.stringify({
      type:            'student',
      studentId:       s.studentId,
      studentName:     s.name || s.studentName || '',
      schoolId,
      schoolName,
      location,
      logoUrl,
      primaryColor,
      className:       s.className || s.class || '',
      admissionNumber: s.admissionNumber || s.studentId,
    });
    await studentQ.docs[0].ref.update({ qrCode: qrData });
    res.json({ success: true, qrCode: qrData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/school-info', async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const ck = `school_info:${schoolId}`;
    const cached = cacheGet(ck, 120000);
    if (cached) return res.json(cached);

    const docSnap = await adminDb.collection('settings').doc(schoolId).get();
    const result = { success: true, info: docSnap.exists ? docSnap.data() : null };
    cacheSet(ck, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/school-info', verifyAuth, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const info = req.body;
    const sid = req.schoolId || DEFAULT_SCHOOL_ID;
    await adminDb.collection('settings').doc(sid).set(info, { merge: true });
    cacheDel('school_info:');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/school-info/upload-image', verifyAuth, upload.single('image'), async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'principal') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' });
    }

    if (req.file.size > 500 * 1024) {
      return res.status(400).json({ error: 'Image must be under 500KB' });
    }

    const fs = require('fs');
    const galleryDir = path.join(__dirname, 'uploads', 'gallery');
    if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });

    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
    const ext = extMap[req.file.mimetype] || 'jpg';
    const filename = `school_${Date.now()}.${ext}`;
    const filePath = path.join(galleryDir, filename);

    fs.writeFileSync(filePath, req.file.buffer);

    const imageUrl = `/uploads/gallery/${filename}`;
    res.json({ success: true, imageUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bus/live-location', async (req, res) => {
  try {
    const { busNumber } = req.query;
    if (!busNumber) return res.status(400).json({ error: 'busNumber required' });
    const q = db.collection('live_bus_locations').where('busNumber', '==', busNumber).where('status', '==', 'active');
    const snap = await q.get();
    if (snap.empty) return res.json({ location: null, active: false });
    const d = snap.docs[0].data();
    res.json({ location: { lat: d.lat, lng: d.lng, speed: d.speed, updatedAt: d.updatedAt }, active: true, busNumber: d.busNumber, route: d.route });
  } catch (err) {
    console.error('Get live location error:', err.message);
    res.status(500).json({ error: 'Failed to get location' });
  }
});

app.get('/api/bus/active-trips', async (req, res) => {
  try {
    const q = db.collection('live_bus_locations').where('status', '==', 'active');
    const snap = await q.get();
    const trips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ trips });
  } catch (err) {
    console.error('Get active trips error:', err.message);
    res.status(500).json({ error: 'Failed to get active trips' });
  }
});

app.get('/api/bus/route-students', async (req, res) => {
  try {
    const { route, driverId } = req.query;

    let busRoute = route || '';
    let busNumber = '';
    let busId = '';
    let assignedStudentIds = [];

    if (driverId) {
      const userQ = db.collection('users').where('role_id', '==', driverId);
      const userSnap = await userQ.get();
      if (!userSnap.empty) {
        const userData = userSnap.docs[0].data();
        busRoute = userData.route || busRoute;
        busNumber = userData.bus_number || '';
      }

      const busQ = db.collection('buses').where('driverId', '==', driverId);
      const busSnap = await busQ.get();
      if (!busSnap.empty) {
        const busData = busSnap.docs[0].data();
        busId = busSnap.docs[0].id;
        busNumber = busData.busNumber || busNumber;
        busRoute = busData.route || busRoute;
        assignedStudentIds = busData.assignedStudents || busData.studentIds || [];
      }
    }

    if (!busRoute && !driverId) return res.status(400).json({ error: 'route or driverId required' });

    const stops = {};
    if (busRoute) {
      const stopQ = db.collection('student_stops').where('route', '==', busRoute);
      const stopSnap = await stopQ.get();
      stopSnap.docs.forEach(d => { const data = d.data(); stops[data.studentId] = { ...data, id: d.id }; });
    }

    const students = [];
    if (assignedStudentIds.length > 0) {
      for (const studentId of assignedStudentIds) {
        try {
          const studentSnap = await db.collection('students').doc(String(studentId)).get();
          if (studentSnap.exists) {
            const sData = studentSnap.data();
            students.push({
              id: studentId,
              name: sData.name || sData.full_name || 'Unknown',
              className: sData.className || sData.class || '',
              roll: sData.rollNumber || sData.roll || '',
              parent: sData.parentName || sData.parent || '',
              phone: sData.parentPhone || sData.phone || '',
              bus: busRoute,
              photo: (sData.name || 'S').charAt(0),
            });
          }
        } catch (e) {
          console.warn('Could not fetch student:', studentId);
        }
      }
    }

    if (students.length === 0 && busRoute) {
      const routeMatch = busRoute.match(/Route\s*(\d+)/i);
      const routeKey = routeMatch ? `Route ${routeMatch[1]}` : busRoute;

      const allStudentsSnap = await db.collection('students').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
      allStudentsSnap.docs.forEach(d => {
        const sData = d.data();
        if (sData.busRoute === routeKey || sData.bus === routeKey || sData.busRoute === busRoute) {
          students.push({
            id: d.id,
            name: sData.name || sData.full_name || 'Unknown',
            className: sData.className || sData.class || '',
            roll: sData.rollNumber || sData.roll || '',
            parent: sData.parentName || sData.parent || '',
            phone: sData.parentPhone || sData.phone || '',
            bus: routeKey,
            photo: (sData.name || 'S').charAt(0),
          });
        }
      });
    }

    res.json({ success: true, students, stops, busId, busNumber, busRoute });
  } catch (err) {
    console.error('Get route students error:', err.message);
    res.status(500).json({ error: 'Failed to get route students' });
  }
});

app.post('/api/bus/set-stop', async (req, res) => {
  try {
    const { studentId, studentName, className, route, lat, lng, setBy } = req.body;
    if (!studentId || lat === undefined || lng === undefined) return res.status(400).json({ error: 'studentId, lat, lng required' });

    const docId = `stop_${String(studentId)}`;
    const stopRef = db.collection('student_stops').doc(docId);
    const existing = await stopRef.get();

    if (existing.exists) {
      const existingData = existing.data();
      if (existingData.locked) return res.status(403).json({ error: 'This stop is locked by admin and cannot be changed' });
      await stopRef.update({
        lat, lng, setBy: setBy || '', updatedAt: new Date().toISOString(),
      });
    } else {
      await stopRef.set({
        studentId: String(studentId),
        studentName: studentName || '',
        className: className || '',
        route: route || '',
        lat, lng,
        setBy: setBy || '',
        locked: false,
        updatedAt: new Date().toISOString(),
      });
    }

    syncStudentStop({
      studentId, studentName, className, route, lat, lng, setBy,
      date: new Date().toLocaleDateString('en-IN'),
    }).catch(e => console.error('Sheets student stop sync error:', e.message));

    console.log(`Stop set for ${studentName || studentId}: ${lat}, ${lng}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Set stop error:', err.message);
    res.status(500).json({ error: 'Failed to set stop' });
  }
});

app.post('/api/bus/lock-stop', async (req, res) => {
  try {
    const { studentId, locked } = req.body;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const docId = `stop_${String(studentId)}`;
    const stopRef = db.collection('student_stops').doc(docId);
    const stopSnap = await stopRef.get();
    if (!stopSnap.exists) return res.status(404).json({ error: 'Stop not found for this student' });
    await stopRef.update({ locked: locked !== false });
    res.json({ success: true, locked: locked !== false });
  } catch (err) {
    console.error('Lock stop error:', err.message);
    res.status(500).json({ error: 'Failed to lock stop' });
  }
});

app.post('/api/bus/request-location-change', async (req, res) => {
  try {
    const { studentId, studentName, className, route, busNumber, driverName, newLat, newLng, oldAddress, newAddress, reason, requestedBy, requestedByRoleId } = req.body;
    if (!studentId || !newLat || !newLng) return res.status(400).json({ error: 'studentId, newLat, newLng required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason for change is required' });

    let oldLat = null, oldLng = null;
    const docId = `stop_${String(studentId)}`;
    const stopRef = db.collection('student_stops').doc(docId);
    const stopSnap = await stopRef.get();
    if (stopSnap.exists) {
      const stopData = stopSnap.data();
      oldLat = stopData.lat || null;
      oldLng = stopData.lng || null;
    }

    const requestDoc = await db.collection('location_change_requests').add({
      studentId: String(studentId),
      studentName: studentName || '',
      className: className || '',
      route: route || '',
      busNumber: busNumber || '',
      driverName: driverName || requestedBy || '',
      oldLat,
      oldLng,
      newLat,
      newLng,
      oldAddress: oldAddress || null,
      newAddress: newAddress || null,
      reason: reason.trim(),
      requestedBy: requestedBy || '',
      requestedByRoleId: requestedByRoleId || '',
      status: 'pending',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      createdAt: new Date().toISOString(),
    });

    await db.collection('parent_notifications').add({
      type: 'admin_alert',
      subType: 'location_change_request',
      requestId: requestDoc.id,
      message: `Driver ${driverName || requestedBy || 'Unknown'} (Bus ${busNumber || 'Unknown'}) requested a pickup location change for student ${studentName}. Old: ${oldAddress || 'Unknown'}. New: ${newAddress || `${newLat}, ${newLng}`}. Reason: ${reason.trim()}`,
      studentName: studentName || '',
      busNumber: busNumber || '',
      driverName: driverName || requestedBy || '',
      forAdmin: true,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Location change request created: ${requestDoc.id} for student ${studentId}`);
    res.json({ success: true, requestId: requestDoc.id });
  } catch (err) {
    console.error('Request location change error:', err.message);
    res.status(500).json({ error: 'Failed to create location change request' });
  }
});

app.get('/api/bus/location-change-requests', async (req, res) => {
  try {
    const q = db.collection('location_change_requests').where('status', '==', 'pending');
    const snap = await q.get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ requests });
  } catch (err) {
    console.error('Get location change requests error:', err.message);
    res.status(500).json({ error: 'Failed to fetch location change requests' });
  }
});

app.post('/api/bus/approve-location-change', async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const requestRef = db.collection('location_change_requests').doc(requestId);
    const requestSnap = await requestRef.get();
    if (!requestSnap.exists) return res.status(404).json({ error: 'Request not found' });

    const requestData = requestSnap.data();
    const docId = `stop_${String(requestData.studentId)}`;
    const stopRef = db.collection('student_stops').doc(docId);
    const stopSnap = await stopRef.get();

    if (stopSnap.exists) {
      await stopRef.update({ lat: requestData.newLat, lng: requestData.newLng, updatedAt: new Date().toISOString() });
    } else {
      await stopRef.set({
        studentId: String(requestData.studentId),
        studentName: requestData.studentName,
        className: requestData.className,
        route: requestData.route,
        lat: requestData.newLat,
        lng: requestData.newLng,
        setBy: 'Admin Approved',
        date: new Date().toLocaleDateString('en-IN'),
        updatedAt: new Date().toISOString(),
      });
    }

    syncStudentStop({
      studentId: requestData.studentId,
      studentName: requestData.studentName,
      className: requestData.className,
      route: requestData.route,
      lat: requestData.newLat,
      lng: requestData.newLng,
      setBy: 'Admin Approved',
      date: new Date().toLocaleDateString('en-IN'),
    }).catch(e => console.error('Sheets sync on approve error:', e.message));

    await requestRef.update({ status: 'approved', approvedAt: new Date().toISOString() });

    await db.collection('driver_notifications').add({
      driverId: requestData.requestedByRoleId || '',
      driverName: requestData.driverName || requestData.requestedBy || '',
      type: 'location_change_approved',
      message: `✅ Your location change request for ${requestData.studentName} has been approved. The new pickup location is now active.`,
      studentId: requestData.studentId,
      studentName: requestData.studentName || '',
      requestId,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Location change approved: ${requestId} for student ${requestData.studentId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Approve location change error:', err.message);
    res.status(500).json({ error: 'Failed to approve location change' });
  }
});

app.post('/api/bus/reject-location-change', async (req, res) => {
  try {
    const { requestId, reason } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const requestRef = db.collection('location_change_requests').doc(requestId);
    const requestSnap = await requestRef.get();
    if (!requestSnap.exists) return res.status(404).json({ error: 'Request not found' });

    const requestData = requestSnap.data();

    await requestRef.update({
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      adminReason: reason || '',
    });

    await db.collection('driver_notifications').add({
      driverId: requestData.requestedByRoleId || '',
      driverName: requestData.driverName || requestData.requestedBy || '',
      type: 'location_change_rejected',
      message: `❌ Your location change request for ${requestData.studentName} was rejected by Admin.${reason ? ` Reason: ${reason}` : ''} The original pickup location remains active.`,
      studentId: requestData.studentId,
      studentName: requestData.studentName || '',
      requestId,
      adminReason: reason || '',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Location change rejected: ${requestId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Reject location change error:', err.message);
    res.status(500).json({ error: 'Failed to reject location change' });
  }
});

app.get('/api/bus/pending-requests', async (req, res) => {
  try {
    const { route } = req.query;
    let q;
    if (route) {
      q = db.collection('location_change_requests').where('status', '==', 'pending').where('route', '==', route);
    } else {
      q = db.collection('location_change_requests').where('status', '==', 'pending');
    }
    const snap = await q.get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ requests });
  } catch (err) {
    console.error('Get pending requests error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
});

app.get('/api/bus/all-stops', async (req, res) => {
  try {
    const snap = await db.collection('student_stops').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    const stops = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ stops });
  } catch (err) {
    console.error('Get all stops error:', err.message);
    res.status(500).json({ error: 'Failed to get stops' });
  }
});

app.post('/api/duty/clock-in', async (req, res) => {
  try {
    const { userId, name, role, roleId } = req.body;
    if (!userId || !roleId) return res.status(400).json({ error: 'userId and roleId required' });
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN');
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const docId = `duty_${roleId}_${now.toISOString().slice(0, 10)}`;
    const dutyRef = db.collection('staff_duty').doc(docId);
    const existing = await dutyRef.get();
    if (existing.exists && existing.data().onDuty) {
      return res.json({ success: true, alreadyOn: true, clockIn: existing.data().clockIn, status: existing.data().currentStatus });
    }
    await dutyRef.set({
      userId, name: name || '', role: role || '', roleId,
      onDuty: true, clockIn: timeStr, clockOut: null,
      currentStatus: role === 'teacher' ? 'Available' : 'On Duty',
      date: dateStr, dateKey: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString(),
    });
    syncStaffAttendance({ name, role, roleId, clockIn: timeStr, status: 'On Duty', date: dateStr })
      .catch(e => console.error('Sheets duty sync error:', e.message));
    console.log(`Clock IN: ${name || roleId} at ${timeStr}`);
    res.json({ success: true, clockIn: timeStr });
  } catch (err) {
    console.error('Clock in error:', err.message);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

app.post('/api/duty/clock-out', async (req, res) => {
  try {
    const { userId, name, role, roleId } = req.body;
    if (!userId || !roleId) return res.status(400).json({ error: 'userId and roleId required' });
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN');
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const docId = `duty_${roleId}_${now.toISOString().slice(0, 10)}`;
    const dutyRef = db.collection('staff_duty').doc(docId);
    const existing = await dutyRef.get();
    if (!existing.exists) {
      return res.status(404).json({ error: 'No active duty record found' });
    }
    const data = existing.data();
    const clockInTime = data.clockIn || '08:00';
    const inMs = new Date(`2000-01-01T${clockInTime}`).getTime();
    const outMs = new Date(`2000-01-01T${timeStr}`).getTime();
    const hoursWorked = ((outMs - inMs) / 3600000).toFixed(1);
    await dutyRef.update({ onDuty: false, clockOut: timeStr, currentStatus: 'Off Duty', hoursWorked, updatedAt: now.toISOString() });
    syncStaffAttendance({ name, role, roleId, clockIn: clockInTime, clockOut: timeStr, status: 'Off Duty', date: dateStr })
      .catch(e => console.error('Sheets duty sync error:', e.message));
    console.log(`Clock OUT: ${name || roleId} at ${timeStr} (${hoursWorked}h)`);
    res.json({ success: true, clockOut: timeStr, hoursWorked });
  } catch (err) {
    console.error('Clock out error:', err.message);
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

app.post('/api/duty/update-status', async (req, res) => {
  try {
    const { roleId, currentStatus } = req.body;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    const now = new Date();
    const docId = `duty_${roleId}_${now.toISOString().slice(0, 10)}`;
    const dutyRef = db.collection('staff_duty').doc(docId);
    const existing = await dutyRef.get();
    if (!existing.exists) return res.status(404).json({ error: 'No duty record' });
    await dutyRef.update({ currentStatus, updatedAt: now.toISOString() });
    res.json({ success: true });
  } catch (err) {
    console.error('Update status error:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.get('/api/duty/status', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    const now = new Date();
    const docId = `duty_${roleId}_${now.toISOString().slice(0, 10)}`;
    const dutyRef = db.collection('staff_duty').doc(docId);
    const snap = await dutyRef.get();
    if (!snap.exists) return res.json({ onDuty: false, clockIn: null, clockOut: null, currentStatus: 'Off Duty' });
    res.json(snap.data());
  } catch (err) {
    console.error('Get duty status error:', err.message);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.post('/api/duty/mark-area-complete', verifyAuth, validate([
  body('roleId').notEmpty().trim().withMessage('roleId is required'),
  body('areaName').notEmpty().trim().withMessage('areaName is required'),
]), async (req, res) => {
  try {
    const { roleId, areaName, completedAt } = req.body;
    if (!roleId || !areaName) return res.status(400).json({ error: 'roleId and areaName required' });
    const today = new Date().toISOString().slice(0, 10);
    const docId = `duty_${roleId}_${today}`;
    const timestamp = completedAt || new Date().toISOString();
    await db.collection('staff_duty').doc(docId).set({
      areaCompletions: admin.firestore.FieldValue.arrayUnion({ area: areaName, completedAt: timestamp }),
      updatedAt: timestamp,
    }, { merge: true });
    await db.collection('admin_notifications').add({
      type: 'area_cleaned',
      title: 'Area Cleaning Completed',
      message: `${areaName} has been cleaned and marked complete by staff ${roleId}.`,
      roleId, areaName,
      schoolId: req.schoolId || DEFAULT_SCHOOL_ID,
      read: false,
      createdAt: timestamp,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[mark-area-complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/duty/week-log', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    const { date } = req.query;
    if (!roleId || !date) return res.status(400).json({ error: 'roleId and date required' });
    const docId = `duty_${roleId}_${date}`;
    const snap = await db.collection('staff_duty').doc(docId).get();
    if (!snap.exists) return res.json({ hoursWorked: 0, clockIn: null, clockOut: null, onDuty: false });
    res.json(snap.data());
  } catch (err) {
    console.error('Duty week log error:', err.message);
    res.status(500).json({ error: 'Failed to fetch duty log' });
  }
});

app.get('/api/duty/all-staff', async (req, res) => {
  try {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const q = db.collection('staff_duty').where('dateKey', '==', dateKey);
    const snap = await q.get();
    const staff = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ staff });
  } catch (err) {
    console.error('Get all staff duty error:', err.message);
    res.status(500).json({ error: 'Failed to get staff status' });
  }
});

async function performAutoClockout() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const q = db.collection('staff_duty').where('dateKey', '==', dateKey).where('onDuty', '==', true);
  const snap = await q.get();
  let count = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const clockInTime = data.clockIn || '08:00';
    const defaultOut = '19:00';
    const inMs = new Date(`2000-01-01T${clockInTime}`).getTime();
    const outMs = new Date(`2000-01-01T${defaultOut}`).getTime();
    const hoursWorked = ((outMs - inMs) / 3600000).toFixed(1);
    await db.collection('staff_duty').doc(d.id).update({ onDuty: false, clockOut: defaultOut, currentStatus: 'Auto Clock-Out', hoursWorked, updatedAt: now.toISOString() });
    syncStaffAttendance({ name: data.name, role: data.role, roleId: data.roleId, clockIn: clockInTime, clockOut: defaultOut, status: 'Auto Clock-Out', date: data.date })
      .catch(e => console.error('Sheets auto-clockout sync error:', e.message));
    count++;
  }
  console.log(`Auto clock-out: ${count} staff clocked out at 19:00`);
  return count;
}

app.post('/api/duty/auto-clockout', async (req, res) => {
  try {
    const count = await performAutoClockout();
    res.json({ success: true, count });
  } catch (err) {
    console.error('Auto clockout error:', err.message);
    res.status(500).json({ error: 'Failed to auto clock out' });
  }
});

app.post('/api/student-files/upload', upload.single('file'), async (req, res) => {
  try {
    const { studentId, studentName, className, uploaderName, uploaderRole } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    if (!studentId || !studentName) return res.status(400).json({ error: 'studentId and studentName required' });

    const allowed = ['image/jpeg', 'image/png', 'video/mp4', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowed.includes(file.mimetype)) return res.status(400).json({ error: 'File type not supported. Allowed: JPG, PNG, MP4, PDF, DOCX' });

    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `student_files/${studentId}/${timestamp}_${safeName}`;
    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, file.buffer, { contentType: file.mimetype });
    const fileUrl = await getDownloadURL(storageRef);

    const fileDoc = {
      studentId,
      studentName,
      className: className || '',
      fileName: file.originalname,
      fileUrl,
      fileType: file.mimetype,
      fileSize: file.size,
      uploadedBy: uploaderName || 'Admin',
      uploaderRole: uploaderRole || 'admin',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      uploadedAt: new Date().toISOString(),
    };
    const fileRef = await db.collection('student_files').add(fileDoc);

    await db.collection('parent_notifications').add({
      studentId,
      studentName,
      message: `New File Received: ${uploaderName || 'Admin'} has uploaded a document for ${studentName}.`,
      fileUrl,
      fileName: file.originalname,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      read: false,
      createdAt: new Date().toISOString(),
    });
    try {
      const stuQ = await db.collection('students').where('studentId', '==', studentId).get();
      const parentId = !stuQ.empty ? (stuQ.docs[0].data().parentId || stuQ.docs[0].data().parent_uid || '') : '';
      if (parentId) sendPushNotification(parentId, '📁 New Document', `A new document has been shared with you`, { type: 'document', studentId });
    } catch (pushErr) { console.error('Doc push error:', pushErr.message); }

    syncStudentFile({
      studentId, studentName, className: className || '', fileName: file.originalname,
      fileUrl, uploadedBy: uploaderName || 'Admin', date: new Date().toLocaleDateString('en-IN'),
    }).catch(e => console.error('Sheets sync error:', e.message));

    res.json({ success: true, file: { id: fileRef.id, fileName: file.originalname, fileUrl, fileType: file.mimetype, uploadedAt: fileDoc.uploadedAt } });
  } catch (err) {
    console.error('Student file upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

app.get('/api/student-files', verifyAuth, async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const access = await ensureParentOwnsStudent(req, studentId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const q = db.collection('student_files').where('studentId', '==', studentId);
    const snap = await q.get();
    const files = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    files.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    res.json({ files });
  } catch (err) {
    console.error('Get student files error:', err);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.get('/api/teacher/sendable-students', verifyAuth, async (req, res) => {
  try {
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    const role = req.userRole;
    const studentsSnap = await db.collection('students').where('schoolId', '==', schoolId).get();
    const allStudents = studentsSnap.docs.map(d => ({
      id: d.id,
      name: d.data().name || d.data().studentName || '',
      rollNumber: d.data().rollNumber || '',
      className: d.data().className || d.data().classId || 'Unknown',
    }));
    if (role === 'teacher') {
      const userDoc = await db.collection('users').doc(req.userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      const assignedClasses = userData.assignedClasses || [];
      const filtered = allStudents.filter(s => assignedClasses.includes(s.className));
      const grouped = {};
      for (const s of filtered) {
        if (!grouped[s.className]) grouped[s.className] = [];
        grouped[s.className].push({ id: s.id, name: s.name, rollNumber: s.rollNumber });
      }
      const classes = Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([className, students]) => ({ className, students }));
      return res.json({ classes });
    } else {
      const grouped = {};
      for (const s of allStudents) {
        if (!grouped[s.className]) grouped[s.className] = [];
        grouped[s.className].push({ id: s.id, name: s.name, rollNumber: s.rollNumber });
      }
      const classes = Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([className, students]) => ({ className, students }));
      classes.unshift({
        className: `All Classes (${allStudents.length} students)`,
        isAll: true,
        students: allStudents.map(s => ({ id: s.id, name: s.name })),
        studentCount: allStudents.length,
      });
      return res.json({ classes });
    }
  } catch (err) {
    console.error('Sendable students error:', err.message);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.post('/api/student-files/send', verifyAuth, async (req, res) => {
  try {
    const { studentIds, fileUrl, fileName, fileType, fileSize, message, senderName, senderRole } = req.body;
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: 'studentIds array required' });
    }
    if (!fileUrl || !fileName) return res.status(400).json({ error: 'fileUrl and fileName required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    if (req.userRole === 'teacher') {
      const userDoc = await db.collection('users').doc(req.userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      const assignedClasses = userData.assignedClasses || [];
      const studentsSnap = await db.collection('students').where('schoolId', '==', schoolId).get();
      const allowedIds = new Set(
        studentsSnap.docs
          .filter(d => assignedClasses.includes(d.data().className || d.data().classId))
          .map(d => d.id)
      );
      const unauthorized = studentIds.filter(id => !allowedIds.has(id));
      if (unauthorized.length > 0) {
        return res.status(403).json({ error: 'You do not have permission to send files to some of these students' });
      }
    }
    const now = new Date().toISOString();
    const CHUNK = 200;
    let count = 0;
    for (let i = 0; i < studentIds.length; i += CHUNK) {
      const batch = db.batch();
      const chunk = studentIds.slice(i, i + CHUNK);
      for (const studentId of chunk) {
        batch.set(doc(db.collection('student_files')), {
          studentId, fileUrl, fileName,
          fileType: fileType || 'application/octet-stream',
          fileSize: fileSize || 0,
          message: message || '',
          senderName: senderName || 'Teacher',
          senderRole: senderRole || 'teacher',
          schoolId, uploadedAt: now,
        });
        batch.set(doc(db.collection('parent_notifications')), {
          studentId,
          type: 'new_document',
          title: `New document from ${senderName || 'Teacher'}`,
          message: `${senderName || 'Teacher'} sent ${fileName} to your child`,
          fileUrl, fileName, schoolId,
          read: false, createdAt: now,
        });
        count++;
      }
      await batch.commit();
    }
    res.json({ success: true, sent: count });
  } catch (err) {
    console.error('Student files send error:', err.message);
    res.status(500).json({ error: 'Failed to send files' });
  }
});

async function lookupStudentById(studentId) {
  const sid = String(studentId || '').trim();
  if (!sid) return null;

  const byDocSnap = await db.collection('students').doc(sid).get();
  if (byDocSnap.exists) {
    return { id: byDocSnap.id, ...byDocSnap.data() };
  }

  const studentsQ = db.collection('students').where('studentId', '==', sid).limit(1);
  const snap = await studentsQ.get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function getParentAccount(uid) {
  const ref = db.collection('parent_accounts').doc(uid);
  const snap = await ref.get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function getParentAuthorizedStudentKeys(parentAccount) {
  const keys = new Set((parentAccount?.studentIds || []).map(id => String(id || '').trim()).filter(Boolean));
  for (const rawId of parentAccount?.studentIds || []) {
    const student = await lookupStudentById(rawId);
    if (!student) continue;
    if (student.id) keys.add(String(student.id));
    if (student.studentId) keys.add(String(student.studentId));
  }
  return keys;
}
async function ensureParentOwnsStudent(req, studentId) {
  if (req.userRole !== 'parent') return { ok: true };

  const parentAccount = await getParentAccount(req.userId);
  if (!parentAccount) {
    return { ok: false, status: 404, error: 'Parent account not found' };
  }

  const allowedStudentIds = await getParentAuthorizedStudentKeys(parentAccount);
  if (!allowedStudentIds.has(String(studentId || '').trim())) {
    return { ok: false, status: 403, error: 'You are not authorized to access this student' };
  }

  return { ok: true, parentAccount };
}
async function buildParentSession(parentAccount, schoolId) {
  const studentIds = parentAccount.studentIds || [];
  const activeStudentId = parentAccount.activeStudentId || studentIds[0] || '';
  let activeStudent = null;
  if (activeStudentId) activeStudent = await lookupStudentById(activeStudentId);
  const childrenData = [];
  for (const sid of studentIds) {
    const s = await lookupStudentById(sid);
    if (s) childrenData.push({ studentId: s.studentId, studentName: s.name || '', studentClass: s.className || s.classId || '', rollNumber: s.rollNumber || 0 });
  }
  return {
    role: 'parent',
    uid: parentAccount.uid,
    parentName: parentAccount.parentName || '',
    email: parentAccount.email || '',
    parentPhone: parentAccount.phone || '',
    studentId: activeStudent?.studentId || activeStudentId,
    studentName: activeStudent?.name || '',
    studentClass: activeStudent?.className || activeStudent?.classId || '',
    rollNumber: activeStudent?.rollNumber || 0,
    schoolId: activeStudent?.schoolId || schoolId || DEFAULT_SCHOOL_ID,
    studentIds,
    children: childrenData,
    hasPIN: !!parentAccount.pinHash,
    profileCompleted: true,
  };
}

app.get('/api/student/bus-tracking', verifyAuth, async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const access = await ensureParentOwnsStudent(req, studentId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    let studentData = {};
    let busRoute = '';
    let busNumber = '';
    let tripStatus = 'not_active';
    let tripStartTime = null;
    let boardedTime = null;
    let busLocation = null;
    let events = [];

    try {
      const studentSnap = await db.collection('users').doc(String(studentId)).get();
      if (studentSnap.exists) {
        studentData = studentSnap.data();
        busRoute = studentData.bus_route || '';
        busNumber = studentData.bus_number || '';
      } else {
        const byFieldQ = await db.collection('users').where('studentId', '==', String(studentId)).limit(1).get();
        if (!byFieldQ.empty) {
          studentData = byFieldQ.docs[0].data();
          busRoute = studentData.bus_route || '';
          busNumber = studentData.bus_number || '';
        } else {
          const studentsQ = await db.collection('students').where('studentId', '==', String(studentId)).limit(1).get();
          if (!studentsQ.empty) {
            studentData = studentsQ.docs[0].data();
            busRoute = studentData.busRoute || studentData.bus_route || '';
            busNumber = studentData.busNumber || studentData.bus_number || '';
          }
        }
      }
    } catch (e) {
      console.warn('Could not fetch student data:', e.message);
    }

    if (busNumber) {
      try {
        const activeQ = db.collection('live_bus_locations').where('busNumber', '==', busNumber).where('status', '==', 'active');
        const activeSnap = await activeQ.get();
        if (!activeSnap.empty) {
          const busData = activeSnap.docs[0].data();
          tripStatus = 'active';
          tripStartTime = busData.updatedAt || new Date().toISOString();
          busLocation = { lat: busData.lat, lng: busData.lng, speed: busData.speed, updatedAt: busData.updatedAt };
          events.push({ time: tripStartTime, event: 'Bus departed from school', icon: '🚌', done: true });
        }
      } catch (e) {
        console.warn('Could not fetch active trip:', e.message);
      }

      try {
        const scansQ = db.collection('trip_scans').where('studentId', '==', String(studentId)).orderBy('createdAt', 'desc').limit(1);
        const scansSnap = await scansQ.get();
        if (!scansSnap.empty) {
          const scanData = scansSnap.docs[0].data();
          boardedTime = scanData.createdAt || scanData.timestamp || new Date().toISOString();
          const timeStr = new Date(boardedTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          events.push({ time: timeStr, event: `${studentData.full_name || 'Child'} boarded the bus`, icon: '✅', done: true });
        }
      } catch (e) {
        console.warn('Could not fetch scan data:', e.message);
      }
    }

    if (!boardedTime) {
      events.push({ time: 'Pending', event: `${studentData.full_name || 'Child'} waiting to board`, icon: '⏳', done: false });
    }
    events.push({ time: '~Est. arrival', event: 'Arrival at home stop', icon: '🏠', done: false });
    events.push({ time: '~Est. dropoff', event: 'Deboarded', icon: '👋', done: false });

    // Calculate travel duration from boarding to arrival
    let travelDuration = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const scansQ = db.collection('trip_scans').where('studentId', '==', String(studentId)).where('date', '==', today).where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID));
      const scansSnap = await scansQ.get();
      const scans = scansSnap.docs.map(d => d.data()).sort((a, b) =>
        (a.timestamp || '').localeCompare(b.timestamp || '')
      );

      const boardScan = scans.find(s => s.type === 'board');
      const alightScan = scans.find(s => s.type === 'alight');

      if (boardScan && alightScan) {
        const boardMs = new Date(boardScan.timestamp).getTime();
        const alightMs = new Date(alightScan.timestamp).getTime();
        const diffMin = Math.round((alightMs - boardMs) / 60000);
        travelDuration = {
          minutes: diffMin,
          boardTime: boardScan.timestamp,
          alightTime: alightScan.timestamp,
          label: `${diffMin} min`
        };
      } else if (boardScan) {
        travelDuration = {
          minutes: null,
          boardTime: boardScan.timestamp,
          alightTime: null,
          label: 'In transit'
        };
      }
    } catch (durErr) {
      console.error('[Bus Tracking] Duration calc error:', durErr.message);
    }

    res.json({
      success: true,
      studentId: String(studentId),
      studentName: studentData.full_name || studentData.name || 'Student',
      busNumber: busNumber,
      busRoute: busRoute,
      tripStatus: tripStatus,
      tripStartTime: tripStartTime,
      boardedTime: boardedTime,
      busLocation: busLocation,
      events: events,
      travelDuration: travelDuration,
    });
  } catch (err) {
    console.error('Bus tracking error:', err.message);
    res.status(500).json({ error: 'Failed to get bus tracking data' });
  }
});

app.get('/api/parent/check-student', async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const sid = studentId.trim();
    const studentData = await lookupStudentById(sid);
    if (!studentData) return res.status(404).json({ error: 'Invalid Student ID. Please check your school ID card.' });
    const existingQ = db.collection('parent_accounts').where('studentIds', 'array-contains', sid);
    const existingSnap = await existingQ.get();
    if (!existingSnap.empty) return res.status(409).json({ error: 'An account already exists for this Student ID. Please login instead.' });
    res.json({ success: true, studentName: studentData.name || '', studentClass: studentData.className || '', rollNumber: studentData.rollNumber || 0, hasParentPhone: !!studentData.parentPhone });
  } catch (err) {
    console.error('Check student error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/register', registerLimiter, async (req, res) => {
  try {
    const { studentId, parentName, email: rawEmail, phone, password, pin } = req.body;
    const email = (rawEmail || '').trim().toLowerCase();
    const sid = (studentId || '').trim();
    if (!sid || !parentName || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[0-9]/.test(password)) return res.status(400).json({ error: 'Password must contain at least one number' });
    if (!/[^a-zA-Z0-9]/.test(password)) return res.status(400).json({ error: 'Password must contain at least one special character' });
    const studentData = await lookupStudentById(sid);
    if (!studentData) return res.status(404).json({ error: 'Invalid Student ID. Please check your school ID card.' });
    if (studentData.parentPhone) {
      const storedPhone = String(studentData.parentPhone).replace(/\D/g, '');
      const enteredPhone = String(phone).replace(/\D/g, '');
      if (storedPhone && enteredPhone !== storedPhone) {
        return res.status(400).json({ error: 'Phone number does not match school records. Please contact Admin.' });
      }
    }
    const existingQ = db.collection('parent_accounts').where('studentIds', 'array-contains', sid);
    const existingSnap = await existingQ.get();
    if (!existingSnap.empty) return res.status(409).json({ error: 'An account already exists for this Student ID. Please login instead.' });
    let userCredential;
    try {
      userCredential = await adminAuth.createUser({ email: email, password: password });
    } catch (authErr) {
      const map = { 'auth/email-already-in-use': 'This email is already registered. Please login instead.', 'auth/invalid-email': 'Invalid email address', 'auth/weak-password': 'Password is too weak' };
      return res.status(409).json({ error: map[authErr.code] || authErr.message });
    }
    const uid = userCredential.uid;
    let pinHash = null;
    if (pin && /^\d{4}$/.test(String(pin).trim())) pinHash = await bcrypt.hash(String(pin).trim(), 10);
    const studentSchoolId = studentData.schoolId || (req.schoolId || DEFAULT_SCHOOL_ID);
    const accountData = { uid, parentName: parentName.trim(), email, phone: String(phone).replace(/\D/g, ''), studentIds: [sid], activeStudentId: sid, pinHash, emailVerified: false, accountStatus: 'active', failedAttempts: 0, lockUntil: null, createdAt: new Date().toISOString(), lastLogin: null, schoolId: studentSchoolId };
    await db.collection('parent_accounts').doc(uid).set(accountData);
    try {
      const signInForVerify = await firebaseSignIn(email, password);
      const idToken = await signInForVerify.user.getIdToken();
      const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken }) });
      console.log(`Verification email sent to ${email}:`, verifyRes.status);
    } catch (emailErr) { console.error('Verification email error:', emailErr.message); }
    console.log(`Parent registered: ${email} | Student: ${sid}`);
    res.json({ success: true, message: 'Account created! Please check your email to verify your account.', uid, emailVerificationSent: true });
    safeSync('syncParentAccount', () => syncParentAccount({ parentId: uid, parentName: parentName.trim(), email, phone: String(phone).replace(/\D/g, ''), linkedStudentId: sid, studentName: studentData.name || '', studentClass: studentData.className || '', registeredAt: accountData.createdAt, accountStatus: 'active' }), { uid, sid }).catch(() => {});
  } catch (err) {
    console.error('Parent register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/parent/email-login', loginLimiter, async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body;
    const email = (rawEmail || '').trim().toLowerCase();
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const accountQ = db.collection('parent_accounts').where('email', '==', email);
    const accountSnap = await accountQ.get();
    let parentDoc, parentAccount;
    if (accountSnap.empty) {
      const usersQ = db.collection('users').where('email', '==', email).where('role', '==', 'parent');
      const usersSnap = await usersQ.get();
      if (usersSnap.empty) return res.status(404).json({ error: 'No account found with this email. Please register first.' });
      const userDoc = usersSnap.docs[0];
      const userData = userDoc.data();
      const studentIds = userData.studentIds || (userData.studentId ? [userData.studentId] : []);
      const paData = {
        uid: userData.uid,
        parentName: userData.parentName || userData.full_name || '',
        email: userData.email || email,
        phone: userData.phone || '',
        studentIds,
        activeStudentId: studentIds[0] || '',
        accountStatus: userData.accountStatus || 'active',
        emailVerified: false,
        failedAttempts: 0,
        lockUntil: null,
        pinHash: null,
        createdAt: userData.created_at || new Date().toISOString(),
        lastLogin: null,
        schoolId: userData.schoolId || req.schoolId || DEFAULT_SCHOOL_ID,
      };
      const paRef = await db.collection('parent_accounts').add(paData);
      parentDoc = { id: paRef.id, data: () => paData };
      parentAccount = { id: paRef.id, ...paData };
      console.log(`Migrated parent ${email} from users → parent_accounts`);
    } else {
      parentDoc = accountSnap.docs[0];
      parentAccount = { id: parentDoc.id, ...parentDoc.data() };
      const resolvedSchoolId = parentAccount.schoolId || req.schoolId || DEFAULT_SCHOOL_ID;
      if (parentAccount.schoolId !== resolvedSchoolId) {
        await db.collection('parent_accounts').doc(parentDoc.id).update({ schoolId: resolvedSchoolId });
        parentAccount.schoolId = resolvedSchoolId;
      }
    }
    if (parentAccount.accountStatus === 'disabled') return res.status(403).json({ error: 'Your account has been disabled. Please contact the school admin.' });
    if (parentAccount.lockUntil) {
      const lockTime = new Date(parentAccount.lockUntil);
      if (new Date() < lockTime) {
        const mins = Math.ceil((lockTime - new Date()) / 60000);
        return res.status(429).json({ error: `Account locked. Try again in ${mins} minute(s).` });
      }
      await db.collection('parent_accounts').doc(parentDoc.id).update({ lockUntil: null, failedAttempts: 0, accountStatus: 'active' });
      parentAccount.lockUntil = null; parentAccount.failedAttempts = 0;
    }
    let userCredential;
    try {
      userCredential = await firebaseSignIn(email, password);
    } catch (authErr) {
      const attempts = (parentAccount.failedAttempts || 0) + 1;
      const updates = { failedAttempts: attempts };
      if (attempts >= 5) { updates.lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString(); updates.accountStatus = 'locked'; }
      await db.collection('parent_accounts').doc(parentDoc.id).update(updates);
      if (attempts >= 5) return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      if (authErr.code === 'auth/wrong-password' || authErr.code === 'auth/invalid-credential') return res.status(401).json({ error: `Incorrect password. ${5 - attempts} attempt(s) remaining before lockout.` });
      return res.status(401).json({ error: 'Invalid credentials. Please try again.' });
    }
    await db.collection('parent_accounts').doc(parentDoc.id).update({ failedAttempts: 0, lockUntil: null, accountStatus: 'active', lastLogin: new Date().toISOString() });
    parentAccount.accountStatus = 'active';
    const sessionUser = await buildParentSession(parentAccount, req.schoolId || DEFAULT_SCHOOL_ID);
    console.log(`Parent login: ${email} | Students: ${parentAccount.studentIds?.join(', ')}`);
    const jwtToken = signToken({
      userId: parentDoc.id,
      role: 'parent',
      schoolId: parentAccount.schoolId || DEFAULT_SCHOOL_ID,
      phone: parentAccount.phone
    });

    res.json({ token: jwtToken, success: true, user: sessionUser, emailVerified: userCredential.user.emailVerified });
  } catch (err) {
    console.error('Parent email-login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/parent/forgot-password', loginLimiter, async (req, res) => {
  try {
    const { email: rawEmail } = req.body;
    const email = (rawEmail || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    await (async () => {
    const apiKey = process.env.FIREBASE_API_KEY;
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: email }),
    });
  })();
    res.json({ success: true, message: 'Password reset link sent! Check your email.' });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    if (err.code === 'auth/user-not-found') return res.status(404).json({ error: 'No account found with this email.' });
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
});

app.post('/api/parent/add-child', async (req, res) => {
  try {
    const { uid, studentId, phone } = req.body;
    if (!uid || !studentId) return res.status(400).json({ error: 'uid and studentId required' });
    const sid = studentId.trim();
    const parentAccount = await getParentAccount(uid);
    if (!parentAccount) return res.status(404).json({ error: 'Parent account not found' });
    if ((parentAccount.studentIds || []).includes(sid)) return res.status(409).json({ error: 'This student is already linked to your account.' });
    const studentData = await lookupStudentById(sid);
    if (!studentData) return res.status(404).json({ error: 'Invalid Student ID. Please check and try again.' });
    if (studentData.schoolId && req.schoolId && studentData.schoolId !== req.schoolId) {
      return res.status(403).json({ error: 'Student not found in your school' });
    }
    if (studentData.parentPhone) {
      if (!phone) return res.status(400).json({ error: 'Phone number is required to link this student.' });
      const storedPhone = String(studentData.parentPhone).replace(/\D/g, '');
      const enteredPhone = String(phone).replace(/\D/g, '');
      if (storedPhone && enteredPhone !== storedPhone) return res.status(400).json({ error: 'Phone number does not match school records for this student.' });
    }
    const existingQ = db.collection('parent_accounts').where('studentIds', 'array-contains', sid);
    const existingSnap = await existingQ.get();
    if (!existingSnap.empty) return res.status(409).json({ error: 'This Student ID is already linked to another parent account.' });
    const newStudentIds = [...(parentAccount.studentIds || []), sid];
    await db.collection('parent_accounts').doc(uid).update({ studentIds: newStudentIds });
    res.json({ success: true, studentName: studentData.name || '', studentClass: studentData.className || '', newStudentIds });
  } catch (err) {
    console.error('Add child error:', err.message);
    res.status(500).json({ error: 'Failed to add child. Please try again.' });
  }
});

app.post('/api/parent/switch-child', async (req, res) => {
  try {
    const { uid, studentId } = req.body;
    if (!uid || !studentId) return res.status(400).json({ error: 'uid and studentId required' });
    const parentAccount = await getParentAccount(uid);
    if (!parentAccount) return res.status(404).json({ error: 'Account not found' });
    if (!(parentAccount.studentIds || []).includes(studentId)) return res.status(400).json({ error: 'Student not linked to this account' });
    await db.collection('parent_accounts').doc(uid).update({ activeStudentId: studentId });
    parentAccount.activeStudentId = studentId;
    const sessionUser = await buildParentSession(parentAccount, req.schoolId || DEFAULT_SCHOOL_ID);
    res.json({ success: true, user: sessionUser });
  } catch (err) {
    console.error('Switch child error:', err.message);
    res.status(500).json({ error: 'Failed to switch child' });
  }
});

app.get('/api/admin/parent-accounts', async (req, res) => {
  try {
    const snap = await db.collection('parent_accounts').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    const accounts = snap.docs.map(d => {
      const data = d.data();
      return { id: d.id, uid: data.uid, parentName: data.parentName || '', email: data.email || '', phone: data.phone || '', studentIds: data.studentIds || [], accountStatus: data.accountStatus || 'pending_verification', emailVerified: data.emailVerified || false, createdAt: data.createdAt || '', lastLogin: data.lastLogin || null, hasPIN: !!data.pinHash };
    });
    accounts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ accounts });
  } catch (err) {
    console.error('Admin parent-accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/parent-accounts/:uid/status', async (req, res) => {
  try {
    const { uid } = req.params;
    const { action, status } = req.body;
    const updates = {};
    const resolved = action || status;
    if (resolved === 'activate' || resolved === 'active') updates.accountStatus = 'active';
    else if (resolved === 'disable' || resolved === 'disabled' || resolved === 'suspended') updates.accountStatus = 'suspended';
    else if (resolved === 'reset-attempts') { updates.failedAttempts = 0; updates.lockUntil = null; updates.accountStatus = 'active'; }
    else return res.status(400).json({ error: 'Invalid action. Use: active, suspended, or reset-attempts' });
    await db.collection('parent_accounts').doc(uid).update(updates);
    res.json({ success: true, accountStatus: updates.accountStatus });
  } catch (err) {
    console.error('Admin update parent status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance/student-monthly', verifyAuth, async (req, res) => {
  try {
    const { studentId, month } = req.query;
    if (!studentId || !month) return res.status(400).json({ error: 'studentId and month required' });
    const access = await ensureParentOwnsStudent(req, studentId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();

    // Build working days list (Mon–Sat, skip Sunday)
    const workingDays = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dow = new Date(dateStr + 'T12:00:00').getDay();
      if (dow !== 0) workingDays.push(dateStr);
    }

    const recordMap = {};

    // ── FAST PATH: read from student_attendance subcollection ──
    try {
      const studentAttSnap = await db.collection('student_attendance').doc(studentId).collection('dates').get();
      if (!studentAttSnap.empty) {
        studentAttSnap.docs.forEach(d => {
          const data = d.data();
          // Only include dates that belong to requested month
          if (d.id.startsWith(month)) {
            recordMap[d.id] = data.status;
          }
        });
        console.log(`[student_attendance] Fast path: ${studentAttSnap.size} docs for student ${studentId} month ${month}`);
      }
    } catch (fastErr) {
      console.warn('[student_attendance] Fast path failed, falling back:', fastErr.message);
    }

    // ── FALLBACK: if fast path returned nothing, read from legacy attendance_records ──
    if (Object.keys(recordMap).length === 0) {
      console.log(`[attendance_records] Fallback path for student ${studentId} month ${month}`);
      const q = db.collection('attendance_records').where('studentId', '==', studentId).where('month', '==', month);
      const snap = await q.get();
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.date) recordMap[data.date] = data.status;
      });
      console.log(`[attendance_records] Fallback returned ${snap.size} records`);
    }

    const days = workingDays.map(date => ({
      date,
      status: recordMap[date] || 'Not Marked',
    }));

    const present = days.filter(d => d.status === 'Present').length;
    const absent = days.filter(d => d.status === 'Absent').length;
    const leave = days.filter(d => d.status === 'Leave').length;
    const total = workingDays.length;
    const markedDays = days.filter(d => d.status !== 'Not Marked').length;
    const pct = markedDays > 0 ? Math.round((present / markedDays) * 100) : 0;

    res.json({ success: true, days, summary: { present, absent, leave, total, markedDays, pct }, month });
  } catch (err) {
    console.error('Student monthly attendance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/parent-notifications', verifyAuth, async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const access = await ensureParentOwnsStudent(req, studentId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const [snap1, snap2] = await Promise.all([
      db.collection('parent_notifications').where('studentId', '==', studentId).get(),
      db.collection('parent_notifications').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('forAll', '==', true).get(),
    ]);
    const seen = new Set();
    const notifications = [];
    for (const d of [...snap1.docs, ...snap2.docs]) {
      if (!seen.has(d.id)) { seen.add(d.id); notifications.push({ id: d.id, ...d.data() }); }
    }
    notifications.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ notifications });
  } catch (err) {
    console.error('Get parent notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/parent-notifications/read', verifyAuth, async (req, res) => {
  try {
    const { notificationIds } = req.body;
    if (!notificationIds || !Array.isArray(notificationIds)) return res.status(400).json({ error: 'notificationIds array required' });
    const batch = db.batch();
    for (const nId of notificationIds) {
      batch.update(db.collection('parent_notifications').doc(nId), { read: true });
    }
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    console.error('Mark notifications read error:', err);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const tokenDoc = await adminDb
      .collection('fcm_tokens')
      .doc(userId)
      .get();
    if (!tokenDoc.exists) return;
    const token = tokenDoc.data().token;
    if (!token) return;

    const message = {
      to: token,
      sound: 'default',
      title,
      body,
      data,
    };

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

async function sendPushToAdmins(schoolId, title, body, data = {}) {
  try {
    const effSchoolId = schoolId || DEFAULT_SCHOOL_ID;
    const adminSnap = await db.collection('users')
      .where('schoolId', '==', effSchoolId)
      .where('role', 'in', ['admin', 'principal'])
      .get();
    await Promise.all(adminSnap.docs.map(async d => {
      const uid = d.data().uid || d.data().role_id || '';
      if (uid) sendPushNotification(uid, title, body, data);
    }));
  } catch (e) {
    console.error('[sendPushToAdmins] Error:', e.message);
  }
}

async function sendEventNotifications(eventId, title, date, time, venue, type, forClasses, description, prefix, schoolId) {
  const effSchoolId = schoolId || DEFAULT_SCHOOL_ID;
  const now = new Date().toISOString();
  const msg = `${date}${time ? ' at ' + time : ''}${venue ? ' \u00B7 ' + venue : ''}${description ? ' \u00B7 ' + description : ''}`;
  const notifTitle = prefix ? `${prefix}: ${title}` : `New Event: ${title}`;
  const isAll = !forClasses || forClasses.toLowerCase() === 'all classes';

const driverTypes = ['Holiday', 'Cultural', 'Academic', 'Meeting'];
  let teacherCount = 0, parentCount = 0, driverCount = 0;

  if (isAll) {
    const teachersSnap = await db.collection('users').where('schoolId', '==', effSchoolId).where('role', 'in', ['teacher', 'staff']).get();
    for (const d of teachersSnap.docs) {
      const t = d.data();
      if (t.role_id) {
        await db.collection('teacher_notifications').add({ roleId: t.role_id, eventId, type: 'event', title: notifTitle, message: msg, eventType: type, schoolId: effSchoolId, read: false, createdAt: now });
        teacherCount++;
      }
    }
    await db.collection('parent_notifications').add({ eventId, type: 'event', title: notifTitle, message: msg, eventType: type, forAll: true, schoolId: effSchoolId, read: false, createdAt: now });
    parentCount = -1;

    if (driverTypes.includes(type)) {
      const driversSnap = await db.collection('users').where('schoolId', '==', effSchoolId).where('role', '==', 'driver').get();
      for (const d of driversSnap.docs) {
        const dr = d.data();
        if (dr.role_id) {
          await db.collection('driver_notifications').add({ driverId: dr.role_id, eventId, type: 'event', title: notifTitle, message: msg, eventType: type, schoolId: effSchoolId, read: false, createdAt: now });
          driverCount++;
        }
      }
    }
  } else {
    const classList = forClasses.split(',').map(s => s.trim()).filter(Boolean);
    for (const cls of classList) {
      const teacherSnap = await db.collection('users').where('schoolId', '==', effSchoolId).where('classTeacherOf', '==', cls).get();
      for (const d of teacherSnap.docs) {
        const t = d.data();
        if (t.role_id) {
          await db.collection('teacher_notifications').add({ roleId: t.role_id, eventId, type: 'event', title: notifTitle, message: msg, eventType: type, forClass: cls, schoolId: effSchoolId, read: false, createdAt: now });
          teacherCount++;
        }
      }
      const studentsSnap = await db.collection('students').where('schoolId', '==', effSchoolId).where('className', '==', cls).get();
      for (const sd of studentsSnap.docs) {
        const s = sd.data();
        const studentIdVal = s.studentId || sd.id;
        await db.collection('parent_notifications').add({ studentId: studentIdVal, eventId, type: 'event', title: notifTitle, message: msg, eventType: type, forClass: cls, schoolId: effSchoolId, read: false, createdAt: now });
        parentCount++;
      }
    }
  }
  return { teacherCount, parentCount, driverCount };
}

app.get('/api/events', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection('events').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get();
    const events = snap.docs.map(d => {
      const data = d.data();
      const status = data.date && data.date < today ? 'Done' : 'Upcoming';
      return { id: d.id, ...data, status };
    });
    events.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ events });
  } catch (err) {
    console.error('Get events error:', err.message);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/events/create', async (req, res) => {
  try {
    const { title, date, time, venue, forClasses, type, description, createdBy } = req.body;
    if (!title || !date) return res.status(400).json({ error: 'title and date are required' });
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const status = date < today ? 'Done' : 'Upcoming';
    const eventRef = await db.collection('events').add({
      title, date, time: time || '', venue: venue || '', forClasses: forClasses || 'All Classes',
      type: type || 'Academic', description: description || '', createdBy: createdBy || 'Admin',
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      createdAt: now, status,
    });
    console.log(`Event created: ${title} on ${date} for ${forClasses}`);
    const notified = await sendEventNotifications(eventRef.id, title, date, time, venue, type, forClasses, description, null, (req.schoolId || DEFAULT_SCHOOL_ID));
    res.json({ success: true, eventId: eventRef.id, notified });
  } catch (err) {
    console.error('Create event error:', err.message);
    res.status(500).json({ error: 'Failed to create event: ' + err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, date, time, venue, forClasses, type, description, updatedBy } = req.body;
    if (!title || !date) return res.status(400).json({ error: 'title and date are required' });
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const status = date < today ? 'Done' : 'Upcoming';
    await db.collection('events').doc(id).update({
      title, date, time: time || '', venue: venue || '', forClasses: forClasses || 'All Classes',
      type: type || 'Academic', description: description || '', updatedBy: updatedBy || 'Admin',
      updatedAt: now, status,
    });
    const notified = await sendEventNotifications(id, title, date, time, venue, type, forClasses, description, 'Event Updated', (req.schoolId || DEFAULT_SCHOOL_ID));
    res.json({ success: true, notified });
  } catch (err) {
    console.error('Update event error:', err.message);
    res.status(500).json({ error: 'Failed to update event: ' + err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const eventSnap = await db.collection('events').doc(id).get();
    if (!eventSnap.exists) return res.status(404).json({ error: 'Event not found' });
    const ev = eventSnap.data();
    await sendEventNotifications(id, ev.title, ev.date, ev.time, ev.venue, ev.type, ev.forClasses, '', `Event Cancelled: ${ev.title} scheduled for ${ev.date} has been cancelled`, (req.schoolId || DEFAULT_SCHOOL_ID));
    await db.collection('events').doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete event error:', err.message);
    res.status(500).json({ error: 'Failed to delete event: ' + err.message });
  }
});

app.post('/api/events/:id/renotify', async (req, res) => {
  try {
    const { id } = req.params;
    const eventSnap = await db.collection('events').doc(id).get();
    if (!eventSnap.exists) return res.status(404).json({ error: 'Event not found' });
    const ev = eventSnap.data();
    const notified = await sendEventNotifications(id, ev.title, ev.date, ev.time, ev.venue, ev.type, ev.forClasses, ev.description, 'Reminder', (req.schoolId || DEFAULT_SCHOOL_ID));
    res.json({ success: true, notified });
  } catch (err) {
    console.error('Renotify event error:', err.message);
    res.status(500).json({ error: 'Failed to renotify: ' + err.message });
  }
});

app.post('/api/holiday/sudden', verifyAuth, async (req, res) => {
  try {
    const { date, reason, schoolId: bSchoolId } = req.body;
    const schoolId = bSchoolId || req.schoolId || DEFAULT_SCHOOL_ID;
    if (!date) return res.status(400).json({ error: 'Date is required' });

    // 1. Create holiday record
    await db.collection('sudden_holidays').add({
      date, reason: reason || 'Not specified', schoolId,
      createdBy: req.userId, createdAt: new Date().toISOString()
    });

    // 2. Fetch all students to mark holiday
    const studentsSnap = await db.collection('students').where('schoolId', '==', schoolId).get();
    const batch = db.batch();
    studentsSnap.docs.forEach(doc => {
      const s = doc.data();
      const attendanceRef = db.collection('attendance_records').doc(`${s.studentId}_${date}`);
      batch.set(attendanceRef, {
        studentId: s.studentId,
        studentName: s.name || s.fullName || '',
        classId: s.classId || s.className || 'Unknown',
        date,
        status: 'Holiday',
        remarks: reason || 'Sudden Holiday',
        schoolId,
        updatedAt: new Date().toISOString()
      });
    });
    if (!studentsSnap.empty) await batch.commit();

    // 3. Notify Teachers (FCM)
    const teachers = await db.collection('users')
      .where('schoolId', '==', schoolId)
      .where('role', '==', 'teacher').get();
    
    res.json({ 
      success: true, 
      message: `Holiday declared for ${date}. Auto-marked ${studentsSnap.size} students. Notifications triggered for ${teachers.size} teachers.` 
    });
  } catch (err) {
    res.status(500).json({ error: 'Holiday system error: ' + err.message });
  }
});

const { generateReport } = require('../src/report/generateReport');

app.get('/api/report/master-audit', verifyAuth, (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const buffers = [];
    doc.on('data', d => buffers.push(d));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="Sree-Pragathi-Master-Audit-Report.pdf"');
      res.send(pdfData);
    });

    const C_NAVY = '#0A1628';
    const C_GOLD = '#D4A843';
    const C_TEAL = '#2DD4BF';
    const C_WHITE = '#FFFFFF';
    const C_MUTED = '#8B95A5';
    const C_CORAL = '#FF6B6B';
    const C_PURPLE = '#A78BFA';
    const C_GREEN = '#34D399';
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    const drawLine = (y, color = '#334155') => {
      doc.moveTo(50, y).lineTo(545, y).strokeColor(color).lineWidth(0.5).stroke();
    };

    const newPage = () => {
      doc.addPage();
      doc.rect(0, 0, 595, 842).fill(C_NAVY);
    };

    const sectionTitle = (title, icon) => {
      if (doc.y > 680) newPage();
      doc.moveDown(0.8);
      doc.fontSize(14).fillColor(C_GOLD).text(`${icon}  ${title}`, { underline: false });
      drawLine(doc.y + 4, C_GOLD);
      doc.moveDown(0.6);
    };

    const bulletPoint = (text, indent = 60) => {
      if (doc.y > 720) newPage();
      doc.fontSize(9.5).fillColor('#CBD5E1').text(`•  ${text}`, indent, doc.y, { width: 495 - indent });
      doc.moveDown(0.15);
    };

    const subHeading = (text) => {
      if (doc.y > 700) newPage();
      doc.moveDown(0.4);
      doc.fontSize(11).fillColor(C_TEAL).text(text);
      doc.moveDown(0.25);
    };

    const statusBadge = (label, color) => {
      const x = doc.x;
      const y = doc.y;
      doc.roundedRect(x, y, 80, 16, 4).fill(color);
      doc.fontSize(8).fillColor(C_WHITE).text(label, x + 8, y + 3, { width: 64, align: 'center' });
      doc.y = y + 22;
    };

    // ── COVER PAGE ──
    doc.rect(0, 0, 595, 842).fill(C_NAVY);
    doc.fontSize(10).fillColor(C_MUTED).text('CONFIDENTIAL', 50, 50, { align: 'right' });
    doc.moveDown(6);
    doc.fontSize(32).fillColor(C_GOLD).text('MASTER AUDIT REPORT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor(C_WHITE).text('Sree Pragathi High School', { align: 'center' });
    doc.fontSize(11).fillColor(C_MUTED).text('Gopalraopet, Telangana', { align: 'center' });
    doc.moveDown(1);
    drawLine(doc.y, C_GOLD);
    doc.moveDown(1);
    doc.fontSize(11).fillColor(C_MUTED).text('School Management SaaS Platform', { align: 'center' });
    doc.fontSize(10).fillColor(C_MUTED).text(`School Code: SP-GOPA  |  School ID: school_001`, { align: 'center' });
    doc.moveDown(3);
    doc.fontSize(10).fillColor(C_TEAL).text(`Generated: ${dateStr}`, { align: 'center' });
    doc.fontSize(9).fillColor(C_MUTED).text('Vidhaya Layam — Education Technology Platform', { align: 'center' });

    // ── PAGE 2: TABLE OF CONTENTS ──
    newPage();
    doc.fontSize(18).fillColor(C_GOLD).text('TABLE OF CONTENTS', 50, 50);
    drawLine(doc.y + 6, C_GOLD);
    doc.moveDown(1);
    const tocItems = [
      '1.  Executive Summary',
      '2.  Technology Stack',
      '3.  Architecture Overview',
      '4.  User Roles & Authentication',
      '5.  Screen Inventory (All Portals)',
      '6.  API Endpoints Summary',
      '7.  Feature Upgrades — Complete List',
      '8.  Security & Rate Limiting',
      '9.  Multi-Tenant SaaS Architecture',
      '10. Data Models & Collections',
      '11. UX & Error Handling System',
      '12. Deployment & Infrastructure',
    ];
    tocItems.forEach(item => {
      doc.fontSize(11).fillColor('#CBD5E1').text(item, 70);
      doc.moveDown(0.4);
    });

    // ── SECTION 1: EXECUTIVE SUMMARY ──
    newPage();
    sectionTitle('EXECUTIVE SUMMARY', '\u{1F4CB}');
    doc.fontSize(10).fillColor('#CBD5E1').text(
      'Sree Pragathi High School Management App is a comprehensive, multi-tenant SaaS platform built to digitize and streamline all school operations. The platform serves five distinct user roles through dedicated dashboards, covering academics, transportation, facilities, finance, and administration.',
      50, doc.y, { width: 495, lineGap: 3 }
    );
    doc.moveDown(0.8);

    subHeading('Platform Statistics');
    const stats = [
      ['Total Screens', '40+'],
      ['API Endpoints', '149'],
      ['User Roles', '5 (Admin/Principal, Teacher, Parent, Driver, Cleaner)'],
      ['Firestore Collections', '35+'],
      ['Components', '9 shared UI components'],
      ['Composite Indexes', '19'],
    ];
    stats.forEach(([label, value]) => {
      doc.fontSize(9.5).fillColor(C_MUTED).text(`${label}:`, 60, doc.y, { continued: true, width: 150 });
      doc.fillColor(C_WHITE).text(`  ${value}`, { width: 330 });
      doc.moveDown(0.1);
    });

    // ── SECTION 2: TECHNOLOGY STACK ──
    sectionTitle('TECHNOLOGY STACK', '\u{1F527}');
    const stack = [
      ['Frontend', 'React Native (Expo SDK 52) — Web + Mobile'],
      ['Backend', 'Express.js (Node.js) — RESTful API'],
      ['Database', 'Firebase Firestore (project: school-app-87900)'],
      ['Authentication', 'Firebase Auth (Email/Password) + JWT (30-day tokens)'],
      ['PDF Generation', 'PDFKit — Report cards, audit reports'],
      ['Real-time Sync', 'Google Sheets API — Attendance, marks, payroll, timetable'],
      ['Maps', 'Leaflet.js — Bus live tracking on web'],
      ['Error Tracking', 'Custom Firestore-based alerting system'],
      ['Rate Limiting', 'express-rate-limit — Global + per-route limits'],
    ];
    stack.forEach(([label, value]) => {
      doc.fontSize(9.5).fillColor(C_TEAL).text(`${label}:`, 60, doc.y, { continued: true, width: 120 });
      doc.fillColor('#CBD5E1').text(`  ${value}`, { width: 365 });
      doc.moveDown(0.15);
    });

    // ── SECTION 3: ARCHITECTURE ──
    sectionTitle('ARCHITECTURE OVERVIEW', '\u{1F3D7}');
    bulletPoint('Single Express.js server serves both API and static Expo web build');
    bulletPoint('Frontend built with `npx expo export --platform web` → static dist/ folder');
    bulletPoint('Server runs on port 5000, serves dist/ as static files');
    bulletPoint('All API routes under /api/* with global auth guard middleware');
    bulletPoint('Firebase Admin SDK for server-side Firestore access + Auth management');
    bulletPoint('Firebase Client SDK for frontend Auth (email/password)');
    bulletPoint('JWT Bearer tokens for API authorization (30-day expiry)');
    bulletPoint('Multi-tenant isolation via schoolId on every query and write');

    // ── SECTION 4: AUTH & ROLES ──
    sectionTitle('USER ROLES & AUTHENTICATION', '\u{1F512}');
    const roles = [
      ['Admin/Principal', 'Full platform access — manage users, classes, fees, reports, settings, promotions, salary, buses, leaves, activities, alerts'],
      ['Teacher', 'Attendance marking, marks entry, schedule management, bus monitoring, leave requests, personal profile'],
      ['Parent', 'View child attendance, marks, bus tracking, fee payments, notifications, leave requests, digital folder, report cards'],
      ['Driver', 'Trip management (start/end with GPS), student pickup stops, proximity alerts, duty clock in/out, leave requests'],
      ['Cleaner', 'QR student scanning, zone/phase duty tracking, alerts, duration logging, leave requests'],
    ];
    roles.forEach(([role, desc]) => {
      doc.fontSize(10).fillColor(C_GOLD).text(role, 60, doc.y);
      doc.fontSize(9).fillColor('#94A3B8').text(desc, 60, doc.y, { width: 475 });
      doc.moveDown(0.4);
    });
    doc.moveDown(0.3);
    subHeading('Authentication Flow');
    bulletPoint('Login → Firebase Auth verification → JWT token issued → stored in AsyncStorage');
    bulletPoint('Every API call sends Authorization: Bearer <token> header');
    bulletPoint('verifyAuth middleware decodes JWT, sets req.userId, req.userRole, req.schoolId');
    bulletPoint('Parent portal: additional PIN verification layer before dashboard access');
    bulletPoint('Admin routes: verifyAuth + role check (principal/admin only)');
    bulletPoint('Super Admin routes: separate x-super-admin-key header validation');

    // ── SECTION 5: SCREEN INVENTORY ──
    newPage();
    sectionTitle('SCREEN INVENTORY — ALL PORTALS', '\u{1F4F1}');

    subHeading('Authentication Screens (7)');
    ['SplashScreen', 'SplashIntroScreen', 'LoginScreen', 'SignupScreen', 'ParentLoginScreen', 'ParentRegisterScreen', 'ParentPinScreen'].forEach(s => bulletPoint(s));

    subHeading('Admin / Principal Portal (17)');
    ['AdminOverview (Dashboard)', 'AdminUsers', 'AdminClasses', 'AdminStudents', 'AdminBuses', 'AdminReports', 'AdminAlerts', 'AdminSettings', 'AdminActivities', 'AdminLeaveScreen', 'AdminFeeScreen', 'AdminFeeStatus (Bulk Fee Dashboard)', 'AdminSalaryScreen', 'AdminPromotion (Year-End Wizard)', 'AdminStudentQR', 'AdminProfile', 'CompleteProfileScreen'].forEach(s => bulletPoint(s));

    subHeading('Teacher Portal (8)');
    ['TeacherDashboard', 'TeacherAttendance', 'TeacherMarksScreen', 'TeacherScheduleScreen', 'TeacherBusMonitor', 'TeacherAlertsScreen', 'TeacherPersonalScreen', 'TeacherProfile'].forEach(s => bulletPoint(s));

    subHeading('Parent Portal (9)');
    ['ParentDashboard', 'AttendanceScreen', 'MarksScreen (+ Report Card PDF)', 'BusScreen (Live Tracking)', 'FeeScreen', 'NotificationsScreen', 'LeaveScreen', 'DigitalFolder', 'ActivitiesScreen'].forEach(s => bulletPoint(s));

    subHeading('Driver Portal (7)');
    ['DriverDashboard (Trip + GPS)', 'DriverScans', 'DriverStudentLocations', 'DriverProximityAlerts', 'DriverDuration', 'DriverLeave', 'DriverProfile'].forEach(s => bulletPoint(s));

    subHeading('Cleaner Portal (6)');
    ['CleanerDashboard', 'CleanerScanner (QR)', 'CleanerAlerts', 'CleanerDuration', 'CleanerLeave', 'CleanerProfile'].forEach(s => bulletPoint(s));

    subHeading('Shared Screens (2)');
    ['ExploreScreen (School Info & Gallery)', 'ContactScreen'].forEach(s => bulletPoint(s));

    // ── SECTION 6: API ENDPOINTS SUMMARY ──
    newPage();
    sectionTitle('API ENDPOINTS SUMMARY (149 Routes)', '\u{1F310}');

    const apiGroups = [
      ['Authentication', 'POST /api/login, /register, /forgot-password, /parent/email-login, /parent/register'],
      ['Students', 'GET/POST /api/students, /student/qr/:id, CSV bulk import, class students, marks'],
      ['Attendance', 'GET/POST attendance records, submissions, edits, overrides, bulk marking'],
      ['Marks & Grades', 'GET/POST marks entry, subject-wise, unit-wise, grade calculation'],
      ['Fee Management', 'GET/POST fee records, payments, bulk status, send reminders'],
      ['Leave System', 'GET/POST/PUT leave requests, approvals, rejections (staff + students)'],
      ['Bus & Transport', 'POST start/end trip, update location, proximity alerts, route students, set stops, trip scans'],
      ['Duty & Clock', 'POST clock-in/out, status updates, duration logs for drivers + cleaners'],
      ['Reports', 'POST report-card PDF, GET master audit, admin reports'],
      ['Promotion', 'GET preview, POST execute batch promote/retain/graduate'],
      ['Admin Management', 'GET/POST users, classes, buses, activities, events, salary, settings, alerts'],
      ['Notifications', 'GET/POST parent, teacher, driver notifications'],
      ['School Info', 'GET/POST school info, gallery image upload/remove'],
      ['Google Sheets Sync', 'POST sync attendance, marks, payroll, master timetable'],
      ['Super Admin', 'POST create school, GET list schools, stats, activity, status toggle, subscriptions'],
    ];
    apiGroups.forEach(([group, desc]) => {
      doc.fontSize(10).fillColor(C_TEAL).text(group, 60, doc.y);
      doc.fontSize(8.5).fillColor('#94A3B8').text(desc, 60, doc.y, { width: 475 });
      doc.moveDown(0.5);
    });

    // ── SECTION 7: ALL FEATURE UPGRADES ──
    newPage();
    sectionTitle('FEATURE UPGRADES — COMPLETE LIST', '\u{1F680}');

    const upgrades = [
      {
        name: '1. JWT Authentication & Token Security',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'Replaced header-based role authentication with JWT Bearer tokens (30-day expiry)',
          'signToken/verifyToken utilities with HS256 algorithm',
          'verifyAuth middleware sets req.userId, req.userRole, req.schoolId from JWT',
          'Token stored in AsyncStorage, attached to all API calls via apiFetch()',
          'Parent PIN guard: token held in pendingToken until PIN verified',
          'JWT_SECRET required via environment variable — server crashes if missing',
        ]
      },
      {
        name: '2. Global Auth Guard',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'All /api/* and /download/* routes require verifyAuth by default',
          '14 explicitly listed PUBLIC_ROUTES exempt (login, register, school-info, etc.)',
          'Super admin routes (/api/super/*) use separate verifySuperAdmin middleware',
          'Eliminated all unauthenticated API access vectors',
        ]
      },
      {
        name: '3. Centralized API Client (apiFetch)',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'src/api/client.js exports apiFetch() — single function for all API calls',
          'Auto-attaches Authorization: Bearer token from AsyncStorage',
          'Auto-detects base URL from environment (Replit domain / localhost)',
          'Integrated error reporting: HTTP 4xx/5xx and network failures auto-reported',
          'Replaced raw fetch() calls across all 40+ screens',
        ]
      },
      {
        name: '4. Multi-Tenant SaaS Architecture',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'School code generation: SP-GOPA (Sree Pragathi, Gopalraopet)',
          'DEFAULT_SCHOOL_ID = "school_001" — fallback for backwards compatibility',
          'schoolId filter on ALL Firestore queries (35+ collections)',
          'schoolId included on ALL writes (addDoc, setDoc, batch.set)',
          'checkSchoolActive middleware blocks suspended schools globally',
          'Super Admin can create/manage multiple schools via /api/super/* routes',
        ]
      },
      {
        name: '5. Rate Limiting & Security Headers',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'Global API limiter: 300 req/min per IP',
          'Login limiter: 10 attempts/15 min, Registration: 5 attempts/hr',
          'QR scan limiter: 60 scans/min, Super Admin: 50 req/min',
          'Security headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy',
          'CORS restricted to allowed origins (Vercel, localhost, APP_URL)',
          'Request body size limit: 10MB',
        ]
      },
      {
        name: '6. Error Tracking & Reporting System',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'React ErrorBoundary catches render crashes with friendly UI',
          'Global error listener catches unhandled JS errors + promise rejections',
          'API client auto-reports HTTP errors and network failures',
          'All errors include user attribution (userId, userRole)',
          'Severity levels: low/medium/high/critical',
          'Error types: js_crash, api_error, firestore_error, auth_error, unhandled_promise',
          'Errors stored in Firestore "alerts" collection — viewable in Admin Alerts screen',
        ]
      },
      {
        name: '7. UX Component System',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'LoadingSpinner — fullScreen and inline modes with animated spinner',
          'ErrorBanner — dismissible error display with retry button',
          'Toast — animated notifications (success/error/info) with auto-dismiss',
          'getFriendlyError() — maps technical errors to user-friendly messages',
          'Applied across all 40 screens — zero Alert.alert calls remain',
          'Consistent loading, error, and success patterns everywhere',
        ]
      },
      {
        name: '8. Report Card PDF Generation',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'POST /api/reports/report-card/:studentId — generates A4 PDF via PDFKit',
          'Includes school name, student info, marks table, grades, totals, percentage',
          'Grade logic: A+ (90-100), A (80-89), B+ (70-79), B (60-69), C (50-59), F (<50)',
          'Security: verifyAuth + parent ownership check + schoolId isolation',
          'Frontend: MarksScreen download modal with exam dropdown + academic year',
          'Web: blob URL download, Native: expo-file-system + expo-sharing',
        ]
      },
      {
        name: '9. Year-End Class Promotion',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'GET /api/admin/promotion/preview — student list with pass/fail, attendance %, avg marks',
          'POST /api/admin/promotion/execute — batch promote/retain/graduate with Firestore writeBatch',
          'Pass criteria: >= 35% in every subject (best score per subject across exams)',
          'Actions: promote (N → N+1), retain (same class + note), graduate (status → alumni)',
          'History logged to promotionHistory collection',
          'AdminPromotion.js — 4-step wizard with segmented controls and CSV export',
        ]
      },
      {
        name: '10. Bulk Fee Status Dashboard',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'GET /api/admin/fees/bulk-status — all students fee status with month/year/class filters',
          'POST /api/admin/fees/send-reminder — batch reminders via Firestore writeBatch',
          'Summary cards: total/paid/unpaid/partial counts with color coding',
          'Multi-select mode (long press), "Select All Unpaid", bulk reminder with confirmation',
          'Student detail modal with full payment history',
          'Skeleton loader, CSV export, empty state for all-paid',
        ]
      },
      {
        name: '11. Network Status Banner (Offline Detection)',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          '@react-native-community/netinfo monitors connectivity in real time',
          'Yellow banner: "You\'re offline — changes may not save" when disconnected',
          'Green banner: "Back online ✓" shown for 2 seconds on reconnect',
          'Animated slide-down/slide-up transition (300ms)',
          'Placed in root App.js — appears on every screen globally',
          'Sits below StatusBar/SafeAreaView on native devices',
        ]
      },
      {
        name: '12. Driver Action Confirmation Dialogs',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'Start Trip: Alert.alert confirmation before notifying parents',
          'End Trip: Alert.alert confirmation before marking students dropped',
          'Set Pickup Stop: Alert.alert confirmation before recording GPS coordinates',
          'Prevents accidental irreversible actions with Cancel/Confirm options',
          'No changes to existing trip or GPS logic — pure UX safety layer',
        ]
      },
      {
        name: '13. Strict QR Scan Validation',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'QR Format: SREE_PRAGATHI|{schoolId}|{studentId}',
          'Validates school match, student existence, active status',
          'Wrong bus detection: allows boarding but alerts admin + parent',
          '5-minute duplicate scan cooldown per student per day',
          'Rejection logging to scan_rejection_logs collection',
          '3+ rejected scans in 10 minutes triggers admin security alert',
        ]
      },
      {
        name: '14. Google Sheets Auto-Sync',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'Attendance sync — daily records pushed to Google Sheets',
          'Marks sync — subject-wise and unit-wise marks synced',
          'Payroll sync — salary payments exported to Sheets',
          'Master timetable — class schedule synced from/to Sheets',
          'Uses Firebase service account credentials for Sheets API',
        ]
      },
      {
        name: '15. Real-Time Bus Tracking & GPS',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'Driver starts trip → GPS watchPosition begins tracking',
          'Location updates sent every 10 seconds to /bus/update-location',
          'Parents see live bus position on Leaflet map in BusScreen',
          'Speed, coordinates, distance, elapsed time displayed on driver dashboard',
          'Haversine formula calculates trip distance',
          'Trip summaries logged with duration, distance, students boarded',
        ]
      },
      {
        name: '16. School Info & Gallery System',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'AdminSettings: full CRUD for school name, tagline, phone, email, address, board, etc.',
          'Gallery image upload: POST /api/school-info/upload-image (JPEG/PNG/GIF/WebP, 500KB max)',
          'ExploreScreen: public school info with stats and gallery carousel',
          'ContactScreen: phone, email, address, website display',
        ]
      },
      {
        name: '17. Super Admin Panel (Multi-School Management)',
        status: 'COMPLETE',
        color: C_GREEN,
        details: [
          'Create new schools with auto-generated school codes',
          'List all schools with status, plan, student/staff counts',
          'Toggle school status (active/suspended)',
          'Update subscription plans',
          'View school activity, security logs, summary dashboards',
          'Hard delete school (with all associated data)',
          'Protected by verifySuperAdmin + rate limiting (50 req/min)',
        ]
      },
    ];

    upgrades.forEach(u => {
      if (doc.y > 660) newPage();
      doc.fontSize(11).fillColor(C_WHITE).text(u.name, 55, doc.y, { width: 400, continued: false });
      const badgeY = doc.y - 13;
      doc.fontSize(7).fillColor(u.color).text(` [${u.status}]`, 460, badgeY, { width: 80 });
      doc.y = badgeY + 16;
      u.details.forEach(d => bulletPoint(d, 70));
      doc.moveDown(0.3);
    });

    // ── SECTION 8: SECURITY ──
    newPage();
    sectionTitle('SECURITY & RATE LIMITING', '\u{1F6E1}');
    subHeading('Authentication Layers');
    bulletPoint('Firebase Auth: email/password verification');
    bulletPoint('JWT tokens: 30-day expiry, HS256 algorithm, Bearer header');
    bulletPoint('verifyAuth: global middleware on all protected routes');
    bulletPoint('verifySuperAdmin: x-super-admin-key header for super admin routes');
    bulletPoint('Parent PIN: additional 4-digit PIN verification after login');

    subHeading('Rate Limits');
    bulletPoint('Global API: 300 requests/minute per IP');
    bulletPoint('Login endpoints: 10 attempts per 15 minutes per IP');
    bulletPoint('Registration: 5 attempts per hour per IP');
    bulletPoint('QR scans: 60 scans per minute per IP');
    bulletPoint('Super Admin: 50 requests per minute per IP');

    subHeading('Security Headers');
    bulletPoint('X-Content-Type-Options: nosniff');
    bulletPoint('X-Frame-Options: DENY');
    bulletPoint('X-XSS-Protection: 1; mode=block');
    bulletPoint('Referrer-Policy: strict-origin-when-cross-origin');
    bulletPoint('X-Powered-By: removed');

    subHeading('Data Protection');
    bulletPoint('Passwords hashed with bcryptjs (10 salt rounds)');
    bulletPoint('Parent PINs hashed with bcryptjs');
    bulletPoint('JWT_SECRET required — server refuses to start without it');
    bulletPoint('CORS restricted to allowed origins');
    bulletPoint('Request body size limit: 10MB');
    bulletPoint('Image upload validation: MIME type check (JPEG/PNG/GIF/WebP), 500KB max');

    // ── SECTION 9: MULTI-TENANT ──
    sectionTitle('MULTI-TENANT SaaS ARCHITECTURE', '\u{1F3E2}');
    bulletPoint('Each school gets a unique school code (e.g., SP-GOPA)');
    bulletPoint('schoolId field present on 35+ Firestore collections');
    bulletPoint('Every query filtered by schoolId — complete data isolation');
    bulletPoint('checkSchoolActive middleware blocks suspended schools');
    bulletPoint('Super Admin manages schools via /api/super/* endpoints');
    bulletPoint('Subscription plans: basic, standard, premium');
    bulletPoint('Schools collection stores status, plan, principal info, timestamps');

    // ── SECTION 10: DATA MODELS ──
    newPage();
    sectionTitle('DATA MODELS & FIRESTORE COLLECTIONS', '\u{1F4BE}');
    const collections = [
      ['users', 'uid, full_name, email, role, role_id, schoolId, profileCompleted'],
      ['students', 'studentId, name, rollNumber, classId, className, parentPhone, busId, routeId, qrCode, status, schoolId'],
      ['parent_accounts', 'studentIds, activeStudentId, pinHash, email, phone, schoolId'],
      ['classes', 'classId, className, section, teacherId, schoolId'],
      ['attendance_records', 'studentId, date, status, markedBy, classId, schoolId'],
      ['student_marks', 'studentId, subject, unit, marks, totalMarks, examName, schoolId'],
      ['fee_records', 'studentId, totalFee, paid, discount, fine, history[], schoolId'],
      ['leave_requests', 'userId, type, startDate, endDate, reason, status, schoolId'],
      ['buses', 'busNumber, driverName, route, capacity, studentIds, schoolId'],
      ['bus_trips', 'tripId, driverId, busNumber, route, startTime, endTime, schoolId'],
      ['live_bus_locations', 'busNumber, lat, lng, speed, timestamp, schoolId'],
      ['trip_scans', 'studentId, busNumber, type (board/drop), scanTime, schoolId'],
      ['parent_notifications', 'studentId, title, message, type, read, schoolId'],
      ['alerts', 'type, severity, message, screen, userId, userRole, timestamp'],
      ['salary_payments', 'staffId, amount, month, year, mode, paidDate, schoolId'],
      ['promotionHistory', 'studentId, fromClass, toClass, action, performedBy, timestamp'],
      ['schools', 'schoolId, schoolName, location, status, plan, principalEmail'],
      ['settings', 'schoolName, tagline, phone, email, address, galleryImages[]'],
    ];
    collections.forEach(([name, fields]) => {
      if (doc.y > 710) newPage();
      doc.fontSize(10).fillColor(C_GOLD).text(name, 55, doc.y, { continued: true });
      doc.fontSize(8.5).fillColor('#94A3B8').text(`  — ${fields}`, { width: 430 });
      doc.moveDown(0.3);
    });

    // ── SECTION 11: UX & ERROR HANDLING ──
    sectionTitle('UX & ERROR HANDLING SYSTEM', '\u{2728}');
    subHeading('Shared Components');
    bulletPoint('LoadingSpinner — fullScreen overlay or inline spinner, replaces raw ActivityIndicator');
    bulletPoint('ErrorBanner — red banner with message, dismiss (✕), and optional retry button');
    bulletPoint('Toast — animated bottom notification with auto-dismiss (success/error/info)');
    bulletPoint('ErrorBoundary — wraps entire app, catches render crashes with friendly recovery UI');
    bulletPoint('OfflineBanner — network status monitor with yellow/green animated banners');
    bulletPoint('Icon — custom SVG icon component with 15+ icons');
    bulletPoint('DonutRing — animated circular progress indicator');

    subHeading('Error Mapping');
    bulletPoint('getFriendlyError() converts technical errors to user-readable messages');
    bulletPoint('Network errors → "Unable to connect. Check your internet connection."');
    bulletPoint('401/403 → "Session expired. Please log in again."');
    bulletPoint('500 → "Something went wrong on our end. Please try again."');
    bulletPoint('Timeout → "Request timed out. Please try again."');

    // ── SECTION 12: DEPLOYMENT ──
    sectionTitle('DEPLOYMENT & INFRASTRUCTURE', '\u{2601}');
    bulletPoint('Hosted on Replit — autoscale deployment target');
    bulletPoint('Frontend build: npx expo export --platform web --output-dir dist');
    bulletPoint('Server: node server.js (port 5000)');
    bulletPoint('Static files served from dist/ directory');
    bulletPoint('Environment variables: Firebase keys, JWT_SECRET, APP_URL');
    bulletPoint('Firebase Admin SDK: service account via FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY');
    bulletPoint('Firestore composite indexes: 19 indexes deployed via firebase CLI');
    bulletPoint('Auto clock-out scheduled daily at 7:00 PM');

    // ── FINAL PAGE ──
    newPage();
    doc.moveDown(8);
    doc.fontSize(24).fillColor(C_GOLD).text('END OF AUDIT REPORT', { align: 'center' });
    doc.moveDown(1);
    drawLine(doc.y, C_GOLD);
    doc.moveDown(1);
    doc.fontSize(11).fillColor(C_MUTED).text('Sree Pragathi High School', { align: 'center' });
    doc.fontSize(10).fillColor(C_MUTED).text('Gopalraopet, Telangana', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor(C_MUTED).text(`Report generated on ${dateStr}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor(C_TEAL).text('Vidhaya Layam — Education Technology Platform', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#475569').text('This document is confidential and intended for authorized personnel only.', { align: 'center' });

    // ── Page numbers ──
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor(C_MUTED).text(
        `Page ${i + 1} of ${pageCount}`,
        50, 810, { width: 495, align: 'center' }
      );
    }

    doc.end();
  } catch (err) {
    console.error('[master-audit] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate audit report' });
  }
});

app.get('/api/report', (req, res) => {
  try {
    const html = generateReport();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="sree-pragathi-codebase-report.html"');
    res.send(html);
  } catch (err) {
    console.error('Report generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
});




app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.get(/^(?!\/api\/).*$/, (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  } else {
    res.status(200).json({ status: 'Vidyalayam API running', version: '2.1.0' });
  }
});

function scheduleAutoClockout() {
  const check = () => {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const h = istNow.getUTCHours();
    const m = istNow.getUTCMinutes();
    if (h === 19 && m === 0) {
      console.log('7:00 PM — triggering auto clock-out for all staff...');
      performAutoClockout()
        .then(count => console.log(`Auto clock-out complete: ${count} staff clocked out`))
        .catch(e => console.error('Auto clock-out cron error:', e.message));
    }
  };
  setInterval(check, 60000);
}

function getWorkingDays(year, month) {
  const days = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    if (d.getDay() !== 0) days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}
function parseHours(h) { return h ? Math.max(0, parseFloat(h) || 0) : 0; }
function attStatusFromHours(h) {
  if (h >= 7) return 'Present';
  if (h >= 3.5) return 'Half Day';
  if (h > 0) return 'Short Day';
  return 'Absent';
}
function calcSalarySummary(salary, attByDate, workingDays) {
  const basic = salary.basicSalary || 0;
  const hra = salary.hra || 0;
  const ta = salary.ta || 0;
  const da = salary.da || 0;
  const pf = salary.pf || 0;
  const tax = salary.tax || 0;
  const lopRate = salary.lopRate || 0;
  const gross = basic + hra + ta + da;
  const totalWD = workingDays.length || 26;
  const dailyRate = basic / (totalWD || 26);
  let creditedDays = 0;
  let fullDays = 0, halfDays = 0, shortDays = 0, absentDays = 0, lopDays = 0;
  for (const date of workingDays) {
    const override = attByDate[date]?.override;
    const hours = parseHours(attByDate[date]?.hoursWorked);
    const status = override?.status || attStatusFromHours(hours);
    if (status === 'Present') { creditedDays += 1; fullDays++; }
    else if (status === 'Half Day') { creditedDays += 0.5; halfDays++; }
    else if (status === 'Short Day') { creditedDays += 0.5; shortDays++; }
    else { lopDays++; absentDays++; }
  }
  const lopDeduction = lopDays * lopRate;
  const totalDeductions = pf + tax + lopDeduction;
  const net = Math.max(0, gross - totalDeductions);
  const attPct = totalWD > 0 ? Math.round(((fullDays + halfDays * 0.5 + shortDays * 0.5) / totalWD) * 100) : 0;
  return { gross, net, pf, tax, lopRate, lopDeduction, totalDeductions, fullDays, halfDays, shortDays, absentDays, lopDays, attPct, workingDays: totalWD, creditedDays };
}

app.get('/api/payroll/my-salary', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    const [salSnap, userSnap, onbSnap, balSnap] = await Promise.all([
      db.collection('salary_settings').doc(roleId).get(),
      db.collection('users').where('role_id', '==', roleId).get(),
      db.collection('onboarded_users').where('role_id', '==', roleId).get(),
      db.collection('leave_balance').doc(roleId).get(),
    ]);
    const salary = salSnap.exists ? salSnap.data() : {};
    const userData = !userSnap.empty ? userSnap.docs[0].data() : (!onbSnap.empty ? onbSnap.docs[0].data() : {});
    const balance = balSnap.exists ? balSnap.data() : { casual: 12, sick: 12, earned: 6 };
    const configured = salSnap.exists && (salary.basicSalary || salary.grossSalary || salary.monthlySalary);
    res.json({ salary, user: userData, balance, configured: !!configured });
  } catch (err) {
    console.error('My salary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payroll/my-payslip', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    const { month } = req.query;
    if (!roleId || !month) return res.status(400).json({ error: 'roleId and month required' });
    const [year, mon] = month.split('-').map(Number);
    const workingDaysList = getWorkingDays(year, mon);
    const startDate = `${month}-01`;
    const endDate = `${month}-31`;
    const [salSnap, dutySnap, overrideSnap, paymentSnap] = await Promise.all([
      db.collection('salary_settings').doc(roleId).get(),
      db.collection('staff_duty').where('roleId', '==', roleId).get(),
      db.collection('attendance_overrides').where('roleId', '==', roleId).where('month', '==', month).get(),
      db.collection('salary_payments').where('roleId', '==', roleId).where('month', '==', month).get(),
    ]);
    const salary = salSnap.exists ? salSnap.data() : {};
    const dutyMap = {};
    dutySnap.docs.forEach(d => {
      const data = d.data();
      if (data.dateKey >= startDate && data.dateKey <= endDate) dutyMap[data.dateKey] = data;
    });
    const overrideMap = {};
    overrideSnap.docs.forEach(d => { const data = d.data(); overrideMap[data.date] = data; });
    const payment = paymentSnap.empty ? null : paymentSnap.docs[0].data();
    const days = workingDaysList.map(date => {
      const duty = dutyMap[date];
      const override = overrideMap[date];
      const hours = parseHours(duty?.hoursWorked);
      const status = override?.status || attStatusFromHours(hours);
      return { date, clockIn: duty?.clockIn || null, clockOut: duty?.clockOut || null, hoursWorked: hours, status, override: override || null };
    });
    const fullDays = days.filter(d => d.status === 'Present').length;
    const halfDays = days.filter(d => d.status === 'Half Day').length;
    const shortDays = days.filter(d => d.status === 'Short Day').length;
    const absentDays = days.filter(d => d.status === 'Absent').length;
    const lopDays = absentDays;
    const totalHours = parseFloat(days.reduce((s, d) => s + d.hoursWorked, 0).toFixed(1));
    const basic = salary.basicSalary || 0;
    const hra = salary.hra || 0;
    const ta = salary.ta || 0;
    const da = salary.da || 0;
    const specialAllowance = salary.specialAllowance || 0;
    const gross = basic + hra + ta + da + specialAllowance;
    const pf = salary.pf || 0;
    const tax = salary.tax || 0;
    const lopRate = salary.lopRate || 0;
    const lopDeduction = lopDays * lopRate;
    const totalDeductions = pf + tax + lopDeduction;
    const net = Math.max(0, gross - totalDeductions);
    const attPct = workingDaysList.length > 0 ? Math.round(((fullDays + halfDays * 0.5 + shortDays * 0.5) / workingDaysList.length) * 100) : 0;
    const empCode = roleId.replace(/[^0-9]/g, '').slice(-4) || roleId.slice(-4);
    const refNo = `SAL-${empCode}-${String(mon).padStart(2,'0')}${String(year).slice(-2)}`;
    res.json({
      month, salary, earnings: { basic, hra, ta, da, specialAllowance, gross },
      deductions: { pf, tax, lopDeduction, lopRate, lopDays, total: totalDeductions },
      net, attendance: { workingDays: workingDaysList.length, fullDays, halfDays, shortDays, absentDays, totalHours, attPct },
      days, payment, refNo, status: payment?.status || 'Pending',
    });
  } catch (err) {
    console.error('My payslip error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payroll/my-year', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    const { year } = req.query;
    if (!roleId || !year) return res.status(400).json({ error: 'roleId and year required' });
    const y = parseInt(year);
    const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
    const [salSnap, dutySnap, paymentsSnap] = await Promise.all([
      db.collection('salary_settings').doc(roleId).get(),
      db.collection('staff_duty').where('roleId', '==', roleId).get(),
      db.collection('salary_payments').where('roleId', '==', roleId).get(),
    ]);
    const salary = salSnap.exists ? salSnap.data() : {};
    const allDuty = {};
    dutySnap.docs.forEach(d => { const data = d.data(); if (data.dateKey) allDuty[data.dateKey] = data; });
    const paymentMap = {};
    paymentsSnap.docs.forEach(d => { const data = d.data(); paymentMap[data.month] = data; });
    const basic = salary.basicSalary || 0;
    const hra = salary.hra || 0;
    const ta = salary.ta || 0;
    const da = salary.da || 0;
    const specialAllowance = salary.specialAllowance || 0;
    const gross = basic + hra + ta + da + specialAllowance;
    const pf = salary.pf || 0;
    const tax = salary.tax || 0;
    const lopRate = salary.lopRate || 0;
    const summary = months.map(month => {
      const [my, mm] = month.split('-').map(Number);
      const wdList = getWorkingDays(my, mm);
      const startDate = `${month}-01`;
      const endDate = `${month}-31`;
      let fullDays = 0, halfDays = 0, shortDays = 0, absentDays = 0;
      for (const date of wdList) {
        const hours = parseHours(allDuty[date]?.hoursWorked);
        const status = attStatusFromHours(hours);
        if (status === 'Present') fullDays++;
        else if (status === 'Half Day') halfDays++;
        else if (status === 'Short Day') shortDays++;
        else absentDays++;
      }
      const lopDays = absentDays;
      const lopDeduction = lopDays * lopRate;
      const totalDeductions = pf + tax + lopDeduction;
      const net = Math.max(0, gross - totalDeductions);
      const payment = paymentMap[month];
      return { month, workingDays: wdList.length, fullDays, halfDays, shortDays, absentDays, lopDays, gross, totalDeductions, net, status: payment?.status || (gross > 0 ? 'Pending' : 'Not Set'), credited: payment?.creditedAt || null };
    });
    res.json({ summary, salary });
  } catch (err) {
    console.error('Year summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payroll/payslip-html', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    const { month } = req.query;
    if (!roleId || !month) return res.status(400).json({ error: 'roleId and month required' });
    const [year, mon] = month.split('-').map(Number);
    const workingDaysList = getWorkingDays(year, mon);
    const startDate = `${month}-01`; const endDate = `${month}-31`;
    const [salSnap, userSnap, onbSnap, dutySnap, overrideSnap, paymentSnap] = await Promise.all([
      db.collection('salary_settings').doc(roleId).get(),
      db.collection('users').where('role_id', '==', roleId).get(),
      db.collection('onboarded_users').where('role_id', '==', roleId).get(),
      db.collection('staff_duty').where('roleId', '==', roleId).get(),
      db.collection('attendance_overrides').where('roleId', '==', roleId).where('month', '==', month).get(),
      db.collection('salary_payments').where('roleId', '==', roleId).where('month', '==', month).get(),
    ]);
    const salary = salSnap.exists ? salSnap.data() : {};
    const userData = !userSnap.empty ? userSnap.docs[0].data() : (!onbSnap.empty ? onbSnap.docs[0].data() : {});
    const dutyMap = {}; dutySnap.docs.forEach(d => { const data = d.data(); if (data.dateKey >= startDate && data.dateKey <= endDate) dutyMap[data.dateKey] = data; });
    const overrideMap = {}; overrideSnap.docs.forEach(d => { const data = d.data(); overrideMap[data.date] = data; });
    const payment = paymentSnap.empty ? null : paymentSnap.docs[0].data();
    const days = workingDaysList.map(date => { const duty = dutyMap[date]; const override = overrideMap[date]; const hours = parseHours(duty?.hoursWorked); const status = override?.status || attStatusFromHours(hours); return { date, hours, status }; });
    const fullDays = days.filter(d => d.status === 'Present').length;
    const halfDays = days.filter(d => d.status === 'Half Day').length;
    const shortDays = days.filter(d => d.status === 'Short Day').length;
    const absentDays = days.filter(d => d.status === 'Absent').length;
    const basic = salary.basicSalary || 0, hra = salary.hra || 0, ta = salary.ta || 0, da = salary.da || 0, sp = salary.specialAllowance || 0;
    const gross = basic + hra + ta + da + sp;
    const pf = salary.pf || 0, taxAmt = salary.tax || 0, lopRate = salary.lopRate || 0, lopDeduction = absentDays * lopRate;
    const totalDeductions = pf + taxAmt + lopDeduction, net = Math.max(0, gross - totalDeductions);
    const monthLabel = new Date(year, mon - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const empCode = roleId.replace(/[^0-9]/g, '').slice(-4) || roleId.slice(-4);
    const refNo = `SAL-${empCode}-${String(mon).padStart(2,'0')}${String(year).slice(-2)}`;
    const inr = v => '₹' + Number(v).toLocaleString('en-IN');
    const empName = userData.full_name || userData.name || roleId;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pay Slip - ${monthLabel}</title><style>
      *{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#fff;color:#1a1a1a;padding:32px}
      .header{text-align:center;border-bottom:3px solid #0B1F3A;padding-bottom:16px;margin-bottom:24px}
      .school-name{font-size:22px;font-weight:800;color:#0B1F3A}
      .slip-title{font-size:16px;font-weight:600;color:#7C5CBF;margin-top:4px}
      .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;padding:14px;background:#f8f8f8;border-radius:8px}
      .info-item label{font-size:11px;color:#666;display:block}
      .info-item span{font-size:13px;font-weight:600;color:#1a1a1a}
      table{width:100%;border-collapse:collapse;margin-bottom:20px}
      th{background:#0B1F3A;color:#fff;padding:8px 12px;text-align:left;font-size:12px}
      td{padding:8px 12px;border-bottom:1px solid #eee;font-size:13px}
      .amount{text-align:right;font-weight:600}
      .total-row td{font-weight:700;background:#f0f0f0}
      .net-box{background:#e8fff5;border:2px solid #34D399;border-radius:10px;padding:16px;text-align:center;margin-bottom:20px}
      .net-label{font-size:12px;color:#666}
      .net-amount{font-size:28px;font-weight:800;color:#00874d}
      .status-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700}
      .credited{background:#e8fff5;color:#00874d} .pending{background:#fff8e0;color:#d4900a}
      .footer{text-align:center;font-size:10px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:12px}
      @media print{body{padding:16px}button{display:none}}
    </style></head><body>
    <div class="header">
      <div class="school-name">Vidyalayam</div>
      <div class="slip-title">SALARY PAY SLIP — ${monthLabel.toUpperCase()}</div>
      <div style="font-size:12px;color:#666;margin-top:6px">Ref: ${refNo} · Status: <span class="status-badge ${payment?.status === 'Credited' ? 'credited' : 'pending'}">${payment?.status || 'Pending'}</span></div>
    </div>
    <div class="info-grid">
      <div class="info-item"><label>Employee Name</label><span>${empName}</span></div>
      <div class="info-item"><label>Employee ID</label><span>${roleId}</span></div>
      <div class="info-item"><label>Designation</label><span>${salary.designation || userData.role || '—'}</span></div>
      <div class="info-item"><label>Department</label><span>${userData.dept || userData.subject || '—'}</span></div>
      <div class="info-item"><label>Date of Joining</label><span>${salary.dateOfJoining || '—'}</span></div>
      <div class="info-item"><label>Bank Account</label><span>${salary.bankAccount ? '••••' + salary.bankAccount.slice(-4) : '—'}</span></div>
      <div class="info-item"><label>Working Days</label><span>${workingDaysList.length}</span></div>
      <div class="info-item"><label>Days Present</label><span>${fullDays} Full + ${halfDays} Half + ${shortDays} Short</span></div>
      <div class="info-item"><label>LOP Days</label><span>${absentDays}</span></div>
      <div class="info-item"><label>Attendance %</label><span>${workingDaysList.length > 0 ? Math.round(((fullDays + halfDays*0.5 + shortDays*0.5)/workingDaysList.length)*100) : 0}%</span></div>
    </div>
    <table>
      <tr><th>EARNINGS</th><th class="amount">Amount</th><th>DEDUCTIONS</th><th class="amount">Amount</th></tr>
      <tr><td>Basic Salary</td><td class="amount">${inr(basic)}</td><td>Provident Fund (PF)</td><td class="amount">– ${inr(pf)}</td></tr>
      <tr><td>HRA</td><td class="amount">${inr(hra)}</td><td>Professional Tax / TDS</td><td class="amount">– ${inr(taxAmt)}</td></tr>
      <tr><td>Travel Allowance (TA)</td><td class="amount">${inr(ta)}</td><td>LOP Deduction (${absentDays} days × ${inr(lopRate)})</td><td class="amount">– ${inr(lopDeduction)}</td></tr>
      <tr><td>Dearness Allowance (DA)</td><td class="amount">${inr(da)}</td><td></td><td></td></tr>
      ${sp > 0 ? `<tr><td>Special Allowance</td><td class="amount">${inr(sp)}</td><td></td><td></td></tr>` : ''}
      <tr class="total-row"><td>Gross Earnings</td><td class="amount">${inr(gross)}</td><td>Total Deductions</td><td class="amount">– ${inr(totalDeductions)}</td></tr>
    </table>
    <div class="net-box">
      <div class="net-label">NET TAKE-HOME PAY</div>
      <div class="net-amount">${inr(net)}</div>
      ${payment?.creditedAt ? `<div style="font-size:11px;color:#666;margin-top:6px">Credited on ${new Date(payment.creditedAt).toLocaleDateString('en-IN')}</div>` : ''}
    </div>
    <div class="footer">This is a computer-generated payslip and does not require a signature.<br>Vidyalayam — For queries, contact HR/Admin</div>
    <button onclick="window.print()" style="position:fixed;bottom:24px;right:24px;background:#7C5CBF;color:#fff;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700">🖨️ Print / Download PDF</button>
    </body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Payslip HTML error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll/mark-credited', async (req, res) => {
  try {
    const { roleId, month, adminName, net, gross } = req.body;
    if (!roleId || !month) return res.status(400).json({ error: 'roleId and month required' });
    const creditedAt = new Date().toISOString();
    const empCode = roleId.replace(/[^0-9]/g, '').slice(-4) || roleId.slice(-4);
    const [y, m] = month.split('-');
    const refNo = `SAL-${empCode}-${m.padStart(2,'0')}${String(y).slice(-2)}`;
    const paymentRef = await db.collection('salary_payments').add({
      roleId, month, status: 'Credited', net: Number(net) || 0, gross: Number(gross) || 0,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      creditedAt, creditedBy: adminName || 'Admin', refNo,
    });
    const monthLabel = new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    await db.collection('teacher_notifications').add({
      roleId, type: 'salary_credited', icon: '💰', title: 'Salary Credited',
      message: `Your salary for ${monthLabel} of ₹${Number(net).toLocaleString('en-IN')} has been credited. Ref: ${refNo}`,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      month, refNo, amount: Number(net) || 0, read: false, createdAt: creditedAt,
    });
    await db.collection('driver_notifications').add({
      driverId: roleId, type: 'salary_credited', icon: '💰', title: 'Salary Credited',
      message: `Your salary for ${monthLabel} of \u20B9${Number(net).toLocaleString('en-IN')} has been credited. Ref: ${refNo}`,
      schoolId: (req.schoolId || DEFAULT_SCHOOL_ID),
      month, refNo, amount: Number(net) || 0, read: false, createdAt: creditedAt,
    });
    res.json({ success: true, paymentId: paymentRef.id, refNo });
    safeSync('syncPayroll', () => syncPayroll({ employeeId: roleId, employeeName: adminName || roleId, month: m, year: y, grossSalary: Number(gross) || 0, netPayable: Number(net) || 0, creditStatus: 'Credited', creditedAt }), { roleId, month }).catch(() => {});
    safeSync('syncNotification', () => syncNotification({ notifId: paymentRef.id, type: 'salary_credited', recipientId: roleId, recipientRole: 'teacher', title: 'Salary Credited', message: `Salary for ${monthLabel} of ₹${Number(net).toLocaleString('en-IN')} credited. Ref: ${refNo}`, channel: 'in-app', sentAt: creditedAt }), { roleId }).catch(() => {});
  } catch (err) {
    console.error('Mark credited error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leave-balance', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    const balSnap = await db.collection('leave_balance').doc(roleId).get();
    const balance = balSnap.exists ? balSnap.data() : { casual: 12, sick: 12, earned: 6 };
    res.json({ balance });
  } catch (err) {
    console.error('Leave balance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payroll/employees', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required (YYYY-MM)' });
    const [year, mon] = month.split('-').map(Number);
    const workingDays = getWorkingDays(year, mon);
    const startDate = `${month}-01`;
    const endDate = `${month}-31`;

    const [usersSnap, logisticsSnap, dutySnap, salarySnap, overridesSnap] = await Promise.all([
      db.collection('users').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get(),
      db.collection('onboarded_users').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get(),
      db.collection('staff_duty').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('dateKey', '>=', startDate).where('dateKey', '<=', endDate).get(),
      db.collection('salary_settings').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get(),
      db.collection('attendance_overrides').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).where('month', '==', month).get(),
    ]);

    const salaryMap = {};
    salarySnap.docs.forEach(d => { salaryMap[d.id] = d.data(); });
    const overrideMap = {};
    overridesSnap.docs.forEach(d => {
      const { roleId, date } = d.data();
      if (!overrideMap[roleId]) overrideMap[roleId] = {};
      overrideMap[roleId][date] = d.data();
    });

    const dutyMap = {};
    dutySnap.docs.forEach(d => {
      const data = d.data();
      const rid = data.roleId;
      if (!rid) return;
      if (!dutyMap[rid]) dutyMap[rid] = {};
      dutyMap[rid][data.dateKey] = data;
    });

    const employees = [];
    const seen = new Set();

    const STAFF_ROLES = ['teacher', 'driver', 'cleaner', 'principal', 'admin', 'logistics', 'staff', 'accountant', 'librarian', 'security', 'peon', 'ayah', 'sweeper'];
    const addEmployee = (data, source) => {
      const rid = data.role_id || data.roleId;
      const role = (data.role || '').toLowerCase();
      if (!rid || seen.has(rid)) return;
      if (role === 'parent' || role === 'student') return;
      seen.add(rid);
      const salary = salaryMap[rid] || {};
      const empDuty = dutyMap[rid] || {};
      const empOverrides = overrideMap[rid] || {};
      const attByDate = {};
      for (const date of workingDays) {
        attByDate[date] = { hoursWorked: empDuty[date]?.hoursWorked || 0, clockIn: empDuty[date]?.clockIn, clockOut: empDuty[date]?.clockOut, override: empOverrides[date] || null };
      }
      const summary = calcSalarySummary(salary, attByDate, workingDays);
      employees.push({
        id: data.id || rid,
        roleId: rid,
        name: data.full_name || data.name || rid,
        role: data.role || 'teacher',
        dept: (data.dept || data.subject || data.department || '').trim(),
        subject: (data.subject || '').trim(),
        salary,
        ...summary,
      });
    };

    usersSnap.docs.forEach(d => addEmployee({ id: d.id, ...d.data() }, 'users'));
    logisticsSnap.docs.forEach(d => addEmployee({ id: d.id, ...d.data() }, 'onboarded_users'));

    employees.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ employees, workingDays: workingDays.length });
  } catch (err) {
    console.error('Payroll employees error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payroll/attendance', async (req, res) => {
  try {
    const roleId = req.query.roleId || req.roleId;
    const { month } = req.query;
    if (!roleId || !month) return res.status(400).json({ error: 'roleId and month required' });
    const [year, mon] = month.split('-').map(Number);
    const workingDays = getWorkingDays(year, mon);
    const startDate = `${month}-01`;
    const endDate = `${month}-31`;

    const [dutySnap, overridesSnap] = await Promise.all([
      db.collection('staff_duty').where('roleId', '==', roleId).get(),
      db.collection('attendance_overrides').where('roleId', '==', roleId).where('month', '==', month).get(),
    ]);

    const dutyMap = {};
    dutySnap.docs.forEach(d => {
      const data = d.data();
      if (data.dateKey >= startDate && data.dateKey <= endDate) dutyMap[data.dateKey] = data;
    });
    const overrideMap = {};
    overridesSnap.docs.forEach(d => { const data = d.data(); overrideMap[data.date] = data; });

    const days = workingDays.map(date => {
      const duty = dutyMap[date];
      const override = overrideMap[date];
      const hours = parseHours(duty?.hoursWorked);
      const computedStatus = attStatusFromHours(hours);
      const status = override?.status || computedStatus;
      return { date, clockIn: duty?.clockIn || null, clockOut: duty?.clockOut || null, hoursWorked: hours, status, override: override || null, onDuty: duty?.onDuty || false };
    });

    res.json({ days, workingDays: workingDays.length });
  } catch (err) {
    console.error('Payroll attendance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll/salary', async (req, res) => {
  try {
    const { roleId, basicSalary, hra, ta, da, specialAllowance, pf, tax, lopRate, bankAccount, ifsc, designation, dateOfJoining } = req.body;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    const settings = {
      roleId,
      basicSalary: Number(basicSalary) || 0,
      hra: Number(hra) || 0,
      ta: Number(ta) || 0,
      da: Number(da) || 0,
      specialAllowance: Number(specialAllowance) || 0,
      pf: Number(pf) || 0,
      tax: Number(tax) || 0,
      lopRate: Number(lopRate) || 0,
      bankAccount: bankAccount || '',
      ifsc: ifsc || '',
      designation: designation || '',
      dateOfJoining: dateOfJoining || '',
      updatedAt: new Date().toISOString(),
    };
    await db.collection('salary_settings').doc(roleId).set(settings, { merge: true });
    res.json({ success: true, settings });
    const now = new Date();
    safeSync('syncPayroll', () => syncPayroll({ employeeId: roleId, employeeName: designation || roleId, month: String(now.getMonth() + 1).padStart(2, '0'), year: String(now.getFullYear()), basicSalary: Number(basicSalary) || 0, hra: Number(hra) || 0, da: Number(da) || 0, ta: Number(ta) || 0, specialAllowance: Number(specialAllowance) || 0, grossSalary: (Number(basicSalary) || 0) + (Number(hra) || 0) + (Number(da) || 0) + (Number(ta) || 0) + (Number(specialAllowance) || 0), pf: Number(pf) || 0, tax: Number(tax) || 0, creditStatus: 'Pending' }), { roleId }).catch(() => {});
  } catch (err) {
    console.error('Save salary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll/attendance/override', async (req, res) => {
  try {
    const { roleId, date, status, reason, overriddenBy } = req.body;
    if (!roleId || !date || !status) return res.status(400).json({ error: 'roleId, date, status required' });
    const month = date.substring(0, 7);
    const docId = `${roleId}_${date}`;
    await db.collection('attendance_overrides').doc(docId).set({
      roleId, date, month, status, reason: reason || '', overriddenBy: overriddenBy || 'Admin', overriddenAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Attendance override error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll/toggle', async (req, res) => {
  try {
    const { roleId, employeeName, role, action } = req.body;
    if (!roleId || !action) return res.status(400).json({ error: 'roleId and action required' });
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const docId = `duty_${roleId}_${dateKey}`;
    const dutyRef = db.collection('staff_duty').doc(docId);
    const existing = await dutyRef.get();

    if (action === 'in') {
      if (existing.exists && existing.data().onDuty) {
        return res.json({ success: true, alreadyOn: true, clockIn: existing.data().clockIn });
      }
      const prevSessions = existing.exists ? (existing.data().sessions || []) : [];
      await dutyRef.set({
        userId: roleId, name: employeeName || roleId, role: role || 'teacher', roleId,
        onDuty: true, clockIn: timeStr, clockOut: null,
        currentStatus: 'On Duty', date: now.toLocaleDateString('en-IN'), dateKey,
        sessions: prevSessions,
        updatedAt: now.toISOString(),
      }, { merge: true });
      return res.json({ success: true, clockIn: timeStr });
    }

    if (action === 'out') {
      if (!existing.exists) return res.status(404).json({ error: 'No duty record for today' });
      const data = existing.data();
      if (!data.onDuty) return res.json({ success: true, alreadyOff: true, clockOut: data.clockOut });
      const clockInTime = data.clockIn || '08:00';
      const inMs = new Date(`2000-01-01T${clockInTime}`).getTime();
      const outMs = new Date(`2000-01-01T${timeStr}`).getTime();
      const sessionHours = Math.max(0, (outMs - inMs) / 3600000);
      const prevSessions = data.sessions || [];
      const prevHours = prevSessions.reduce((s, sess) => s + (sess.hours || 0), 0);
      const totalHours = prevHours + sessionHours;
      const sessions = [...prevSessions, { in: clockInTime, out: timeStr, hours: parseFloat(sessionHours.toFixed(2)) }];
      await dutyRef.update({
        onDuty: false, clockOut: timeStr, currentStatus: 'Off Duty',
        hoursWorked: parseFloat(totalHours.toFixed(2)), sessions, updatedAt: now.toISOString(),
      });
      return res.json({ success: true, clockOut: timeStr, hoursWorked: parseFloat(totalHours.toFixed(2)) });
    }

    res.status(400).json({ error: 'action must be "in" or "out"' });
  } catch (err) {
    console.error('Payroll toggle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sync-status', async (req, res) => {
  try {
    const errSnap = await db.collection('sync_errors').where('status', '==', 'pending').get();
    const pending = errSnap.size;
    const recentErrors = errSnap.docs.slice(0, 5).map(d => ({ id: d.id, operation: d.data().operation, error: d.data().error, createdAt: d.data().createdAt, attempts: d.data().attempts || 1 }));
    res.json({ synced: pending === 0, pending, recentErrors });
  } catch (err) {
    res.json({ synced: true, pending: 0, recentErrors: [] });
  }
});

async function retrySyncErrors() {
  if (!process.env.GOOGLE_SPREADSHEET_ID) return;
  try {
    const errSnap = await db.collection('sync_errors').where('status', '==', 'pending').get();
    if (errSnap.empty) return;
    console.log(`[SyncRetry] Found ${errSnap.size} pending sync error(s) — retrying...`);
    const syncFnMap = {
      syncStudent: (p) => syncStudent(p),
      syncTeacher: (p) => syncTeacher(p),
      syncLeaveRequest: (p) => syncLeaveRequest(p),
      syncParentAccount: (p) => syncParentAccount(p),
      syncPayroll: (p) => syncPayroll(p),
      syncNotification: (p) => syncNotification(p),
    };
    for (const errDoc of errSnap.docs) {
      const data = errDoc.data();
      const fn = syncFnMap[data.operation];
      if (!fn) { await db.collection('sync_errors').doc(errDoc.id).update({ status: 'skipped', note: 'No retry handler' }); continue; }
      try {
        const payload = JSON.parse(data.payload || '{}');
        const result = await fn(payload);
        if (result.success) {
          await db.collection('sync_errors').doc(errDoc.id).update({ status: 'resolved', resolvedAt: new Date().toISOString() });
          console.log(`[SyncRetry] Resolved: ${data.operation}`);
        } else {
          await db.collection('sync_errors').doc(errDoc.id).update({ attempts: (data.attempts || 1) + 1, lastAttemptAt: new Date().toISOString(), error: result.error || data.error });
        }
      } catch (retryErr) {
        await db.collection('sync_errors').doc(errDoc.id).update({ attempts: (data.attempts || 1) + 1, lastAttemptAt: new Date().toISOString(), error: retryErr.message }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SyncRetry] Retry scheduler error:', err.message);
  }
}

app.get('/api/bus/proximity-alerts-today', async (req, res) => {
  try {
    const { busNumber } = req.query;
    if (!busNumber) return res.status(400).json({ error: 'busNumber required' });
    const today = new Date().toISOString().slice(0, 10);
    const q = db.collection('proximity_alert_logs').where('busNumber', '==', busNumber).where('tripDate', '==', today);
    const snap = await q.get();
    const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    alerts.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
    res.json({ alerts, count: alerts.length });
  } catch (err) {
    console.error('Proximity alerts today error:', err.message);
    res.status(500).json({ error: 'Failed to fetch proximity alerts' });
  }
});

app.get('/api/bus/today-summary', async (req, res) => {
  try {
    const { driverId, busNumber } = req.query;

    let resolvedDriverId = driverId;

    if (!resolvedDriverId && busNumber) {
      const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
      const busQ = db.collection('buses').where('busNumber', '==', busNumber).where('schoolId', '==', schoolId);
      const busSnap = await busQ.get();
      if (!busSnap.empty) {
        resolvedDriverId = busSnap.docs[0].data().driverId;
      }
    }

    if (!resolvedDriverId) return res.status(400).json({
      error: 'driverId or busNumber required'
    });

    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const summaryRef = db.collection('trip_summaries').doc(`${resolvedDriverId}_${today}`);
    const summarySnap = await summaryRef.get();
    if (!summarySnap.exists) return res.json({ summary: null });
    res.json({ summary: summarySnap.data() });
  } catch (err) {
    console.error('Today summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch today summary' });
  }
});

app.get('/api/bus/trip-duration-week', async (req, res) => {
  try {
    const { driverId, weekOffset } = req.query;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });
    const offset = parseInt(weekOffset || '0', 10);

    const todayIST = new Date(Date.now() + 330 * 60000);
    const todayStr = todayIST.toISOString().slice(0, 10);
    const dowToday = todayIST.getUTCDay();
    const mondayShift = dowToday === 0 ? -6 : 1 - dowToday;
    const mondayMs = todayIST.getTime() + mondayShift * 86400000 + offset * 7 * 86400000;
    const monday = new Date(mondayMs);

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekDates = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(monday.getTime() + i * 86400000);
      weekDates.push(d.toISOString().slice(0, 10));
    }

    const summarySnaps = await Promise.all(
      weekDates.map(date => db.collection('trip_summaries').doc(`${driverId}_${date}`).get())
    );

    const days = weekDates.map((date, i) => {
      const isToday = date === todayStr;
      const s = summarySnaps[i].exists ? summarySnaps[i].data() : {};
      return {
        date,
        label: isToday && offset === 0 ? 'Today' : DAY_LABELS[i],
        morning: s.morningDuration || 0,
        evening: s.eveningDuration || 0,
        isToday: isToday && offset === 0,
      };
    });

    const morningVals = days.map(d => d.morning).filter(v => v > 0);
    const eveningVals = days.map(d => d.evening).filter(v => v > 0);
    const avgMorning = morningVals.length ? Math.round(morningVals.reduce((a, b) => a + b, 0) / morningVals.length) : 0;
    const avgEvening = eveningVals.length ? Math.round(eveningVals.reduce((a, b) => a + b, 0) / eveningVals.length) : 0;
    const todayData = days.find(d => d.isToday);
    const totalToday = todayData ? (todayData.morning || 0) + (todayData.evening || 0) : 0;

    res.json({ weekDates, days, summary: { avgMorning, avgEvening, totalToday }, todayStr, weekOffset: offset });
  } catch (err) {
    console.error('Trip duration week error:', err.message);
    res.status(500).json({ error: 'Failed to fetch trip duration week' });
  }
});

app.get('/api/bus/driver-notifications', async (req, res) => {
  try {
    const { driverId } = req.query;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });
    const q = db.collection('driver_notifications').where('driverId', '==', driverId);
    const snap = await q.get();
    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    notifications.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ notifications });
  } catch (err) {
    console.error('Driver notifications error:', err.message);
    res.status(500).json({ error: 'Failed to fetch driver notifications' });
  }
});

app.post('/api/bus/driver-notifications/read', async (req, res) => {
  try {
    const { notificationId } = req.body;
    if (!notificationId) return res.status(400).json({ error: 'notificationId required' });
    await db.collection('driver_notifications').doc(notificationId).update({ read: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Mark driver notification read error:', err.message);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

app.get('/api/admin/bus-alerts', async (req, res) => {
  try {
    const [logsSnap, requestsSnap, summariesSnap] = await Promise.all([
      db.collection('proximity_alert_logs').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get(),
      db.collection('location_change_requests').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get(),
      db.collection('trip_summaries').where('schoolId', '==', (req.schoolId || DEFAULT_SCHOOL_ID)).get(),
    ]);
    const logs = logsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const requests = requestsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const summaries = summariesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    logs.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
    requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    summaries.sort((a, b) => (b.tripDate || '').localeCompare(a.tripDate || ''));
    res.json({ logs: logs.slice(0, 100), requests: requests.slice(0, 50), summaries: summaries.slice(0, 50) });
  } catch (err) {
    console.error('Admin bus alerts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bus alerts' });
  }
});

setInterval(retrySyncErrors, 5 * 60 * 1000);

app.use((err, req, res, next) => {
  console.error('[Global Error]', err.message);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS: Origin not allowed' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.get('/api/admin/audit-report', verifyAuth, (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const path = require('path');
  res.setHeader('Content-Disposition', 'attachment; filename="sree-pragathi-audit-report.html"');
  res.sendFile(path.join(__dirname, 'audit-report.html'));
});


function scheduleDailyBackup() {
  function getMsUntilNext2AMIST() {
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + istOffsetMs);
    const next2AM = new Date(nowIST);
    next2AM.setHours(2, 0, 0, 0);
    if (nowIST >= next2AM) {
      next2AM.setDate(next2AM.getDate() + 1);
    }
    return next2AM.getTime() - nowIST.getTime();
  }

  const delay = getMsUntilNext2AMIST();
  setTimeout(() => {
    runDailyBackup().catch(e => console.error('[Backup] Scheduled backup error:', e.message));
    setInterval(() => {
      runDailyBackup().catch(e => console.error('[Backup] Scheduled backup error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

app.post('/api/admin/backup/trigger', verifyAuth, async (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  runDailyBackup().catch(e => console.error('[Backup] Manual trigger error:', e.message));
  res.json({ success: true, message: 'Backup started' });
});

app.post('/api/staff/checkin', verifyAuth, async (req, res) => {
  try {
    const { time, date } = req.body;
    const today = date || new Date().toISOString().slice(0, 10);
    const dutyRef = db.collection('staff_duty').doc(`${req.userId}_${today}`);
    await dutyRef.set({
      userId: req.userId,
      checkIn: time || new Date().toLocaleTimeString(),
      date: today,
      status: 'on_duty',
      schoolId: req.schoolId || DEFAULT_SCHOOL_ID,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    res.json({ success: true, message: 'Checked in successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Checkin error: ' + err.message });
  }
});

app.post('/api/teacher/checkout', verifyAuth, async (req, res) => {
  try {
    const { time, date } = req.body;
    const dutyRef = db.collection('staff_duty').doc(`${req.userId}_${date || new Date().toISOString().slice(0, 10)}`);
    await dutyRef.update({
      checkOut: time || new Date().toLocaleTimeString(),
      status: 'off_duty',
      updatedAt: new Date().toISOString()
    });
    res.json({ success: true, message: 'Checked out successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Checkout error: ' + err.message });
  }
});

app.get('/api/admin/backup/status', verifyAuth, async (req, res) => {
  if (req.userRole !== 'principal' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const adminDb = admin.firestore();

    const failureSnap = await adminDb.collection('admin_notifications')
      .where('type', '==', 'backup_failed')
      .limit(20)
      .get();
    const failures = failureSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 5);

    const successSnap = await adminDb.collection('backup_logs')
      .orderBy('timestamp', 'desc')
      .limit(5)
      .get();
    const successes = successSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const recentLogs = [...successes, ...failures].sort((a, b) =>
      (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || '')
    ).slice(0, 10);

    res.json({
      lastSuccess: successes[0] || null,
      lastFailure: failures[0] || null,
      recentLogs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/parent/fee-summary', verifyAuth, async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    const access = await ensureParentOwnsStudent(req, studentId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const feeQ = db.collection('fee_records').where('studentId', '==', studentId).where('schoolId', '==', schoolId);
    const feeSnap = await feeQ.get();
    if (feeSnap.empty) return res.json({ fee: null });

    const rec = feeSnap.docs[0].data();
    const totalFee = Number(rec.totalFee) || 0;
    const discount = Number(rec.discount) || 0;
    const fine = Number(rec.fine) || 0;
    const history = Array.isArray(rec.history) ? rec.history : [];
    const paid = history.reduce((a, h) => a + (Number(h.amount) || 0), 0);
    const pending = Math.max(totalFee - discount + fine - paid, 0);

    res.json({
      fee: {
        total: totalFee,
        discount,
        fine,
        paid,
        pending,
        history,
      }
    });
  } catch (err) {
    console.error('Parent fee summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch fee summary' });
  }
});

app.get('/api/bus/crew', verifyAuth, async (req, res) => {
  try {
    const { busNumber } = req.query;
    if (!busNumber) return res.status(400).json({ error: 'busNumber required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    const busQ = db.collection('buses').where('busNumber', '==', busNumber).where('schoolId', '==', schoolId);
    const busSnap = await busQ.get();
    if (busSnap.empty) return res.json({ crew: null });

    const bus = busSnap.docs[0].data();
    res.json({
      crew: {
        driver: {
          name: bus.driverName || '',
          id: bus.driverId || '',
        },
        cleaner: {
          name: bus.cleanerName || '',
          id: bus.cleanerId || '',
        },
        busNumber: bus.busNumber || busNumber,
        route: bus.route || '',
        capacity: bus.capacity || 0,
      }
    });
  } catch (err) {
    console.error('Bus crew error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bus crew' });
  }
});

app.get('/api/driver/my-bus', verifyAuth, async (req, res) => {
  try {
    const driverId = req.userId || req.query.driverId;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;

    let bus = null;

    const byDriverId = db.collection('buses').where('driverId', '==', driverId);
    const snap1 = await byDriverId.get();
    if (!snap1.empty) {
      const doc = snap1.docs[0];
      bus = { busId: doc.id, ...doc.data() };
    }

    if (!bus) {
      const userQ = db.collection('users').where('role_id', '==', driverId);
      const userSnap = await userQ.get();
      if (!userSnap.empty) {
        const userData = userSnap.docs[0].data();
        const driverName = userData.full_name || '';
        if (driverName) {
          const byName = db.collection('buses').where('driverName', '==', driverName);
          const snap2 = await byName.get();
          if (!snap2.empty) {
            const doc = snap2.docs[0];
            bus = { busId: doc.id, ...doc.data() };
          }
        }
        if (!bus && userData.bus_number) {
          const byNum = db.collection('buses').where('busNumber', '==', userData.bus_number);
          const snap3 = await byNum.get();
          if (!snap3.empty) {
            const doc = snap3.docs[0];
            bus = { busId: doc.id, ...doc.data() };
          }
        }
      }
    }

    if (!bus) return res.json({ success: true, bus: null });

    res.json({
      success: true,
      bus: {
        busId: bus.busId,
        busNumber: bus.busNumber || '',
        routeId: bus.routeId || bus.routeNumber || '',
        routeName: bus.routeName || bus.route || '',
        driverName: bus.driverName || '',
        driverId: bus.driverId || '',
        capacity: bus.capacity || 0,
        assignedStudents: bus.assignedStudents || bus.studentIds || [],
        status: bus.status || 'active',
      }
    });
  } catch (err) {
    console.error('Driver my-bus error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bus assignment' });
  }
});

app.post('/api/notifications/register-token', verifyAuth, async (req, res) => {
  try {
    const { userId, role, token } = req.body;
    if (!userId || !token) {
      return res.status(400).json({ error: 'userId and token required' });
    }
    const schoolId = req.schoolId || DEFAULT_SCHOOL_ID;
    await adminDb.collection('fcm_tokens').doc(userId).set({
      userId,
      role,
      token,
      schoolId,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Register token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const https = require('https');

function keepAlive() {
  setInterval(() => {
    https.get('https://venkeyschoolapp-updated.replit.app/health', (res) => {
      console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => {
      console.log(`Keep-alive error: ${err.message}`);
    });
  }, 4 * 60 * 1000);
}

keepAlive();

// If not running as a Vercel function, start the server
if (!process.env.VERCEL) {
  const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Vidyalayam server running on port ${PORT}`);
    console.log('Database: Firebase Firestore (project: ' + firebaseConfig.projectId + ')');
    console.log('Auth: Firebase Authentication (Email/Password) — NO FALLBACK');
    console.log('✅ CORS configured for ' + (process.env.NODE_ENV === 'production' ? 'production' : 'development'));
    console.log('✅ Validation middleware ready');
    console.log('✅ Rate limiting active');
    console.log('✅ Security headers enabled');
    
    scheduleAutoClockout();
    console.log('Auto clock-out scheduled: 7:00 PM daily');
    scheduleDailyBackup();
    console.log('[Backup] Scheduler started — next backup at 2 AM IST');

    try {
      const principalEmail = process.env.PRINCIPAL_EMAIL || 'thatipamulavenkatesh1999@gmail.com';
      const snapshot = await adminDb.collection('users')
        .where('email', '==', principalEmail)
        .get();
      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        if (userDoc.data().role !== 'principal') {
          await adminDb.collection('users').doc(userDoc.id).update({ role: 'principal' });
          console.log(`Updated ${principalEmail} role to principal`);
        }
      }
    } catch (err) {
      console.warn('Principal role setup warning:', err.message);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Retrying in 3 seconds...`);
      setTimeout(() => {
        server.close();
        server.listen(PORT, '0.0.0.0');
      }, 3000);
    } else {
      console.error('Server error:', err.message);
    }
  });
}

// Export for Vercel Serverless

app.get('/api/birthdays/today', verifyAuth, async (req, res) => {
  try {
    const today = new Date();
    // Assuming DOBs are stored in 'YYYY-MM-DD' or 'DD/MM/YYYY' or 'YYYY-M-D' etc.
    // To make it robust, we'll fetch all and filter in JS since Firestore can't easily query substring.
    const month = today.getMonth() + 1;
    const date = today.getDate();
    
    // We'll consider match if DOB string contains `-${String(month).padStart(2,'0')}-${String(date).padStart(2,'0')}`
    // or if parsed date matches month & day.
    function isBirthday(dobStr) {
      if (!dobStr) return false;
      try {
        const d = new Date(dobStr);
        if (!isNaN(d.getTime())) {
          return (d.getMonth() + 1 === month && d.getDate() === date);
        }
        // Fallback simple parsing
        const parts = dobStr.split(/[-/]/);
        if (parts.length >= 3) {
          if (parts[0].length === 4) { // YYYY-MM-DD
            return parseInt(parts[1], 10) === month && parseInt(parts[2], 10) === date;
          } else { // DD-MM-YYYY
            return parseInt(parts[1], 10) === month && parseInt(parts[0], 10) === date;
          }
        }
        return false;
      } catch(e) { return false; }
    }

    const schoolId = req.query.schoolId || req.schoolId || DEFAULT_SCHOOL_ID;
    
    const [studentsSnap, staffSnap, classesSnap, usersSnap] = await Promise.all([
      adminDb.collection('students').get(),
      adminDb.collection('users').get(), // Staff
      adminDb.collection('classes').get(), // To map class to teacher
      adminDb.collection('users').get() // To get all users for notifications
    ]);

    const bdayStudents = [];
    studentsSnap.forEach(doc => {
      const data = doc.data();
      if (isBirthday(data.dob)) {
        bdayStudents.push({ id: doc.id, ...data });
      }
    });

    const bdayStaff = [];
    const allUsers = [];
    usersSnap.forEach(doc => {
      const data = doc.data();
      allUsers.push({ id: doc.id, ...data });
      if (isBirthday(data.dob || data.dateOfBirth)) {
        bdayStaff.push({ id: doc.id, ...data });
      }
    });

    // Map classes to teachers
    const classToTeacher = {};
    classesSnap.forEach(doc => {
      const data = doc.data();
      if (data.teacherId) {
        classToTeacher[doc.id] = data.teacherId;
        classToTeacher[data.name] = data.teacherId;
        classToTeacher[data.grade] = data.teacherId;
      }
    });

    // Send Notifications
    if (req.query.notify === 'true') {
      const admins = allUsers.filter(u => u.role === 'admin');
      
      // Admin notifications
      admins.forEach(admin => {
        bdayStudents.forEach(stu => {
          const age = stu.dob ? (new Date().getFullYear() - new Date(stu.dob).getFullYear()) : '?';
          sendPushNotification(admin.id, `🎂 ${stu.name || stu.studentName}'s Birthday!`, `Class ${stu.className || stu.class} | Age ${age}`, { type: 'birthday' });
        });
        bdayStaff.forEach(staff => {
          sendPushNotification(admin.id, `🎂 ${staff.name}'s Birthday!`, `${staff.role}`, { type: 'birthday' });
        });
      });

      // Teacher notifications
      bdayStudents.forEach(stu => {
        const tId = classToTeacher[stu.classId] || classToTeacher[stu.className] || classToTeacher[stu.class];
        if (tId) {
          sendPushNotification(tId, `🎂 ${stu.name || stu.studentName}'s Birthday!`, `Class ${stu.className || stu.class} | Celebrate today! 🎉`, { type: 'birthday' });
        }
      });

      // Staff notifications
      allUsers.forEach(user => {
        if (user.role === 'admin' || user.role === 'parent' || user.role === 'student') return; // admins handled above
        bdayStaff.forEach(staff => {
          if (staff.id !== user.id) { // don't notify self
            sendPushNotification(user.id, `🎂 ${staff.name}'s Birthday!`, `Wish them today! 🎉`, { type: 'birthday' });
          }
        });
      });
    }

    
    let finalStudents = bdayStudents;
    let finalStaff = bdayStaff;
    
    // If the caller is a teacher, filter students to only their assigned classes
    if (req.user && req.user.role === 'teacher') {
      const myClasses = Object.keys(classToTeacher).filter(k => classToTeacher[k] === req.user.id);
      finalStudents = bdayStudents.filter(s => myClasses.includes(s.classId) || myClasses.includes(s.className) || myClasses.includes(s.class));
      finalStaff = []; // Teachers don't see staff birthdays in their class panel
    } else if (req.user && req.user.role !== 'admin') {
      // General staff sees other staff, but not students
      finalStudents = [];
    }
    
    res.json({ success: true, students: finalStudents, staff: finalStaff });

  } catch (error) {
    console.error('Error fetching birthdays:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
\nmodule.exports = app;
