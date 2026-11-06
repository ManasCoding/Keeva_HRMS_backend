import express from 'express';
import {
  validateQrToken,
  scanQrAttendance,
  registerAndScan,
  getCurrentQrToken,
  regenerateQrToken,
  getAdminDashboardStats,
  getRegisteredDevices,
  getDeviceDetails,
  blockDevice,
  unblockDevice,
  resetDevice,
  removeDevice
} from '../controllers/qrAttendanceController.js';

const router = express.Router();

// ── Public Scanner Endpoints ──────────────────────────────────────────────────
router.get('/validate-token', validateQrToken);
router.post('/scan', scanQrAttendance);
router.post('/register-device', registerAndScan);

// ── Admin Management Endpoints ────────────────────────────────────────────────
router.get('/admin/current-token', getCurrentQrToken);
router.post('/admin/regenerate-token', regenerateQrToken);
router.get('/admin/dashboard-stats', getAdminDashboardStats);
router.get('/admin/devices', getRegisteredDevices);
router.get('/admin/devices/:id', getDeviceDetails);
router.post('/admin/devices/:id/block', blockDevice);
router.post('/admin/devices/:id/unblock', unblockDevice);
router.post('/admin/devices/:id/reset', resetDevice);
router.delete('/admin/devices/:id', removeDevice);

export default router;
