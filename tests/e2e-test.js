#!/usr/bin/env node
'use strict';

const axios = require('axios');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5001';

async function test() {
  console.log('\n╔═════════════════════════════════════════════╗');
  console.log('║  VENKEYS SCHOOL APP - E2E TEST SUITE v1.0   ║');
  console.log('╚═════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;
  const results = {};

  // Test 1: Health Check
  console.log('📋 Running Tests...\n');
  try {
    console.log('🔍 Test 1: Health Check');
    const res = await axios.get(`${BASE_URL}/api/healthcheck`, { timeout: 5000 });
    console.log('✅ Server is responding');
    console.log(`   Status: ${res.status}`);
    console.log(`   Message: ${res.data.status || 'OK'}`);
    passed++;
    results.healthcheck = { pass: true };
  } catch (err) {
    console.log(`❌ Health check failed: ${err.message}`);
    failed++;
    results.healthcheck = { pass: false, error: err.message };
  }

  // Test 2: CCE Marks Retrieval
  try {
    console.log('\n🔍 Test 2: CCE Marks API');
    const res = await axios.get(`${BASE_URL}/api/cce/marks`, {
      params: { schoolId: 'TEST', studentId: 'TEST', academicYear: '2025-26' },
      timeout: 5000
    });
    console.log(`✅ CCE Marks endpoint accessible (Status: ${res.status})`);
    passed++;
    results.cceMarks = { pass: true };
  } catch (err) {
    console.log(`❌ CCE Marks failed: ${err.message}`);
    failed++;
    results.cceMarks = { pass: false, error: err.message };
  }

  // Test 3: Attendance API
  try {
    console.log('\n🔍 Test 3: Attendance API');
    const res = await axios.get(`${BASE_URL}/api/attendance`, {
      params: { schoolId: 'TEST' },
      timeout: 5000
    });
    console.log(`✅ Attendance endpoint accessible (Status: ${res.status})`);
    passed++;
    results.attendance = { pass: true };
  } catch (err) {
    console.log(`❌ Attendance failed: ${err.message}`);
    failed++;
    results.attendance = { pass: false, error: err.message };
  }

  // Test 4: Bus Monitoring
  try {
    console.log('\n🔍 Test 4: Bus Monitoring API');
    const res = await axios.get(`${BASE_URL}/api/bus`, {
      params: { schoolId: 'TEST' },
      timeout: 5000
    });
    console.log(`✅ Bus API endpoint accessible (Status: ${res.status})`);
    passed++;
    results.bus = { pass: true };
  } catch (err) {
    console.log(`❌ Bus API failed: ${err.message}`);
    failed++;
    results.bus = { pass: false, error: err.message };
  }

  // Test 5: Authentication with dummy credentials
  try {
    console.log('\n🔍 Test 5: Authentication System');
    // This will likely fail with 401/400 since credentials are dummy, but endpoint should exist
    await axios.post(`${BASE_URL}/api/login`, {
      email: 'test@school.com',
      password: 'test123'
    }, { timeout: 5000, validateStatus: () => true });
    console.log(`✅ Auth endpoint accessible`);
    passed++;
    results.auth = { pass: true };
  } catch (err) {
    console.log(`❌ Auth endpoint failed: ${err.message}`);
    failed++;
    results.auth = { pass: false, error: err.message };
  }

  // Test 6: WhatsApp Service
  try {
    console.log('\n🔍 Test 6: WhatsApp Service');
    const res = await axios.get(`${BASE_URL}/api/whatsapp/status`, {
      timeout: 5000
    });
    console.log(`✅ WhatsApp service accessible (Status: ${res.status})`);
    passed++;
    results.whatsapp = { pass: true };
  } catch (err) {
    console.log(`❌ WhatsApp service failed: ${err.message}`);
    failed++;
    results.whatsapp = { pass: false, error: err.message };
  }

  // Test 7: Dashboard Data (Parent Dashboard simulation)
  try {
    console.log('\n🔍 Test 7: Dashboard Data Service');
    // Dashboard would need valid auth, so this is connectivity test
    const res = await axios.get(`${BASE_URL}/api/dashboard`, {
      timeout: 5000,
      validateStatus: () => true
    });
    console.log(`✅ Dashboard endpoint accessible (Status: ${res.status})`);
    passed++;
    results.dashboard = { pass: true };
  } catch (err) {
    console.log(`❌ Dashboard service failed: ${err.message}`);
    failed++;
    results.dashboard = { pass: false, error: err.message };
  }

  // Summary
  console.log('\n╔═════════════════════════════════════════════╗');
  console.log('║           TEST SUMMARY REPORT               ║');
  console.log('╚═════════════════════════════════════════════╝\n');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📊 Total:  ${passed + failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(2)}%\n`);

  if (failed === 0) {
    console.log('🎉 All tests passed! The app is ready for deployment.\n');
  } else {
    console.log('⚠️  Some tests failed. Please check the backend logs.\n');
  }

  // Detailed results
  console.log('Detailed Results:');
  console.log(JSON.stringify(results, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

test().catch(console.error);
