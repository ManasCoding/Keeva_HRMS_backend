import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import RegisteredDevice from '../models/RegisteredDevice.js';
import ActivityLog from '../models/ActivityLog.js';
import SystemSetting from '../models/SystemSetting.js';
import {
  generateSignedQrToken,
  verifySignedQrToken,
  generateDeviceCredential,
  hashDeviceCredential,
  getGreetingIST
} from '../utils/qrToken.js';
import {
  calculateAttendanceStatus,
  getTodayDateIST,
  getTimeStringIST
} from '../utils/attendanceCalculator.js';

// Helper to get or create permanent office QR token persisted in SystemSetting
const getOfficePermanentToken = async () => {
  let setting = await SystemSetting.findOne({ key: 'office_permanent_qr_token' });
  if (setting && setting.value) {
    const v = verifySignedQrToken(setting.value);
    if (v.valid) {
      return {
        token: setting.value,
        isPermanent: true,
        expiresAt: null,
        expiresInSeconds: null
      };
    }
  }

  // Generate new permanent token and persist in DB
  const newToken = generateSignedQrToken('permanent');
  await SystemSetting.findOneAndUpdate(
    { key: 'office_permanent_qr_token' },
    { value: newToken.token },
    { upsert: true }
  );
  return newToken;
};

// Cached in-memory active QR token for smooth refresh (if rotating mode is used)
let activeQrTokenCache = null;

const getActiveToken = (expirySeconds = 60) => {
  const now = Date.now();
  if (activeQrTokenCache && new Date(activeQrTokenCache.expiresAt).getTime() - now > 5000) {
    return activeQrTokenCache;
  }
  activeQrTokenCache = generateSignedQrToken(expirySeconds);
  return activeQrTokenCache;
};

// Helper to get client IP
const getClientIp = (req) => {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
};

// Helper to apply display status to attendance
const applyAttendanceDisplay = (attendance) => {
  if (!attendance) return null;
  const doc = attendance.toObject ? attendance.toObject() : { ...attendance };
  const calc = calculateAttendanceStatus(doc);
  doc.status = calc.status;
  doc.workHours = calc.workHours;
  doc.overtime = calc.overtime;
  doc.workingSeconds = calc.workingSeconds;
  doc.overtimeSeconds = calc.overtimeSeconds;
  doc.isLate = calc.isLate;
  doc.lateMinutes = calc.lateMinutes;
  return doc;
};

