import express from 'express';
import { 
  submitTimesheet, 
  updateTimesheet, 
  getEmployeeTimesheets, 
  syncSheetUpdate, 
  pullSheetUpdates,
  syncAllDepartmentSheets,
  getTodayWorkMatrix
} from '../controllers/timesheetController.js';

const router = express.Router();

router.post('/submit', submitTimesheet);
router.post('/sync-sheet', syncSheetUpdate);
router.post('/pull-sheet', pullSheetUpdates);
router.post('/sync-all-departments', syncAllDepartmentSheets);
router.get('/today-matrix', getTodayWorkMatrix);
router.put('/:id', updateTimesheet);
router.get('/:employeeId', getEmployeeTimesheets);
// The '/month/:month' filter is handled by query params in getEmployeeTimesheets

export default router;

