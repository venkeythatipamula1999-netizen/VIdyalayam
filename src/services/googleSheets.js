const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

let _doc = null;
let _GoogleSpreadsheet = null;

async function getGoogleSpreadsheet() {
  if (_GoogleSpreadsheet) return _GoogleSpreadsheet;

  const mod = await import('google-spreadsheet');
  _GoogleSpreadsheet = mod.GoogleSpreadsheet || mod.default?.GoogleSpreadsheet || mod.default;

  if (!_GoogleSpreadsheet) {
    throw new Error('Failed to load google-spreadsheet module');
  }

  return _GoogleSpreadsheet;
}

async function getDoc() {
  if (!SPREADSHEET_ID) {
    throw new Error('GOOGLE_SPREADSHEET_ID env var is not set');
  }
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GoogleKey;
  if (!rawKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY (or GoogleKey) secret is not set');
  }

  if (_doc) return _doc;

  const creds = JSON.parse(rawKey);
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const GoogleSpreadsheet = await getGoogleSpreadsheet();
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID, auth);
  await doc.loadInfo();
  _doc = doc;
  return doc;
}

function resetDocCache() {
  _doc = null;
}

async function getOrCreateSheet(doc, title, headerValues) {
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await doc.addSheet({ title, headerValues });
    console.log(`Created Google Sheet tab: "${title}"`);
  }
  return sheet;
}