// ─── 1. PUBLIC: Validate QR Token ──────────────────────────────────────────────
export const validateQrToken = async (req, res) => {
  try {
    const { token } = req.query;
    const verification = verifySignedQrToken(token);
    if (!verification.valid) {
      return res.status(400).json({
        success: false,
        error: verification.error,
        message: verification.message
      });
    }

    return res.json({
      success: true,
      valid: true,
      expiresAt: verification.payload.exp
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 2. PUBLIC: Automated QR Scan (Returning Registered Employee) ─────────────
export const scanQrAttendance = async (req, res) => {
  const { qrToken, deviceToken, lat, lng } = req.body;
  const clientIp = getClientIp(req);
  const now = new Date();
  const today = getTodayDateIST();

  // Validate QR Token
  const tokenVer = verifySignedQrToken(qrToken);
  if (!tokenVer.valid) {
    return res.status(400).json({
      success: false,
      error: tokenVer.error,
      message: tokenVer.message
    });
  }

  if (!deviceToken) {
    return res.status(401).json({
      success: false,
      error: 'DEVICE_NOT_REGISTERED',
      message: 'No device credential found. Please log in to register this mobile device.'
    });
  }

  try {
    // Identify Device
    const hashedToken = hashDeviceCredential(deviceToken);
    const registeredDevice = await RegisteredDevice.findOne({ deviceTokenHash: hashedToken }).populate('employeeId');

    if (!registeredDevice || !registeredDevice.employeeId || registeredDevice.status === 'Unregistered') {
      return res.status(401).json({
        success: false,
        error: 'DEVICE_NOT_REGISTERED',
        message: 'This device is not registered. Please log in to bind this mobile device.'
      });
    }

    if (registeredDevice.status === 'Blocked') {
      // Log failed attempt
      registeredDevice.scanHistory.push({
        action: 'FAILED',
        timestamp: now,
        ipAddress: clientIp,
        status: 'Blocked',
        remarks: 'Blocked device attempted attendance'
      });
      await registeredDevice.save();

      return res.status(403).json({
        success: false,
        error: 'DEVICE_BLOCKED',
        message: 'This device has been blocked by the Administrator. Please contact HR.'
      });
    }

    const employee = registeredDevice.employeeId;
    if (employee.status && employee.status !== 'Active') {
      return res.status(403).json({
        success: false,
        error: 'EMPLOYEE_INACTIVE',
        message: 'Your employee account is currently inactive. Please contact HR.'
      });
    }

    // Check Sunday
    const tzStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const localDate = new Date(tzStr);
    if (localDate.getDay() === 0) {
      return res.json({
        success: false,
        error: 'SUNDAY',
        message: 'Today is Sunday — no attendance required.'
      });
    }

    // Check Existing Attendance Today
    let attendance = await Attendance.findOne({ employeeId: employee._id, date: today });

    // ── CASE 1: FIRST SCAN — Check-In ──────────────────────────────────────────
    if (!attendance || !attendance.checkIn) {
      const currentHour = localDate.getHours();
      const currentMin  = localDate.getMinutes();
      const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;

      const thresholdMins = 9 * 60 + 30; // 09:30 AM IST
      const currentTotalMins = currentHour * 60 + currentMin;
      const lateMinutes = Math.max(0, currentTotalMins - thresholdMins);

      let status = 'Present';
      let isLate = false;
      let checkInApprovalStatus = 'Not Required';
      let approvalRequestedAt = null;
      let exceptionType = 'None';

      if (currentTimeStr >= '13:30') {
        // At or after 1:30 PM — Half Day pending approval
        isLate = true;
        checkInApprovalStatus = 'Pending';
        approvalRequestedAt = now;
        exceptionType = 'Half Day';
        status = 'Half Day';
      } else if (currentTimeStr > '09:30') {
        // After 9:30 AM — Late mark pending approval
        isLate = true;
        checkInApprovalStatus = 'Pending';
        approvalRequestedAt = now;
        exceptionType = 'Late';
        status = 'Late';
      }

      const locationObj = (lat !== undefined && lng !== undefined) ? { lat: Number(lat), lng: Number(lng) } : undefined;

      if (!attendance) {
        attendance = await Attendance.create({
          employeeId: employee._id,
          date: today,
          checkIn: now,
          location: locationObj,
          status,
          isLate,
          lateMinutes,
          checkInApprovalStatus,
          approvalRequestedAt,
          exceptionType,
          remarks: 'QR Attendance'
        });
      } else {
        attendance.checkIn = now;
        if (locationObj) attendance.location = locationObj;
        attendance.status = status;
        attendance.isLate = isLate;
        attendance.lateMinutes = lateMinutes;
        attendance.checkInApprovalStatus = checkInApprovalStatus;
        attendance.approvalRequestedAt = approvalRequestedAt;
        attendance.exceptionType = exceptionType;
        attendance.remarks = 'QR Attendance';
        await attendance.save();
      }

      // Update Device Stats & History
      registeredDevice.lastUsedDate = now;
      registeredDevice.lastIpAddress = clientIp;
      registeredDevice.scanHistory.push({
        action: 'CHECK-IN',
        timestamp: now,
        ipAddress: clientIp,
        status: 'Success',
        remarks: `QR Check-In at ${getTimeStringIST(now)} (${status})`
      });
      await registeredDevice.save();

      // Log Activity
      await ActivityLog.create({
        employeeId: employee._id,
        action: 'QR Check-In',
        status: 'Success',
        ipAddress: clientIp,
        device: registeredDevice.deviceModel || 'Mobile Device',
        browser: registeredDevice.browser || 'Browser',
        location: 'Office QR Terminal'
      });

      return res.json({
        success: true,
        action: 'CHECK-IN',
        greeting: getGreetingIST(now),
        employee: {
          id: employee._id,
          fullName: employee.fullName,
          empCode: employee.empCode,
          profileImage: employee.profileImage,
          department: employee.department,
          role: employee.role
        },
        attendance: {
          date: today,
          checkIn: now,
          checkInTime: getTimeStringIST(now),
          status: attendance.status,
          isLate: attendance.isLate,
          lateMinutes: attendance.lateMinutes
        },
        message: 'Your check-in has been successfully recorded.'
      });
    }

    // ── CASE 2: SECOND SCAN — Check-Out ────────────────────────────────────────
    if (attendance.checkIn && !attendance.checkOut) {
      attendance.checkOut = now;
      attendance.workStatus = 'Completed';
      attendance.lastExitTime = null;

      const calc = calculateAttendanceStatus(attendance, { currentTime: now });
      attendance.status = calc.status;
      attendance.workHours = calc.workHours;
      attendance.overtime = calc.overtime;
      attendance.totalWorkingSeconds = calc.workingSeconds;
      attendance.totalOvertimeSeconds = calc.overtimeSeconds;

      await attendance.save();

      // Update Device Stats & History
      registeredDevice.lastUsedDate = now;
      registeredDevice.lastIpAddress = clientIp;
      registeredDevice.scanHistory.push({
        action: 'CHECK-OUT',
        timestamp: now,
        ipAddress: clientIp,
        status: 'Success',
        remarks: `QR Check-Out at ${getTimeStringIST(now)} (Hours: ${calc.workHours})`
      });
      await registeredDevice.save();

      // Log Activity
      await ActivityLog.create({
        employeeId: employee._id,
        action: 'QR Check-Out',
        status: 'Success',
        ipAddress: clientIp,
        device: registeredDevice.deviceModel || 'Mobile Device',
        browser: registeredDevice.browser || 'Browser',
        location: 'Office QR Terminal'
      });

      return res.json({
        success: true,
        action: 'CHECK-OUT',
        greeting: getGreetingIST(now),
        employee: {
          id: employee._id,
          fullName: employee.fullName,
          empCode: employee.empCode,
          profileImage: employee.profileImage,
          department: employee.department,
          role: employee.role
        },
        attendance: {
          date: today,
          checkIn: attendance.checkIn,
          checkInTime: getTimeStringIST(attendance.checkIn),
          checkOut: now,
          checkOutTime: getTimeStringIST(now),
          workHours: attendance.workHours,
          overtime: attendance.overtime,
          status: attendance.status
        },
        message: 'Your check-out has been successfully recorded.'
      });
    }

    // ── CASE 3: THIRD SCAN — Already Completed ─────────────────────────────────
    registeredDevice.scanHistory.push({
      action: 'COMPLETED_ATTEMPT',
      timestamp: now,
      ipAddress: clientIp,
      status: 'Notice',
      remarks: 'Scanned after daily check-out completed'
    });
    await registeredDevice.save();

    return res.json({
      success: false,
      action: 'ALREADY_COMPLETED',
      greeting: getGreetingIST(now),
      employee: {
        id: employee._id,
        fullName: employee.fullName,
        empCode: employee.empCode,
        profileImage: employee.profileImage
      },
      attendance: {
        date: today,
        checkIn: attendance.checkIn,
        checkInTime: getTimeStringIST(attendance.checkIn),
        checkOut: attendance.checkOut,
        checkOutTime: getTimeStringIST(attendance.checkOut),
        workHours: attendance.workHours,
        status: attendance.status
      },
      message: "Today's attendance is already completed!"
    });

  } catch (error) {
    console.error('scanQrAttendance error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── 3. PUBLIC: First-Time Registration & Scan ─────────────────────────────────
export const registerAndScan = async (req, res) => {
  const { loginId, password, qrToken, deviceInfo = {}, lat, lng } = req.body;
  const clientIp = getClientIp(req);
  const now = new Date();
  const today = getTodayDateIST();

  // Validate QR Token
  const tokenVer = verifySignedQrToken(qrToken);
  if (!tokenVer.valid) {
    return res.status(400).json({
      success: false,
      error: tokenVer.error,
      message: tokenVer.message
    });
  }

  if (!loginId || !password) {
    return res.status(400).json({
      success: false,
      message: 'Employee ID and password are required for device registration.'
    });
  }

  try {
    // Authenticate Employee
    const employee = await Employee.findOne({
      $or: [
        { email: loginId.trim() },
        { empCode: loginId.trim() }
      ]
    });

    if (!employee || employee.password !== password) {
      return res.status(401).json({
        success: false,
        message: 'Invalid Employee ID or password. Please try again.'
      });
    }

    if (employee.status && employee.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Your employee account is inactive. Please contact HR.'
      });
    }

    // Generate high-entropy persistent device credential
    const rawDeviceCredential = generateDeviceCredential();
    const deviceTokenHash = hashDeviceCredential(rawDeviceCredential);

    // Register Device (Upsert single active device per employee)
    let registeredDevice = await RegisteredDevice.findOne({ employeeId: employee._id });
    if (!registeredDevice) {
      registeredDevice = new RegisteredDevice({ employeeId: employee._id });
    }

    registeredDevice.deviceTokenHash = deviceTokenHash;
    registeredDevice.deviceName = deviceInfo.deviceName || 'Mobile Device';
    registeredDevice.deviceModel = deviceInfo.deviceModel || deviceInfo.deviceName || 'Smartphone';
    registeredDevice.os = deviceInfo.os || 'Android';
    registeredDevice.browser = deviceInfo.browser || 'Chrome';
    registeredDevice.status = 'Active';
    registeredDevice.registrationDate = now;
    registeredDevice.lastUsedDate = now;
    registeredDevice.lastIpAddress = clientIp;

    // Check Sunday
    const tzStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const localDate = new Date(tzStr);
    if (localDate.getDay() === 0) {
      await registeredDevice.save();
      return res.json({
        success: true,
        registered: true,
        deviceToken: rawDeviceCredential,
        action: 'REGISTER_ONLY',
        greeting: getGreetingIST(now),
        employee: {
          id: employee._id,
          fullName: employee.fullName,
          empCode: employee.empCode,
          profileImage: employee.profileImage
        },
        message: 'Your mobile device has been successfully registered for QR attendance! Today is Sunday — no attendance required.'
      });
    }

    // Process First Attendance Action
    let attendance = await Attendance.findOne({ employeeId: employee._id, date: today });
    let action = 'CHECK-IN';

    if (!attendance || !attendance.checkIn) {
      const currentHour = localDate.getHours();
      const currentMin  = localDate.getMinutes();
      const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;

      const thresholdMins = 9 * 60 + 30;
      const currentTotalMins = currentHour * 60 + currentMin;
      const lateMinutes = Math.max(0, currentTotalMins - thresholdMins);

      let status = 'Present';
      let isLate = false;
      let checkInApprovalStatus = 'Not Required';
      let approvalRequestedAt = null;
      let exceptionType = 'None';

      if (currentTimeStr >= '13:30') {
        isLate = true;
        checkInApprovalStatus = 'Pending';
        approvalRequestedAt = now;
        exceptionType = 'Half Day';
        status = 'Half Day';
      } else if (currentTimeStr > '09:30') {
        isLate = true;
        checkInApprovalStatus = 'Pending';
        approvalRequestedAt = now;
        exceptionType = 'Late';
        status = 'Late';
      }

      const locationObj = (lat !== undefined && lng !== undefined) ? { lat: Number(lat), lng: Number(lng) } : undefined;

      if (!attendance) {
        attendance = await Attendance.create({
          employeeId: employee._id,
          date: today,
          checkIn: now,
          location: locationObj,
          status,
          isLate,
          lateMinutes,
          checkInApprovalStatus,
          approvalRequestedAt,
          exceptionType,
          remarks: 'First-time QR Check-In'
        });
      } else {
        attendance.checkIn = now;
        if (locationObj) attendance.location = locationObj;
        attendance.status = status;
        attendance.isLate = isLate;
        attendance.lateMinutes = lateMinutes;
        attendance.checkInApprovalStatus = checkInApprovalStatus;
        attendance.approvalRequestedAt = approvalRequestedAt;
        attendance.exceptionType = exceptionType;
        attendance.remarks = 'First-time QR Check-In';
        await attendance.save();
      }

      registeredDevice.scanHistory.push({
        action: 'CHECK-IN',
        timestamp: now,
        ipAddress: clientIp,
        status: 'Success',
        remarks: 'Registered Device & Checked In'
      });
      action = 'CHECK-IN';
    } else if (attendance.checkIn && !attendance.checkOut) {
      attendance.checkOut = now;
      attendance.workStatus = 'Completed';
      const calc = calculateAttendanceStatus(attendance, { currentTime: now });
      attendance.status = calc.status;
      attendance.workHours = calc.workHours;
      attendance.overtime = calc.overtime;
      attendance.totalWorkingSeconds = calc.workingSeconds;
      attendance.totalOvertimeSeconds = calc.overtimeSeconds;
      await attendance.save();

      registeredDevice.scanHistory.push({
        action: 'CHECK-OUT',
        timestamp: now,
        ipAddress: clientIp,
        status: 'Success',
        remarks: 'Registered Device & Checked Out'
      });
      action = 'CHECK-OUT';
    } else {
      registeredDevice.scanHistory.push({
        action: 'COMPLETED_ATTEMPT',
        timestamp: now,
        ipAddress: clientIp,
        status: 'Notice',
        remarks: 'Registered Device (Attendance was already completed today)'
      });
      action = 'ALREADY_COMPLETED';
    }

    await registeredDevice.save();

    await ActivityLog.create({
      employeeId: employee._id,
      action: 'Register Device & QR Attendance',
      status: 'Success',
      ipAddress: clientIp,
      device: registeredDevice.deviceModel || 'Mobile Device',
      browser: registeredDevice.browser || 'Browser',
      location: 'Office QR Terminal'
    });

    return res.json({
      success: true,
      registered: true,
      deviceToken: rawDeviceCredential,
      action,
      greeting: getGreetingIST(now),
      employee: {
        id: employee._id,
        fullName: employee.fullName,
        empCode: employee.empCode,
        profileImage: employee.profileImage,
        department: employee.department,
        role: employee.role
      },
      attendance: {
        date: today,
        checkIn: attendance.checkIn,
        checkInTime: getTimeStringIST(attendance.checkIn),
        checkOut: attendance.checkOut,
        checkOutTime: attendance.checkOut ? getTimeStringIST(attendance.checkOut) : null,
        workHours: attendance.workHours,
        overtime: attendance.overtime,
        status: attendance.status,
        isLate: attendance.isLate,
        lateMinutes: attendance.lateMinutes
      },
      message: 'Your mobile device has been successfully registered for QR attendance!'
    });

  } catch (error) {
    console.error('registerAndScan error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── 4. ADMIN: Get Current Active QR Token ─────────────────────────────────────
export const getCurrentQrToken = async (req, res) => {
  try {
    const { mode = 'permanent', expirySeconds } = req.query;

    if (mode === 'rotating') {
      const tokenData = getActiveToken(Number(expirySeconds) || 60);
      return res.json({
        success: true,
        data: tokenData
      });
    }

    // Default: Permanent Office QR Code (never expires)
    const tokenData = await getOfficePermanentToken();
    return res.json({
      success: true,
      data: tokenData
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 5. ADMIN: Force Regenerate QR Token ───────────────────────────────────────
export const regenerateQrToken = async (req, res) => {
  try {
    const { mode = 'permanent', expirySeconds } = req.body;

    if (mode === 'rotating') {
      const freshToken = generateSignedQrToken(Number(expirySeconds) || 60);
      return res.json({
        success: true,
        data: freshToken,
        message: 'New rotating QR Code generated successfully'
      });
    }

    // Force regenerate new permanent token and persist in SystemSetting
    const freshToken = generateSignedQrToken('permanent');
    await SystemSetting.findOneAndUpdate(
      { key: 'office_permanent_qr_token' },
      { value: freshToken.token },
      { upsert: true }
    );

    return res.json({
      success: true,
      data: freshToken,
      message: 'New permanent Office QR Code generated and saved successfully'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 6. ADMIN: QR Dashboard Stats ──────────────────────────────────────────────
export const getAdminDashboardStats = async (req, res) => {
  try {
    const today = getTodayDateIST();

    const [
      totalEmployeesCount,
      allRegisteredDevices,
      todayAttendances
    ] = await Promise.all([
      Employee.countDocuments({ status: { $ne: 'Terminated' } }),
      RegisteredDevice.find({}).populate('employeeId', 'fullName empCode department profileImage role status').lean(),
      Attendance.find({ date: today, remarks: { $regex: /QR/i } }).populate('employeeId', 'fullName empCode department profileImage').lean()
    ]);

    const activeDevices = allRegisteredDevices.filter(d => d.status === 'Active');
    const blockedDevices = allRegisteredDevices.filter(d => d.status === 'Blocked');
    const registeredEmployeesIds = new Set(allRegisteredDevices.filter(d => d.status === 'Active' || d.status === 'Blocked').map(d => String(d.employeeId?._id)));
    const unregisteredCount = Math.max(0, totalEmployeesCount - registeredEmployeesIds.size);

    // Today's QR metrics
    const qrCheckIns = todayAttendances.filter(a => a.checkIn).length;
    const qrCheckOuts = todayAttendances.filter(a => a.checkOut).length;

    // Recent QR scan activity
    const recentActivity = [];
    allRegisteredDevices.forEach(d => {
      (d.scanHistory || []).forEach(sh => {
        recentActivity.push({
          employeeName: d.employeeId?.fullName || 'Unknown Employee',
          empCode: d.employeeId?.empCode || '',
          profileImage: d.employeeId?.profileImage || '',
          deviceModel: d.deviceModel || 'Mobile Device',
          os: d.os || 'Android',
          action: sh.action,
          timestamp: sh.timestamp,
          status: sh.status,
          remarks: sh.remarks
        });
      });
    });

    recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json({
      success: true,
      data: {
        today,
        qrCheckIns,
        qrCheckOuts,
        totalRegisteredDevices: allRegisteredDevices.filter(d => d.status !== 'Unregistered').length,
        activeDevicesCount: activeDevices.length,
        blockedDevicesCount: blockedDevices.length,
        unregisteredEmployeesCount: unregisteredCount,
        totalEmployeesCount,
        recentScans: recentActivity.slice(0, 15)
      }
    });
  } catch (err) {
    console.error('getAdminDashboardStats error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 7. ADMIN: Get Registered Devices (With Search & Filter) ───────────────────
export const getRegisteredDevices = async (req, res) => {
  try {
    const { search, os, status } = req.query;

    const allEmployees = await Employee.find({ status: { $ne: 'Terminated' } })
      .select('fullName empCode department role email phone profileImage status joinDate')
      .lean();

    const allDevices = await RegisteredDevice.find({})
      .populate('employeeId', 'fullName empCode department role email phone profileImage status joinDate')
      .lean();

    const deviceMap = new Map();
    allDevices.forEach(d => {
      if (d.employeeId) {
        deviceMap.set(String(d.employeeId._id), d);
      }
    });

    let combinedList = allEmployees.map(emp => {
      const dev = deviceMap.get(String(emp._id));
      if (dev && dev.status !== 'Unregistered') {
        return {
          _id: dev._id,
          employeeId: emp._id,
          employeeName: emp.fullName,
          empCode: emp.empCode,
          email: emp.email,
          department: emp.department,
          role: emp.role,
          profileImage: emp.profileImage,
          deviceModel: dev.deviceModel || dev.deviceName || 'Smartphone',
          deviceName: dev.deviceName || 'Mobile Device',
          os: dev.os || 'Android',
          browser: dev.browser || 'Chrome',
          registrationDate: dev.registrationDate,
          lastUsedDate: dev.lastUsedDate,
          lastIpAddress: dev.lastIpAddress || '',
          status: dev.status, // 'Active' or 'Blocked'
          scanCount: dev.scanHistory?.length || 0
        };
      }
      return {
        _id: null,
        employeeId: emp._id,
        employeeName: emp.fullName,
        empCode: emp.empCode,
        email: emp.email,
        department: emp.department,
        role: emp.role,
        profileImage: emp.profileImage,
        deviceModel: '—',
        deviceName: 'No device bound',
        os: '—',
        browser: '—',
        registrationDate: null,
        lastUsedDate: null,
        lastIpAddress: '',
        status: 'Unregistered',
        scanCount: 0
      };
    });

    // Apply Search
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      combinedList = combinedList.filter(item =>
        item.employeeName.toLowerCase().includes(q) ||
        item.empCode.toLowerCase().includes(q) ||
        (item.department && item.department.toLowerCase().includes(q)) ||
        item.deviceModel.toLowerCase().includes(q)
      );
    }

    // Apply OS filter
    if (os && os !== 'All') {
      combinedList = combinedList.filter(item => item.os.toLowerCase() === os.toLowerCase());
    }

    // Apply Status filter
    if (status && status !== 'All') {
      combinedList = combinedList.filter(item => item.status.toLowerCase() === status.toLowerCase());
    }

    return res.json({
      success: true,
      data: combinedList,
      totalCount: combinedList.length,
      summary: {
        total: combinedList.length,
        active: combinedList.filter(i => i.status === 'Active').length,
        blocked: combinedList.filter(i => i.status === 'Blocked').length,
        unregistered: combinedList.filter(i => i.status === 'Unregistered').length
      }
    });
  } catch (err) {
    console.error('getRegisteredDevices error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 8. ADMIN: Get Device Details & Scan History ───────────────────────────────
export const getDeviceDetails = async (req, res) => {
  try {
    const { id } = req.params; // employeeId or deviceId

    let device = await RegisteredDevice.findById(id).populate('employeeId');
    if (!device) {
      device = await RegisteredDevice.findOne({ employeeId: id }).populate('employeeId');
    }

    if (!device) {
      const emp = await Employee.findById(id);
      if (!emp) return res.status(404).json({ success: false, message: 'Employee/Device not found' });
      return res.json({
        success: true,
        data: {
          employee: emp,
          device: null,
          status: 'Unregistered',
          scanHistory: []
        }
      });
    }

    return res.json({
      success: true,
      data: {
        employee: device.employeeId,
        device: {
          _id: device._id,
          deviceName: device.deviceName,
          deviceModel: device.deviceModel,
          os: device.os,
          browser: device.browser,
          registrationDate: device.registrationDate,
          lastUsedDate: device.lastUsedDate,
          lastIpAddress: device.lastIpAddress,
          status: device.status
        },
        scanHistory: (device.scanHistory || []).reverse()
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 9. ADMIN: Block Device ────────────────────────────────────────────────────
export const blockDevice = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId, reason = 'Administrative Action' } = req.body;

    let device = await RegisteredDevice.findById(id).populate('employeeId');
    if (!device) device = await RegisteredDevice.findOne({ employeeId: id }).populate('employeeId');
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    device.status = 'Blocked';
    device.scanHistory.push({
      action: 'FAILED',
      timestamp: new Date(),
      status: 'Blocked',
      remarks: `Device blocked by Admin. Reason: ${reason}`
    });
    await device.save();

    await ActivityLog.create({
      adminId: adminId || undefined,
      employeeId: device.employeeId?._id,
      action: 'Block QR Device',
      status: 'Success',
      remarks: `Device blocked for employee ${device.employeeId?.fullName} (${device.employeeId?.empCode})`
    });

    return res.json({
      success: true,
      message: `Device for ${device.employeeId?.fullName} blocked successfully.`,
      data: device
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 10. ADMIN: Unblock Device ─────────────────────────────────────────────────
export const unblockDevice = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;

    let device = await RegisteredDevice.findById(id).populate('employeeId');
    if (!device) device = await RegisteredDevice.findOne({ employeeId: id }).populate('employeeId');
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    device.status = 'Active';
    device.scanHistory.push({
      action: 'CHECK-IN',
      timestamp: new Date(),
      status: 'Active',
      remarks: 'Device unblocked by Admin'
    });
    await device.save();

    await ActivityLog.create({
      adminId: adminId || undefined,
      employeeId: device.employeeId?._id,
      action: 'Unblock QR Device',
      status: 'Success',
      remarks: `Device unblocked for employee ${device.employeeId?.fullName}`
    });

    return res.json({
      success: true,
      message: `Device for ${device.employeeId?.fullName} restored to Active status.`,
      data: device
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 11. ADMIN: Reset Device (Allows Re-Registration) ─────────────────────────
export const resetDevice = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;

    let device = await RegisteredDevice.findById(id).populate('employeeId');
    if (!device) device = await RegisteredDevice.findOne({ employeeId: id }).populate('employeeId');
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    device.status = 'Unregistered';
    device.deviceTokenHash = 'RESET_' + Date.now();
    device.scanHistory.push({
      action: 'FAILED',
      timestamp: new Date(),
      status: 'Reset',
      remarks: 'Device registration reset by Admin. Employee must log in to register again.'
    });
    await device.save();

    await ActivityLog.create({
      adminId: adminId || undefined,
      employeeId: device.employeeId?._id,
      action: 'Reset QR Device',
      status: 'Success',
      remarks: `Device reset for ${device.employeeId?.fullName}. Allowed re-registration.`
    });

    return res.json({
      success: true,
      message: `Device binding reset for ${device.employeeId?.fullName}. Employee can now register a new mobile device.`,
      data: device
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── 12. ADMIN: Remove Device Registration ─────────────────────────────────────
export const removeDevice = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;

    let device = await RegisteredDevice.findById(id).populate('employeeId');
    if (!device) device = await RegisteredDevice.findOne({ employeeId: id }).populate('employeeId');
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    const empName = device.employeeId?.fullName || 'Employee';
    const empId = device.employeeId?._id;

    await RegisteredDevice.findByIdAndDelete(device._id);

    await ActivityLog.create({
      adminId: adminId || undefined,
      employeeId: empId,
      action: 'Remove QR Device',
      status: 'Success',
      remarks: `Device registration removed permanently for ${empName}`
    });

    return res.json({
      success: true,
      message: `Device registration for ${empName} has been completely removed.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
