import express from 'express';
import {
  verifyEmployeeFace,
  skipFaceVerification,
  getEmployeeFaceStatus,
  getAdminFaceVerificationLogs
} from '../controllers/faceVerificationController.js';

const router = express.Router();

// Public / Employee endpoints
router.post('/verify', verifyEmployeeFace);
router.post('/skip', skipFaceVerification);
router.get('/status/:employeeId', getEmployeeFaceStatus);

// Admin reporting endpoint
router.get('/admin/logs', getAdminFaceVerificationLogs);

export default router;
