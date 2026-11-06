import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import FaceVerificationLog from '../models/FaceVerificationLog.js';
import { verifyFaceComparison } from '../services/faceComparisonService.js';
import { getTodayDateIST } from '../utils/attendanceCalculator.js';

// Helper to sanitize IP
const getClientIp = (req) => {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
};

/**
 * POST /api/face-verification/verify
 * Process an in-memory selfie against the registered employee profile photo.
 * CRITICAL PRIVACY: The selfie is NEVER saved to any database, file, or cloud.
 */
export const verifyEmployeeFace = async (req, res) => {
  try {
    const { employeeId, selfieBase64, attendanceId, clientFaceDetected } = req.body;
    const clientIp = getClientIp(req);
    const today = getTodayDateIST();

    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'Employee ID is required.' });
    }

    if (!selfieBase64) {
      return res.status(400).json({ success: false, message: 'Captured selfie image is required.' });
    }

    // 1. Fetch Employee
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    if (employee.status && employee.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'Employee account is inactive.' });
    }

    if (!employee.profileImage) {
      return res.status(400).json({
        success: false,
        matched: false,
        faceDetected: false,
        error: 'NO_PROFILE_PHOTO',
        message: 'No registered profile photograph found. Please upload a profile picture first in Profile Settings.'
      });
    }

    // 2. Fetch today's Attendance (if available)
    const attendance = attendanceId 
      ? await Attendance.findById(attendanceId)
      : await Attendance.findOne({ employeeId: employee._id, date: today });

    // 3. In-memory Facial Comparison
    const clientHint = clientFaceDetected !== undefined ? !!clientFaceDetected : true;
    const comparison = await verifyFaceComparison(selfieBase64, employee.profileImage, clientHint);

    // 4. Update or Create FaceVerificationLog (metadata only, NO image data)
    const verificationStatus = comparison.matched ? 'VERIFIED' : 'FAILED';

    let log = await FaceVerificationLog.findOne({ employeeId: employee._id, date: today });
    if (!log) {
      log = new FaceVerificationLog({
        employeeId: employee._id,
        date: today,
        attendanceId: attendance?._id || null,
        verificationStatus,
        similarityScore: comparison.similarityScore || 0,
        verifiedAt: comparison.matched ? new Date() : (log?.verifiedAt || null),
        attemptCount: 1,
        failureReason: comparison.matched ? '' : (comparison.message || 'Face did not match profile'),
        metadata: {
          device: req.headers['user-agent'] || 'Mobile/Browser',
          browser: req.headers['sec-ch-ua'] || 'Browser',
          ipAddress: clientIp
        }
      });
    } else {
      log.attemptCount += 1;
      // If already verified previously today, keep VERIFIED status unless successful again
      if (comparison.matched) {
        log.verificationStatus = 'VERIFIED';
        log.similarityScore = comparison.similarityScore;
        log.verifiedAt = new Date();
        log.failureReason = '';
      } else if (log.verificationStatus !== 'VERIFIED') {
        log.verificationStatus = 'FAILED';
        log.similarityScore = comparison.similarityScore;
        log.failureReason = comparison.message || 'Face did not match profile';
      }
      if (attendance && !log.attendanceId) {
        log.attendanceId = attendance._id;
      }
    }

    await log.save();

    return res.json({
      success: true,
      matched: comparison.matched,
      faceDetected: comparison.faceDetected,
      status: log.verificationStatus,
      similarityScore: comparison.similarityScore,
      verifiedAt: log.verifiedAt,
      profileImage: employee.profileImage || null,
      message: comparison.message
    });
  } catch (err) {
    console.error('Face verification error:', err.message);
    return res.status(500).json({
      success: false,
      matched: false,
      faceDetected: false,
      message: err.message || 'Internal server error during face verification.'
    });
  }
};

/**
 * POST /api/face-verification/skip
 * Employee voluntarily opts to skip facial verification and proceed with normal attendance.
 */
export const skipFaceVerification = async (req, res) => {
  try {
    const { employeeId } = req.body;
    const clientIp = getClientIp(req);
    const today = getTodayDateIST();

    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'Employee ID is required.' });
    }

    let log = await FaceVerificationLog.findOne({ employeeId, date: today });
    if (!log) {
      log = new FaceVerificationLog({
        employeeId,
        date: today,
        verificationStatus: 'SKIPPED',
        similarityScore: 0,
        verifiedAt: null,
        attemptCount: 1,
        failureReason: 'Employee opted to skip face verification',
        metadata: {
          device: req.headers['user-agent'] || '',
          browser: req.headers['sec-ch-ua'] || '',
          ipAddress: clientIp
        }
      });
    } else if (log.verificationStatus !== 'VERIFIED') {
      log.verificationStatus = 'SKIPPED';
      log.failureReason = 'Employee opted to skip face verification';
    }
    await log.save();

    return res.json({
      success: true,
      status: log.verificationStatus,
      message: 'Face verification skipped. You may proceed with standard attendance.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/face-verification/status/:employeeId
 * Fetch today's face verification status for the logged-in employee
 */
export const getEmployeeFaceStatus = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const today = getTodayDateIST();

    const log = await FaceVerificationLog.findOne({ employeeId, date: today });
    return res.json({
      success: true,
      status: log ? log.verificationStatus : 'NOT ATTEMPTED',
      similarityScore: log?.similarityScore || 0,
      verifiedAt: log?.verifiedAt || null,
      attemptCount: log?.attemptCount || 0
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/face-verification/admin/logs
 * Retrieve all employees' face verification results for the selected date
 */
export const getAdminFaceVerificationLogs = async (req, res) => {
  try {
    const today = getTodayDateIST();
    const targetDate = req.query.date || today;

    // Fetch all active employees
    const employees = await Employee.find({ status: 'Active' })
      .select('fullName empCode department role profileImage')
      .sort({ empCode: 1 });

    // Fetch attendance for that date
    const attendances = await Attendance.find({ date: targetDate });
    const attendanceMap = new Map();
    attendances.forEach(att => attendanceMap.set(att.employeeId.toString(), att));

    // Fetch face verification logs for that date
    const logs = await FaceVerificationLog.find({ date: targetDate });
    const logMap = new Map();
    logs.forEach(l => logMap.set(l.employeeId.toString(), l));

    const records = employees.map(emp => {
      const att = attendanceMap.get(emp._id.toString());
      const fv = logMap.get(emp._id.toString());

      return {
        _id: emp._id,
        employeeId: emp._id,
        employeeName: emp.fullName,
        empCode: emp.empCode,
        department: emp.department || 'General',
        role: emp.role || 'Team Member',
        profileImage: emp.profileImage || null,
        date: targetDate,
        attendanceStatus: att?.status || 'Absent',
        checkIn: att?.checkIn || null,
        checkOut: att?.checkOut || null,
        faceVerificationStatus: fv ? fv.verificationStatus : 'NOT ATTEMPTED',
        similarityScore: fv?.similarityScore || 0,
        verifiedAt: fv?.verifiedAt || null,
        attemptCount: fv?.attemptCount || 0,
        failureReason: fv?.failureReason || ''
      };
    });

    const summary = {
      total: employees.length,
      verified: records.filter(r => r.faceVerificationStatus === 'VERIFIED').length,
      failed: records.filter(r => r.faceVerificationStatus === 'FAILED').length,
      skipped: records.filter(r => r.faceVerificationStatus === 'SKIPPED').length,
      notAttempted: records.filter(r => r.faceVerificationStatus === 'NOT ATTEMPTED').length
    };

    return res.json({
      success: true,
      date: targetDate,
      summary,
      records
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