async function syncAttendance(records, date) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Attendance', [
      'Date', 'Student ID', 'Student Name', 'Class', 'Status', 'Teacher ID'
    ]);

    const rows = await sheet.getRows();
    const rowIndex = new Map();
    for (const row of rows) {
      const key = `${row.get('Date')}|${row.get('Student ID')}|${row.get('Class')}`;
      rowIndex.set(key, row);
    }

    for (const record of records) {
      const key = `${date}|${record.studentId}|${record.classId}`;
      const existingRow = rowIndex.get(key);

      if (existingRow) {
        existingRow.set('Status', record.status);
        existingRow.set('Student Name', record.studentName);
        existingRow.set('Teacher ID', record.markedBy || 'teacher');
        await existingRow.save();
      } else {
        const newRow = await sheet.addRow({
          'Date': date,
          'Student ID': record.studentId,
          'Student Name': record.studentName,
          'Class': record.classId,
          'Status': record.status,
          'Teacher ID': record.markedBy || 'teacher',
        });
        rowIndex.set(key, newRow);
      }
    }

    console.log(`Google Sheets: Synced ${records.length} attendance records for ${date}`);
    return { success: true, synced: records.length };
  } catch (err) {
    console.error('Google Sheets attendance sync error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncMarks(records, subject, examType) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Marks', [
      'Student ID', 'Student Name', 'Class', 'Subject', 'Exam Type', 'Marks', 'Max Marks', 'Teacher ID'
    ]);

    const rows = await sheet.getRows();
    const rowIndex = new Map();
    for (const row of rows) {
      const key = `${row.get('Student ID')}|${row.get('Subject')}|${row.get('Exam Type')}|${row.get('Class')}`;
      rowIndex.set(key, row);
    }

    for (const record of records) {
      const key = `${record.studentId}|${subject}|${examType}|${record.classId}`;
      const existingRow = rowIndex.get(key);

      if (existingRow) {
        existingRow.set('Student Name', record.studentName);
        existingRow.set('Marks', String(record.marksObtained));
        existingRow.set('Max Marks', String(record.maxMarks));
        existingRow.set('Teacher ID', record.recordedBy || 'teacher');
        await existingRow.save();
      } else {
        const newRow = await sheet.addRow({
          'Student ID': record.studentId,
          'Student Name': record.studentName,
          'Class': record.classId,
          'Subject': subject,
          'Exam Type': examType,
          'Marks': String(record.marksObtained),
          'Max Marks': String(record.maxMarks),
          'Teacher ID': record.recordedBy || 'teacher',
        });
        rowIndex.set(key, newRow);
      }
    }

    console.log(`Google Sheets: Synced ${records.length} marks records for ${subject} - ${examType}`);
    return { success: true, synced: records.length };
  } catch (err) {
    console.error('Google Sheets marks sync error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncUserDirectory(userData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'User_Directory', [
      'Teacher ID', 'Full Name', 'Role', 'Subject', 'Email', 'Phone', 'Status', 'Onboarded Date'
    ]);

    const rows = await sheet.getRows();
    const rowIndex = new Map();
    for (const row of rows) {
      rowIndex.set(row.get('Teacher ID'), row);
    }

    const existingRow = rowIndex.get(userData.teacherId);
    if (existingRow) {
      existingRow.set('Full Name', userData.fullName);
      existingRow.set('Role', userData.role);
      existingRow.set('Subject', userData.subject || '');
      existingRow.set('Email', userData.email || '');
      existingRow.set('Phone', userData.phone || '');
      existingRow.set('Status', userData.status || 'Pending Registration');
      existingRow.set('Onboarded Date', userData.onboardedDate);
      await existingRow.save();
    } else {
      await sheet.addRow({
        'Teacher ID': userData.teacherId,
        'Full Name': userData.fullName,
        'Role': userData.role,
        'Subject': userData.subject || '',
        'Email': userData.email || '',
        'Phone': userData.phone || '',
        'Status': userData.status || 'Pending Registration',
        'Onboarded Date': userData.onboardedDate,
      });
    }

    console.log(`Google Sheets: Synced user directory for ${userData.teacherId}`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets user directory sync error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateUserDirectoryOnRegistration(teacherId, email, uid) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'User_Directory', [
      'Teacher ID', 'Full Name', 'Role', 'Subject', 'Email', 'Phone', 'Status', 'Onboarded Date'
    ]);

    const rows = await sheet.getRows();
    let matched = null;
    for (const row of rows) {
      if (row.get('Teacher ID') === teacherId) {
        matched = row;
        break;
      }
    }

    if (matched) {
      matched.set('Status', 'Onboarded');
      matched.set('Email', email || matched.get('Email') || '');
      matched.set('Onboarded Date', new Date().toISOString().split('T')[0]);
      await matched.save();
      console.log(`Google Sheets: Updated User_Directory status to Onboarded for ${teacherId}`);
      return { success: true };
    }

    console.log(`Google Sheets: No User_Directory row found for ${teacherId} — skipping update`);
    return { success: false, error: 'Row not found' };
  } catch (err) {
    console.error('Google Sheets updateUserDirectory error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncLogisticsStaff(staffData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Logistics_Staff', [
      'Staff ID', 'Full Name', 'Type', 'Bus Number', 'Route', 'Assigned Area', 'Phone', 'Email', 'License', 'Experience', 'Status', 'Added Date'
    ]);

    const rows = await sheet.getRows();
    const rowIndex = new Map();
    for (const row of rows) {
      rowIndex.set(row.get('Staff ID'), row);
    }

    const existingRow = rowIndex.get(staffData.staffId);
    if (existingRow) {
      existingRow.set('Full Name', staffData.fullName);
      existingRow.set('Type', staffData.type);
      existingRow.set('Bus Number', staffData.busNumber || '');
      existingRow.set('Route', staffData.route || '');
      existingRow.set('Assigned Area', staffData.assignedArea || '');
      existingRow.set('Phone', staffData.phone || '');
      existingRow.set('Email', staffData.email || '');
      existingRow.set('License', staffData.license || '');
      existingRow.set('Experience', staffData.experience || '');
      existingRow.set('Status', staffData.status || 'Active');
      existingRow.set('Added Date', staffData.addedDate);
      await existingRow.save();
    } else {
      await sheet.addRow({
        'Staff ID': staffData.staffId,
        'Full Name': staffData.fullName,
        'Type': staffData.type,
        'Bus Number': staffData.busNumber || '',
        'Route': staffData.route || '',
        'Assigned Area': staffData.assignedArea || '',
        'Phone': staffData.phone || '',
        'Email': staffData.email || '',
        'License': staffData.license || '',
        'Experience': staffData.experience || '',
        'Status': staffData.status || 'Active',
        'Added Date': staffData.addedDate,
      });
    }

    console.log(`Google Sheets: Synced logistics staff ${staffData.staffId}`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets logistics staff sync error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateUserDirectoryClasses(teacherId, classes) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'User_Directory', [
      'Teacher ID', 'Full Name', 'Role', 'Subject', 'Email', 'Phone', 'Status', 'Onboarded Date', 'Classes'
    ]);

    const rows = await sheet.getRows();
    let matched = null;
    for (const row of rows) {
      if (row.get('Teacher ID') === teacherId) {
        matched = row;
        break;
      }
    }

    const classesStr = Array.isArray(classes) ? classes.join(', ') : '';

    if (matched) {
      matched.set('Classes', classesStr);
      await matched.save();
      console.log(`Google Sheets: Updated classes for ${teacherId}: ${classesStr}`);
      return { success: true };
    }

    console.log(`Google Sheets: No User_Directory row found for ${teacherId} — skipping class update`);
    return { success: false, error: 'Row not found' };
  } catch (err) {
    console.error('Google Sheets updateUserDirectoryClasses error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateProfileInSheets({ roleId, fullName, mobile, bloodGroup, emergencyContact, dateOfBirth, role, isLogistics }) {
  try {
    const doc = await getDoc();

    if (isLogistics) {
      const sheet = await getOrCreateSheet(doc, 'Logistics_Staff', [
        'Staff ID', 'Full Name', 'Type', 'Bus Number', 'Route', 'Assigned Area', 'Phone', 'Status', 'Added Date', 'Blood Group', 'Emergency Contact', 'Date of Birth'
      ]);

      const rows = await sheet.getRows();
      let matched = null;
      for (const row of rows) {
        if (row.get('Staff ID') === roleId) {
          matched = row;
          break;
        }
      }

      if (matched) {
        matched.set('Full Name', fullName);
        matched.set('Phone', mobile);
        matched.set('Blood Group', bloodGroup);
        matched.set('Emergency Contact', emergencyContact);
        matched.set('Date of Birth', dateOfBirth || '');
        await matched.save();
        console.log(`Google Sheets: Updated Logistics_Staff profile for ${roleId}`);
      } else {
        console.log(`Google Sheets: No Logistics_Staff row found for ${roleId}`);
      }
    } else {
      const sheet = await getOrCreateSheet(doc, 'User_Directory', [
        'Teacher ID', 'Full Name', 'Role', 'Subject', 'Email', 'Phone', 'Status', 'Onboarded Date', 'Blood Group', 'Emergency Contact', 'Date of Birth'
      ]);

      const rows = await sheet.getRows();
      let matched = null;
      for (const row of rows) {
        if (row.get('Teacher ID') === roleId) {
          matched = row;
          break;
        }
      }

      if (matched) {
        matched.set('Full Name', fullName);
        matched.set('Phone', mobile);
        matched.set('Blood Group', bloodGroup);
        matched.set('Emergency Contact', emergencyContact);
        matched.set('Date of Birth', dateOfBirth || '');
        await matched.save();
        console.log(`Google Sheets: Updated User_Directory profile for ${roleId}`);
      } else {
        console.log(`Google Sheets: No User_Directory row found for ${roleId}`);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('Google Sheets profile update error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateAdminProfileInSheets({ roleId, fullName, email, mobile, bloodGroup, profileImage }) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'User_Directory', [
      'Teacher ID', 'Full Name', 'Role', 'Subject', 'Email', 'Phone', 'Status', 'Onboarded Date', 'Blood Group', 'Emergency Contact', 'Date of Birth', 'Profile Photo'
    ]);

    const rows = await sheet.getRows();
    let matched = null;
    for (const row of rows) {
      if (row.get('Email') === email || row.get('Teacher ID') === roleId) {
        matched = row;
        break;
      }
    }

    if (matched) {
      if (mobile) matched.set('Phone', mobile);
      if (bloodGroup) matched.set('Blood Group', bloodGroup);
      if (profileImage) matched.set('Profile Photo', profileImage);
      await matched.save();
      console.log(`Google Sheets: Updated admin profile for ${email}`);
    } else {
      await sheet.addRow({
        'Teacher ID': roleId || 'ADMIN',
        'Full Name': fullName,
        'Role': 'Principal',
        'Subject': '',
        'Email': email,
        'Phone': mobile || '',
        'Status': 'Active',
        'Onboarded Date': new Date().toISOString().split('T')[0],
        'Blood Group': bloodGroup || '',
        'Emergency Contact': '',
        'Date of Birth': '',
        'Profile Photo': profileImage || '',
      });
      console.log(`Google Sheets: Created admin profile row for ${email}`);
    }

    return { success: true };
  } catch (err) {
    console.error('Google Sheets admin profile update error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncMasterTimetable(timetableEntries) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Master_Timetable', [
      'Teacher ID', 'Teacher Name', 'Class', 'Subject', 'Days', 'Start Time', 'End Time', 'Room', 'Status', 'Updated Date'
    ]);

    const rows = await sheet.getRows();
    const rowsByKey = new Map();
    for (const row of rows) {
      const key = `${row.get('Teacher ID')}|${row.get('Class')}`;
      rowsByKey.set(key, row);
    }

    for (const entry of timetableEntries) {
      const key = `${entry.teacherId}|${entry.className}`;
      const existingRow = rowsByKey.get(key);
      const daysStr = Array.isArray(entry.days) ? entry.days.join(', ') : '';

      if (existingRow) {
        existingRow.set('Teacher Name', entry.teacherName || '');
        existingRow.set('Subject', entry.subject || '');
        existingRow.set('Days', daysStr);
        existingRow.set('Start Time', entry.startTime || '');
        existingRow.set('End Time', entry.endTime || '');
        existingRow.set('Room', entry.room || '');
        existingRow.set('Status', entry.status || 'Active');
        existingRow.set('Updated Date', new Date().toISOString().split('T')[0]);
        await existingRow.save();
      } else {
        await sheet.addRow({
          'Teacher ID': entry.teacherId,
          'Teacher Name': entry.teacherName || '',
          'Class': entry.className,
          'Subject': entry.subject || '',
          'Days': daysStr,
          'Start Time': entry.startTime || '',
          'End Time': entry.endTime || '',
          'Room': entry.room || '',
          'Status': entry.status || 'Active',
          'Updated Date': new Date().toISOString().split('T')[0],
        });
      }
    }

    console.log(`Google Sheets: Synced ${timetableEntries.length} Master_Timetable entries`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets Master_Timetable sync error:', err.message);
    return { success: false, error: err.message };
  }
}

async function removeMasterTimetableEntries(teacherId, classNames) {
  try {
    const doc = await getDoc();
    const sheet = doc.sheetsByTitle['Master_Timetable'];
    if (!sheet) return { success: false, error: 'Sheet not found' };

    const rows = await sheet.getRows();
    for (const row of rows) {
      if (row.get('Teacher ID') === teacherId && classNames.includes(row.get('Class'))) {
        row.set('Status', 'Removed');
        row.set('Updated Date', new Date().toISOString().split('T')[0]);
        await row.save();
      }
    }

    console.log(`Google Sheets: Marked ${classNames.length} classes as Removed for ${teacherId}`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets removeMasterTimetable error:', err.message);
    return { success: false, error: err.message };
  }
}

async function markUserInactiveInSheets({ roleId, sheetName }) {
  try {
    const doc = await getDoc();
    const idColumn = sheetName === 'Logistics_Staff' ? 'Staff ID' : 'Teacher ID';
    const sheet = doc.sheetsByTitle[sheetName];
    if (!sheet) {
      console.log(`Google Sheets: Sheet "${sheetName}" not found — skipping inactive mark`);
      return { success: false, error: 'Sheet not found' };
    }

    const rows = await sheet.getRows();
    let matched = null;
    for (const row of rows) {
      if (row.get(idColumn) === roleId) {
        matched = row;
        break;
      }
    }

    if (matched) {
      matched.set('Status', 'Inactive');
      await matched.save();
      console.log(`Google Sheets: Marked ${roleId} as Inactive in ${sheetName}`);
      return { success: true };
    }

    console.log(`Google Sheets: No row found for ${roleId} in ${sheetName}`);
    return { success: false, error: 'Row not found' };
  } catch (err) {
    console.error('Google Sheets markInactive error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncStudentFile({ studentId, studentName, className, fileName, fileUrl, uploadedBy, date }) {
  try {
    const doc = await getDoc();
    if (!doc) return { success: false, error: 'No spreadsheet' };
    let sheet = doc.sheetsByTitle['Student_Files'];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Student_Files', headerValues: ['Student ID', 'Student Name', 'Class', 'File Name', 'File URL', 'Uploaded By', 'Date'] });
    }
    await sheet.addRow({
      'Student ID': studentId,
      'Student Name': studentName,
      'Class': className,
      'File Name': fileName,
      'File URL': fileUrl,
      'Uploaded By': uploadedBy,
      'Date': date,
    });
    console.log(`Google Sheets: Synced student file ${fileName} for ${studentName}`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets syncStudentFile error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncBusTripHistory({ driverId, driverName, busNumber, route, tripType, startTime, endTime, duration }) {
  try {
    const doc = await getDoc();
    if (!doc) return { success: false, error: 'No spreadsheet' };
    let sheet = doc.sheetsByTitle['Bus_Logistics_History'];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Bus_Logistics_History', headerValues: ['Driver ID', 'Driver Name', 'Bus Number', 'Route', 'Trip Type', 'Start Time', 'End Time', 'Duration (min)', 'Date'] });
    }
    await sheet.addRow({
      'Driver ID': driverId,
      'Driver Name': driverName,
      'Bus Number': busNumber,
      'Route': route,
      'Trip Type': tripType,
      'Start Time': startTime,
      'End Time': endTime,
      'Duration (min)': duration,
      'Date': new Date().toLocaleDateString('en-IN'),
    });
    console.log(`Google Sheets: Synced bus trip for ${driverName} (${busNumber})`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets syncBusTripHistory error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncStudentStop({ studentId, studentName, className, route, lat, lng, setBy, date }) {
  try {
    const doc = await getDoc();
    if (!doc) return { success: false, error: 'No spreadsheet' };
    let sheet = doc.sheetsByTitle['Students'];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Students', headerValues: ['Student ID', 'Student Name', 'Class', 'Route', 'Home_Latitude', 'Home_Longitude', 'Set By', 'Date'] });
    }
    const rows = await sheet.getRows();
    const existingRow = rows.find(r => r.get('Student ID') === String(studentId));
    if (existingRow) {
      existingRow.set('Home_Latitude', String(lat));
      existingRow.set('Home_Longitude', String(lng));
      existingRow.set('Set By', setBy || '');
      existingRow.set('Date', date || new Date().toLocaleDateString('en-IN'));
      await existingRow.save();
    } else {
      await sheet.addRow({
        'Student ID': String(studentId),
        'Student Name': studentName,
        'Class': className || '',
        'Route': route || '',
        'Home_Latitude': String(lat),
        'Home_Longitude': String(lng),
        'Set By': setBy || '',
        'Date': date || new Date().toLocaleDateString('en-IN'),
      });
    }
    console.log(`Google Sheets: Synced stop for ${studentName} (${lat}, ${lng})`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets syncStudentStop error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncStaffAttendance({ name, role, roleId, clockIn, clockOut, status, date }) {
  try {
    const doc = await getDoc();
    if (!doc) return { success: false, error: 'No spreadsheet' };
    let sheet = doc.sheetsByTitle['Daily_Attendance'];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Daily_Attendance', headerValues: ['Date', 'Name', 'Role', 'Role ID', 'In_Time', 'Out_Time', 'Hours_Worked', 'Current_Status'] });
    }
    const rows = await sheet.getRows();
    const existingRow = rows.find(r => r.get('Date') === date && r.get('Role ID') === roleId);
    const hoursWorked = clockIn && clockOut ? ((new Date(`2000-01-01T${clockOut}`) - new Date(`2000-01-01T${clockIn}`)) / 3600000).toFixed(1) : '';
    if (existingRow) {
      if (clockOut) existingRow.set('Out_Time', clockOut);
      if (status) existingRow.set('Current_Status', status);
      if (hoursWorked) existingRow.set('Hours_Worked', hoursWorked);
      await existingRow.save();
    } else {
      await sheet.addRow({
        'Date': date,
        'Name': name,
        'Role': role,
        'Role ID': roleId,
        'In_Time': clockIn || '',
        'Out_Time': clockOut || '',
        'Hours_Worked': hoursWorked,
        'Current_Status': status || 'On Duty',
      });
    }
    console.log(`Google Sheets: Synced staff attendance for ${name} (${date})`);
    return { success: true };
  } catch (err) {
    console.error('Google Sheets syncStaffAttendance error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncStudent(studentData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Students', [
      'studentId', 'name', 'rollNumber', 'class', 'section', 'parentName', 'parentPhone', 'createdAt',
    ]);
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('studentId') === String(studentData.studentId));
    const rowObj = {
      name: studentData.name || '',
      rollNumber: String(studentData.rollNumber || ''),
      class: studentData.className || studentData.classId || '',
      section: studentData.section || '',
      parentName: studentData.parentName || '',
      parentPhone: studentData.parentPhone || '',
    };
    if (existing) {
      for (const [k, v] of Object.entries(rowObj)) existing.set(k, v);
      await existing.save();
    } else {
      await sheet.addRow({ studentId: String(studentData.studentId), ...rowObj, createdAt: studentData.createdAt || new Date().toISOString() });
    }
    console.log(`[GSheets] Synced student ${studentData.studentId}`);
    return { success: true };
  } catch (err) {
    _doc = null;
    console.error('[GSheets] syncStudent error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncTeacher(teacherData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Teachers', [
      'teacherId', 'name', 'email', 'phone', 'subject', 'classTeacherOf', 'designation', 'joiningDate', 'createdAt',
    ]);
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('teacherId') === String(teacherData.teacherId));
    const rowObj = {
      name: teacherData.name || '',
      email: teacherData.email || '',
      phone: teacherData.phone || '',
      subject: teacherData.subject || '',
      classTeacherOf: teacherData.classTeacherOf || '',
      designation: teacherData.designation || teacherData.role || '',
      joiningDate: teacherData.joiningDate || teacherData.joinDate || '',
    };
    if (existing) {
      for (const [k, v] of Object.entries(rowObj)) existing.set(k, v);
      await existing.save();
    } else {
      await sheet.addRow({ teacherId: String(teacherData.teacherId), ...rowObj, createdAt: teacherData.createdAt || new Date().toISOString() });
    }
    console.log(`[GSheets] Synced teacher ${teacherData.teacherId}`);
    return { success: true };
  } catch (err) {
    _doc = null;
    console.error('[GSheets] syncTeacher error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncLeaveRequest(leaveData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'LeaveRequests', [
      'leaveId', 'type', 'applicantId', 'applicantName', 'class', 'leaveType', 'fromDate', 'toDate', 'reason', 'status', 'actionedBy', 'actionedAt', 'submittedAt',
    ]);
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('leaveId') === String(leaveData.leaveId));
    const isStudent = (leaveData.type || '').toLowerCase() === 'student';
    const rowObj = {
      type: isStudent ? 'Student' : 'Staff',
      applicantId: String(leaveData.applicantId || leaveData.studentId || leaveData.roleId || ''),
      applicantName: leaveData.applicantName || leaveData.studentName || leaveData.employeeName || '',
      class: leaveData.class || leaveData.studentClass || '',
      leaveType: leaveData.leaveType || leaveData.reasonLabel || '',
      fromDate: leaveData.fromDate || leaveData.from || '',
      toDate: leaveData.toDate || leaveData.to || '',
      reason: leaveData.reason || leaveData.customReason || '',
      status: leaveData.status || 'Pending',
      actionedBy: leaveData.actionedBy || leaveData.approvedBy || '',
      actionedAt: leaveData.actionedAt || leaveData.approvedAt || '',
      submittedAt: leaveData.submittedAt || '',
    };
    if (existing) {
      for (const [k, v] of Object.entries(rowObj)) existing.set(k, v);
      await existing.save();
    } else {
      await sheet.addRow({ leaveId: String(leaveData.leaveId), ...rowObj });
    }
    console.log(`[GSheets] Synced leave request ${leaveData.leaveId}`);
    return { success: true };
  } catch (err) {
    _doc = null;
    console.error('[GSheets] syncLeaveRequest error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncParentAccount(parentData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'ParentAccounts', [
      'parentId', 'parentName', 'email', 'phone', 'linkedStudentId', 'studentName', 'studentClass', 'registeredAt', 'accountStatus',
    ]);
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('parentId') === String(parentData.parentId));
    const rowObj = {
      parentName: parentData.parentName || '',
      email: parentData.email || '',
      phone: parentData.phone || '',
      linkedStudentId: parentData.linkedStudentId || '',
      studentName: parentData.studentName || '',
      studentClass: parentData.studentClass || '',
      registeredAt: parentData.registeredAt || new Date().toISOString(),
      accountStatus: parentData.accountStatus || 'active',
    };
    if (existing) {
      for (const [k, v] of Object.entries(rowObj)) existing.set(k, v);
      await existing.save();
    } else {
      await sheet.addRow({ parentId: String(parentData.parentId), ...rowObj });
    }
    console.log(`[GSheets] Synced parent account ${parentData.parentId}`);
    return { success: true };
  } catch (err) {
    _doc = null;
    console.error('[GSheets] syncParentAccount error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncPayroll(payrollData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Payroll', [
      'employeeId', 'employeeName', 'month', 'year', 'basicSalary', 'hra', 'da', 'ta', 'specialAllowance', 'grossSalary',
      'pf', 'tax', 'lopDays', 'lopDeduction', 'totalDeductions', 'netPayable',
      'daysPresent', 'daysAbsent', 'halfDays', 'totalActiveHours', 'creditStatus', 'creditedAt',
    ]);
    const rows = await sheet.getRows();
    const existing = rows.find(r =>
      r.get('employeeId') === String(payrollData.employeeId) &&
      r.get('month') === String(payrollData.month) &&
      r.get('year') === String(payrollData.year)
    );
    const rowObj = {
      employeeName: payrollData.employeeName || '',
      month: String(payrollData.month || ''),
      year: String(payrollData.year || ''),
      basicSalary: String(payrollData.basicSalary || 0),
      hra: String(payrollData.hra || 0),
      da: String(payrollData.da || 0),
      ta: String(payrollData.ta || 0),
      specialAllowance: String(payrollData.specialAllowance || 0),
      grossSalary: String(payrollData.grossSalary || 0),
      pf: String(payrollData.pf || 0),
      tax: String(payrollData.tax || 0),
      lopDays: String(payrollData.lopDays || 0),
      lopDeduction: String(payrollData.lopDeduction || 0),
      totalDeductions: String(payrollData.totalDeductions || 0),
      netPayable: String(payrollData.netPayable || 0),
      daysPresent: String(payrollData.daysPresent || 0),
      daysAbsent: String(payrollData.daysAbsent || 0),
      halfDays: String(payrollData.halfDays || 0),
      totalActiveHours: String(payrollData.totalActiveHours || 0),
      creditStatus: payrollData.creditStatus || 'Pending',
      creditedAt: payrollData.creditedAt || '',
    };
    if (existing) {
      for (const [k, v] of Object.entries(rowObj)) existing.set(k, v);
      await existing.save();
    } else {
      await sheet.addRow({ employeeId: String(payrollData.employeeId), ...rowObj });
    }
    console.log(`[GSheets] Synced payroll for ${payrollData.employeeId} (${payrollData.month}/${payrollData.year})`);
    return { success: true };
  } catch (err) {
    _doc = null;
    console.error('[GSheets] syncPayroll error:', err.message);
    return { success: false, error: err.message };
  }
}

async function syncNotification(notifData) {
  try {
    const doc = await getDoc();
    const sheet = await getOrCreateSheet(doc, 'Notifications', [
      'notifId', 'type', 'recipientId', 'recipientRole', 'title', 'message', 'channel', 'sentAt',
    ]);
    await sheet.addRow({
      notifId: String(notifData.notifId || `NOTIF-${Date.now()}`),
      type: notifData.type || '',
      recipientId: notifData.recipientId || '',
      recipientRole: notifData.recipientRole || '',
      title: notifData.title || '',
      message: notifData.message || '',
      channel: notifData.channel || 'in-app',
      sentAt: notifData.sentAt || new Date().toISOString(),
    });
    console.log(`[GSheets] Logged notification: ${notifData.title}`);
    return { success: true };
  } catch (err) {
    _doc = null;
    console.error('[GSheets] syncNotification error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  syncAttendance, syncMarks, syncUserDirectory, updateUserDirectoryOnRegistration,
  syncLogisticsStaff, updateUserDirectoryClasses, updateProfileInSheets,
  updateAdminProfileInSheets, markUserInactiveInSheets, syncMasterTimetable,
  removeMasterTimetableEntries, syncStudentFile, syncBusTripHistory,
  syncStudentStop, syncStaffAttendance,
  syncStudent, syncTeacher, syncLeaveRequest, syncParentAccount, syncPayroll, syncNotification,
  resetDocCache,
};
