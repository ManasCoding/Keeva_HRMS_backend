import mongoose from 'mongoose';
import Timesheet from '../models/Timesheet.js';
import Employee from '../models/Employee.js';
import Task from '../models/Task.js';
import SystemSetting from '../models/SystemSetting.js';
import { getIo } from '../socket.js';

// Helper to convert 'HH:MM AM/PM' to minutes from midnight
const parseTimeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [time, modifier] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (hours === 12) {
    hours = modifier === 'PM' ? 12 : 0;
  } else if (modifier === 'PM') {
    hours += 12;
  }
  return hours * 60 + minutes;
};

const formatMinutesToTime = (minutes) => {
  if (minutes <= 0) return '0h 0m';
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${h}h ${m}m`;
};

const calculateTotals = (loginTime, logoutTime) => {
  if (!loginTime || !logoutTime) return { totalHours: '0h 0m', overtime: '0h 0m' };
  
  const startMins = parseTimeToMinutes(loginTime);
  const endMins = parseTimeToMinutes(logoutTime);
  
  let diffMins = endMins - startMins;
  if (diffMins < 0) diffMins += 24 * 60; // Cross midnight
  
  // Standard day is 9 hours = 540 mins
  const standardMins = 540;
  
  let workHoursStr = formatMinutesToTime(diffMins);
  let overtimeStr = '0h 0m';
  
  if (diffMins > standardMins) {
    overtimeStr = formatMinutesToTime(diffMins - standardMins);
  }
  
  return { totalHours: workHoursStr, overtime: overtimeStr };
};

export const submitTimesheet = async (req, res) => {
  try {
    const { employeeId, date, weekStart, weekEnd, loginTime, logoutTime, hourlyTasks, dailyRemarks, weeklyRemarks } = req.body;
    
    if (!employeeId || !date) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const { totalHours, overtime } = calculateTotals(loginTime, logoutTime);
    
    const timesheetData = {
      employeeId,
      employeeName: employee.fullName,
      department: employee.department || 'General',
      date,
      weekStart,
      weekEnd,
      loginTime,
      logoutTime,
      hourlyTasks: hourlyTasks || [],
      dailyRemarks,
      weeklyRemarks,
      totalHours,
      overtime,
      submissionTime: new Date(),
      status: 'Submitted'
    };

    const timesheet = await Timesheet.findOneAndUpdate(
      { employeeId, date },
      timesheetData,
      { new: true, upsert: true }
    );

    const io = getIo();
    if (io) {
      io.emit('timesheetSubmitted', timesheet);
      // For general listening
      io.emit('timesheetUpdated', timesheet);
    }

    res.status(200).json({ success: true, message: 'Timesheet submitted successfully', timesheet });
  } catch (error) {
    console.error('Error submitting timesheet:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const updateTimesheet = async (req, res) => {
  try {
    const { id } = req.params;
    const { loginTime, logoutTime, hourlyTasks, dailyRemarks, weeklyRemarks, status } = req.body;
    
    const timesheet = await Timesheet.findById(id);
    if (!timesheet) {
      return res.status(404).json({ success: false, message: 'Timesheet not found' });
    }

    if (loginTime) timesheet.loginTime = loginTime;
    if (logoutTime) timesheet.logoutTime = logoutTime;
    if (hourlyTasks) timesheet.hourlyTasks = hourlyTasks;
    if (dailyRemarks !== undefined) timesheet.dailyRemarks = dailyRemarks;
    if (weeklyRemarks !== undefined) timesheet.weeklyRemarks = weeklyRemarks;
    if (status) timesheet.status = status;

    const { totalHours, overtime } = calculateTotals(timesheet.loginTime, timesheet.logoutTime);
    timesheet.totalHours = totalHours;
    timesheet.overtime = overtime;

    await timesheet.save();

    const io = getIo();
    if (io) {
      io.emit('timesheetUpdated', timesheet);
    }

    res.status(200).json({ success: true, message: 'Timesheet updated successfully', timesheet });
  } catch (error) {
    console.error('Error updating timesheet:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getEmployeeTimesheets = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { month, year } = req.query; // optional filtering
    
    let query = { employeeId };
    
    if (month && year) {
      // Date is stored as 'YYYY-MM-DD'
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      query.date = { $regex: `^${prefix}` };
    }

    const timesheets = await Timesheet.find(query).sort({ date: -1 });
    res.status(200).json({ success: true, timesheets });
  } catch (error) {
    console.error('Error fetching employee timesheets:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getAdminTimesheets = async (req, res) => {
  try {
    const { date, department, search, status } = req.query;

    // Build query — never return 'Pending' timesheets (employee hasn't submitted)
    const query = { status: { $in: ['Submitted', 'Completed'] } };

    // If admin explicitly requests a specific status
    if (status && status !== 'All Status') {
      query.status = status;
    }

    // Date filter
    if (date) query.date = date;

    // Department filter
    if (department && department !== 'All Departments') {
      query.department = department;
    }

    let timesheets = await Timesheet.find(query)
      .populate('employeeId', 'fullName empCode department profileImage')
      .sort({ submissionTime: -1, date: -1 });

    // Search filter (by employee name or empCode)
    if (search) {
      const lower = search.toLowerCase();
      timesheets = timesheets.filter(t =>
        t.employeeName?.toLowerCase().includes(lower) ||
        t.employeeId?.empCode?.toLowerCase().includes(lower)
      );
    }

    res.status(200).json({ success: true, timesheets });
  } catch (error) {
    console.error('Error fetching admin timesheets:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getTimesheetById = async (req, res) => {
  try {
    const { id } = req.params;
    const timesheet = await Timesheet.findById(id).populate('employeeId', 'fullName email empCode department profileImage role');
    
    if (!timesheet) {
      return res.status(404).json({ success: false, message: 'Timesheet not found' });
    }

    res.status(200).json({ success: true, timesheet });
  } catch (error) {
    console.error('Error fetching timesheet by id:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Helpers for parsing Google Sheets / Excel work entries
const normalizeSheetDate = (rawDate) => {
  if (!rawDate) return null;
  const str = String(rawDate).trim();
  const dmyMatch = str.match(/^(\d{1,2})[\.\-\/](\d{1,2})[\.\-\/](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    let year = dmyMatch[3];
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }
  const ymdMatch = str.match(/^(\d{4})[\.\-\/](\d{1,2})[\.\-\/](\d{1,2})$/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  }
  return null;
};

const STANDARD_TIME_SLOTS = [
  '09:30 - 10:30',
  '10:30 - 11:30',
  '11:30 - 12:30',
  '12:30 - 01:30',
  '01:30 - 02:30',
  '02:30 - 03:30',
  '03:00 - 04:00',
  '04:00 - 04:50',
  '05:00 - 06:30'
];

const mapTimeToSlot = (timeStr, index, usedSlots = new Set()) => {
  if (!timeStr || !timeStr.trim()) {
    const nextAvail = STANDARD_TIME_SLOTS.find(s => !usedSlots.has(s)) || STANDARD_TIME_SLOTS[index] || `Slot ${index + 1}`;
    usedSlots.add(nextAvail);
    return nextAvail;
  }
  const raw = timeStr.trim();
  const startMatch = raw.match(/(\d{1,2})(?:[\.:](\d{2}))?\s*(am|pm)?/i);
  let slot = null;
  if (startMatch) {
    let hour = parseInt(startMatch[1], 10);
    const mins = parseInt(startMatch[2] || '0', 10);
    const meridian = startMatch[3]?.toLowerCase();
    if (meridian === 'pm' && hour < 12) hour += 12;
    if (meridian === 'am' && hour === 12) hour = 0;
    if (!meridian && hour >= 1 && hour <= 6) hour += 12;
    const totalMinutes = hour * 60 + mins;

    if (totalMinutes < 10 * 60 + 15) slot = STANDARD_TIME_SLOTS[0];
    else if (totalMinutes < 11 * 60 + 15) slot = STANDARD_TIME_SLOTS[1];
    else if (totalMinutes < 12 * 60 + 15) slot = STANDARD_TIME_SLOTS[2];
    else if (totalMinutes < 13 * 60 + 15) slot = STANDARD_TIME_SLOTS[3];
    else if (totalMinutes < 14 * 60 + 15) slot = STANDARD_TIME_SLOTS[4];
    else if (totalMinutes < 15 * 60 + 15) slot = STANDARD_TIME_SLOTS[5];
    else if (totalMinutes < 16 * 60 + 15) slot = STANDARD_TIME_SLOTS[6];
    else if (totalMinutes < 17 * 60)      slot = STANDARD_TIME_SLOTS[7];
    else slot = STANDARD_TIME_SLOTS[8];
  }
  if (!slot || usedSlots.has(slot)) {
    slot = STANDARD_TIME_SLOTS.find(s => !usedSlots.has(s)) || slot || `Slot ${index + 1}`;
  }
  usedSlots.add(slot);
  return slot;
};

const parseCSVRow = (line) => {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(cur.trim().replace(/^"|"$/g, ''));
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur.trim().replace(/^"|"$/g, ''));
  return result;
};

/**
 * Sync work update from manual or webhook payload into HRMS
 * Automatically saves tasks to Task and Timesheet in MongoDB as a draft ('Pending')
 * Does NOT submit to admin.
 */
export const syncSheetUpdate = async (req, res) => {
  try {
    const { employeeId, empCode, email, employeeName, date, tasks, slotKey, title, dailyRemarks } = req.body;

    // Resilient employee lookup across all identifiers
    let employee = null;
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      employee = await Employee.findById(employeeId);
    }
    if (!employee && empCode) {
      employee = await Employee.findOne({ empCode: new RegExp(`^${empCode.trim()}$`, 'i') });
    }
    if (!employee && email) {
      employee = await Employee.findOne({ email: new RegExp(`^${email.trim()}$`, 'i') });
    }
    if (!employee && employeeName) {
      employee = await Employee.findOne({ fullName: new RegExp(employeeName.trim(), 'i') });
    }

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found. Please provide valid name, empCode, or email.' });
    }

    // Default to today if date not specified
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Standardize task list
    let taskList = [];
    if (Array.isArray(tasks) && tasks.length > 0) {
      taskList = tasks;
    } else if (title) {
      taskList = [{ slotKey: slotKey || 'General', title }];
    }

    if (taskList.length === 0) {
      return res.status(400).json({ success: false, message: 'No tasks provided to sync' });
    }

    // Upsert tasks into Task collection
    for (const t of taskList) {
      if (!t.title || !t.title.trim()) continue;
      const normalizedSlot = t.slotKey?.trim() || 'General';
      await Task.findOneAndUpdate(
        { employeeId: employee._id, date: targetDate, slotKey: normalizedSlot },
        { 
          title: t.title.trim(), 
          status: 'Completed', 
          employeeId: employee._id, 
          date: targetDate, 
          slotKey: normalizedSlot 
        },
        { upsert: true, new: true }
      );
    }

    // Calculate timesheet week dates
    const d = new Date(targetDate);
    const day = d.getDay();
    const diffToMon = d.getDate() - day + (day === 0 ? -6 : 1);
    const mon = new Date(d.setDate(diffToMon));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const weekStart = mon.toISOString().split('T')[0];
    const weekEnd = sun.toISOString().split('T')[0];

    // Check existing timesheet: only update if missing or still in 'Pending' (draft)
    const existingTimesheet = await Timesheet.findOne({ employeeId: employee._id, date: targetDate });

    if (!existingTimesheet || existingTimesheet.status === 'Pending') {
      const allDayTasks = await Task.find({ employeeId: employee._id, date: targetDate });
      const hourlyTasks = allDayTasks.map(t => ({
        date: t.date,
        slotKey: t.slotKey,
        title: t.title,
        status: 'Completed'
      }));

      const timesheetData = {
        employeeId: employee._id,
        employeeName: employee.fullName,
        department: employee.department || 'General',
        date: targetDate,
        weekStart,
        weekEnd,
        hourlyTasks,
        dailyRemarks: dailyRemarks || existingTimesheet?.dailyRemarks || '',
        status: 'Pending' // Draft status: does NOT submit to admin
      };

      await Timesheet.findOneAndUpdate(
        { employeeId: employee._id, date: targetDate },
        timesheetData,
        { upsert: true, new: true }
      );
    }

    // Emit real-time socket event so the HRMS timesheet UI updates immediately
    const io = getIo();
    if (io) {
      io.emit('timesheetUpdated', { employeeId: employee._id, date: targetDate });
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Work update successfully synced to HRMS and saved to database as draft (not submitted to admin)', 
      employee: {
        id: employee._id,
        name: employee.fullName,
        empCode: employee.empCode,
        department: employee.department
      },
      date: targetDate,
      syncedTasksCount: taskList.length
    });
  } catch (error) {
    console.error('Error in syncSheetUpdate:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Automatically fetch live Google Sheet / Excel work report for the employee
 * Parses dates, times, and task descriptions, and saves them to MongoDB as a Draft (Pending).
 * Does NOT submit to admin.
 */
export const pullSheetUpdates = async (req, res) => {
  try {
    const { employeeId, empCode, email, employeeName, sheetUrl, date, autoSave = true } = req.body;

    // 1. Resilient employee resolution
    let employee = null;
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      employee = await Employee.findById(employeeId);
    }
    if (!employee && empCode) {
      employee = await Employee.findOne({ empCode: new RegExp(`^${empCode.trim()}$`, 'i') });
    }
    if (!employee && email) {
      employee = await Employee.findOne({ email: new RegExp(`^${email.trim()}$`, 'i') });
    }
    if (!employee && employeeName) {
      employee = await Employee.findOne({ fullName: new RegExp(employeeName.trim(), 'i') });
    }

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found. Please provide valid employeeId, empCode, or name.' });
    }

    const targetDate = date || new Date().toISOString().split('T')[0];

    // 2. Resolve Sheet URL
    let targetSheetUrl = sheetUrl?.trim();
    if (!targetSheetUrl) {
      const dept = employee.department || 'Engineering';
      const deptKey = `sheet_url_${dept}`;
      const setting = await SystemSetting.findOne({ key: deptKey });
      if (setting?.value) {
        targetSheetUrl = setting.value.trim();
      } else {
        const dLower = dept.toLowerCase();
        if (dLower.includes('human') || dLower.includes('hr')) {
          targetSheetUrl = 'https://docs.google.com/spreadsheets/d/1t8ERkUfun8dzpoaaoh4vbmYt9-zDO1Ib0gA_DNvTXxA/edit?gid=0#gid=0';
        } else if (dLower.includes('market')) {
          targetSheetUrl = 'https://docs.google.com/spreadsheets/d/1PF386DYQWbUHKuIeIixclNnG1hil4TzO/edit?gid=2082445647#gid=2082445647';
        } else if (dLower.includes('design')) {
          targetSheetUrl = 'https://docs.google.com/spreadsheets/d/1Hz-gYswAHVRhXEhQbJrJdC4Fo9xE8P0TCNNLsW_IZK4/edit?gid=0#gid=0';
        } else if (dLower.includes('manage')) {
          targetSheetUrl = 'https://docs.google.com/spreadsheets/d/1aOw1-8I2b99X3ILj_1rOrqFf1ntFOL7U19BZ3m-KVTI/edit?gid=882523443#gid=882523443';
        } else {
          targetSheetUrl = 'https://docs.google.com/spreadsheets/d/1sIlWWsipPxOrCQENj2E_EHI7XW2HD9S2n8xfaPVuzNs/edit?pli=1&gid=577942890#gid=577942890';
        }
      }
    }

    // 3. Convert to Google Sheet CSV Export URL
    const docMatch = targetSheetUrl.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!docMatch) {
      return res.status(400).json({ success: false, message: 'Invalid Google Sheet URL provided.' });
    }
    const docId = docMatch[1];
    const gidMatch = targetSheetUrl.match(/[#&?]gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    const exportUrl = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;

    // 4. Fetch the CSV with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let csvResponse;
    try {
      csvResponse = await fetch(exportUrl, { signal: controller.signal });
    } catch (fetchErr) {
      clearTimeout(timeout);
      return res.status(502).json({ 
        success: false, 
        message: 'Could not connect to Google Sheets. Please check network connection or sheet URL.' 
      });
    }
    clearTimeout(timeout);

    if (csvResponse.status === 401 || csvResponse.status === 403) {
      return res.status(403).json({
        success: false,
        isRestricted: true,
        message: 'Google Sheet access is restricted (401/403). Please open the Google Sheet, click "Share" (top-right), change General Access to "Anyone with the link can view", and try again.'
      });
    }

    if (!csvResponse.ok) {
      return res.status(csvResponse.status).json({
        success: false,
        message: `Google Sheets returned HTTP ${csvResponse.status}. Unable to download sheet data.`
      });
    }

    const csvText = await csvResponse.text();
    const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length < 2) {
      return res.status(200).json({
        success: true,
        count: 0,
        tasks: [],
        message: 'The sheet appears to be empty or has only headers.'
      });
    }

    // Header column mapping
    const headerRow = parseCSVRow(lines[0]).map(h => h.toLowerCase());
    let dateColIdx = headerRow.findIndex(h => h.includes('date'));
    let timeColIdx = headerRow.findIndex(h => h.includes('time') || h.includes('timing') || h.includes('hour'));
    let workColIdx = headerRow.findIndex((h, idx) => idx !== timeColIdx && (h === 'work' || h.includes('task') || h.includes('update') || h.includes('title') || h.includes('activity') || h.includes('work')));
    let remarksColIdx = headerRow.findIndex(h => h.includes('remark') || h.includes('reason') || h.includes('plan') || h.includes('review'));

    if (dateColIdx === -1) dateColIdx = 0;
    if (timeColIdx === -1) timeColIdx = 1;
    if (workColIdx === -1) workColIdx = (timeColIdx === 1 ? 2 : 1);

    let currentDate = null;
    const allParsedRows = [];
    const usedSlots = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVRow(lines[i]);
      if (cols.length === 0 || cols.every(c => !c)) continue;

      const rawDate = cols[dateColIdx];
      const normalizedDate = normalizeSheetDate(rawDate);
      if (normalizedDate) {
        currentDate = normalizedDate;
      }

      const rawTime = cols[timeColIdx] || '';
      const rawWork = cols[workColIdx] || '';
      const rawRemarks = remarksColIdx !== -1 ? cols[remarksColIdx] : '';

      // Skip invalid / footer rows
      if (!rawWork || rawWork.length <= 1 || /^(total|count|summary|done|\d+)$/i.test(rawWork.trim())) {
        continue;
      }

      if (currentDate) {
        const slot = mapTimeToSlot(rawTime, allParsedRows.length, usedSlots);
        allParsedRows.push({
          date: currentDate,
          time: rawTime,
          slotKey: slot,
          title: rawWork,
          status: 'Completed',
          remarks: rawRemarks
        });
      }
    }

    // Filter tasks for targetDate
    let dateTasks = allParsedRows.filter(r => r.date === targetDate);

    // If no tasks found specifically on targetDate, fall back to the most recent date entries in the sheet
    if (dateTasks.length === 0 && allParsedRows.length > 0) {
      const latestDate = allParsedRows[allParsedRows.length - 1].date;
      if (latestDate) {
        dateTasks = allParsedRows.filter(r => r.date === latestDate);
      }
    }

    if (dateTasks.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        targetDate,
        tasks: [],
        message: `No work entries found in Google Sheet for date ${targetDate}.`
      });
    }

    const taskDate = dateTasks[0].date;

    // 5. If autoSave: upsert into Task and Timesheet as Draft (Pending)
    if (autoSave) {
      for (const t of dateTasks) {
        await Task.findOneAndUpdate(
          { employeeId: employee._id, date: taskDate, slotKey: t.slotKey },
          {
            title: t.title,
            status: 'Completed',
            employeeId: employee._id,
            date: taskDate,
            slotKey: t.slotKey
          },
          { upsert: true, new: true }
        );
      }

      // Check / Upsert Timesheet as Draft (Pending)
      const d = new Date(taskDate);
      const day = d.getDay();
      const diffToMon = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diffToMon));
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      const weekStart = mon.toISOString().split('T')[0];
      const weekEnd = sun.toISOString().split('T')[0];

      const existingTimesheet = await Timesheet.findOne({ employeeId: employee._id, date: taskDate });
      if (!existingTimesheet || existingTimesheet.status === 'Pending') {
        const allDayTasks = await Task.find({ employeeId: employee._id, date: taskDate });
        const hourlyTasks = allDayTasks.map(t => ({
          date: t.date,
          slotKey: t.slotKey,
          title: t.title,
          status: 'Completed'
        }));

        await Timesheet.findOneAndUpdate(
          { employeeId: employee._id, date: taskDate },
          {
            employeeId: employee._id,
            employeeName: employee.fullName,
            department: employee.department || 'General',
            date: taskDate,
            weekStart,
            weekEnd,
            hourlyTasks,
            dailyRemarks: dateTasks.find(t => t.remarks)?.remarks || existingTimesheet?.dailyRemarks || '',
            status: 'Pending' // Draft only: does NOT submit to admin
          },
          { upsert: true, new: true }
        );
      }

      // Broadcast socket event for instant UI reload
      const io = getIo();
      if (io) {
        io.emit('timesheetUpdated', { employeeId: employee._id, date: taskDate });
      }
    }

    return res.status(200).json({
      success: true,
      count: dateTasks.length,
      date: taskDate,
      tasks: dateTasks,
      message: `Successfully pulled ${dateTasks.length} work update(s) from Google Sheet into HRMS as Draft!`
    });
  } catch (error) {
    console.error('Error in pullSheetUpdates:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Admin action: Sync all today's reports from all department Google Sheets into HRMS
 * and save in database as Draft (Pending) in the actual HRMS worksheet format.
 */
export const syncAllDepartmentSheets = async (req, res) => {
  try {
    const { date } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const activeEmployees = await Employee.find({ status: 'Active' });
    if (activeEmployees.length === 0) {
      return res.status(404).json({ success: false, message: 'No active employees found.' });
    }

    const settings = await SystemSetting.find();
    const settingsMap = settings.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});

    const departmentSheetUrls = {
      'Human Resources': settingsMap['sheet_url_Human Resources'] || 'https://docs.google.com/spreadsheets/d/1t8ERkUfun8dzpoaaoh4vbmYt9-zDO1Ib0gA_DNvTXxA/edit?gid=0#gid=0',
      'Marketing': settingsMap['sheet_url_Marketing'] || 'https://docs.google.com/spreadsheets/d/1PF386DYQWbUHKuIeIixclNnG1hil4TzO/edit?gid=2082445647#gid=2082445647',
      'Design': settingsMap['sheet_url_Design'] || 'https://docs.google.com/spreadsheets/d/1Hz-gYswAHVRhXEhQbJrJdC4Fo9xE8P0TCNNLsW_IZK4/edit?gid=0#gid=0',
      'Management': settingsMap['sheet_url_Management'] || 'https://docs.google.com/spreadsheets/d/1aOw1-8I2b99X3ILj_1rOrqFf1ntFOL7U19BZ3m-KVTI/edit?gid=882523443#gid=882523443',
      'Software Development': settingsMap['sheet_url_Engineering'] || 'https://docs.google.com/spreadsheets/d/1sIlWWsipPxOrCQENj2E_EHI7XW2HD9S2n8xfaPVuzNs/edit?pli=1&gid=577942890#gid=577942890'
    };

    let totalSyncedTasks = 0;
    const departmentResults = [];

    for (const [deptName, sheetUrl] of Object.entries(departmentSheetUrls)) {
      if (!sheetUrl) continue;

      const deptEmployees = activeEmployees.filter(emp => {
        const empDept = (emp.department || '').toLowerCase();
        const dLower = deptName.toLowerCase();
        if (dLower.includes('software') || dLower.includes('engineer') || dLower.includes('developer')) {
          return empDept.includes('software') || empDept.includes('developer') || empDept.includes('engineering');
        }
        if (dLower.includes('human') || dLower.includes('hr')) {
          return empDept.includes('human') || empDept.includes('hr');
        }
        if (dLower.includes('market')) {
          return empDept.includes('market');
        }
        if (dLower.includes('design')) {
          return empDept.includes('design');
        }
        if (dLower.includes('manage')) {
          return empDept.includes('manage');
        }
        return empDept.includes(dLower);
      });

      if (deptEmployees.length === 0) continue;

      const docMatch = sheetUrl.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!docMatch) continue;
      const docId = docMatch[1];
      const gidMatch = sheetUrl.match(/[#&?]gid=([0-9]+)/);
      const gid = gidMatch ? gidMatch[1] : '0';
      const exportUrl = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const csvRes = await fetch(exportUrl, { signal: controller.signal });
        clearTimeout(timeout);

        if (!csvRes.ok) {
          departmentResults.push({ department: deptName, success: false, status: csvRes.status, message: 'Google Sheet restricted or inaccessible' });
          continue;
        }

        const csvText = await csvRes.text();
        const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;

        const headerRow = parseCSVRow(lines[0]).map(h => h.toLowerCase());
        let dateColIdx = headerRow.findIndex(h => h.includes('date'));
        let timeColIdx = headerRow.findIndex(h => h.includes('time') || h.includes('timing') || h.includes('hour'));
        let workColIdx = headerRow.findIndex((h, idx) => idx !== timeColIdx && (h === 'work' || h.includes('task') || h.includes('update') || h.includes('title') || h.includes('activity') || h.includes('work')));
        let remarksColIdx = headerRow.findIndex(h => h.includes('remark') || h.includes('reason') || h.includes('plan') || h.includes('review'));

        if (dateColIdx === -1) dateColIdx = 0;
        if (timeColIdx === -1) timeColIdx = 1;
        if (workColIdx === -1) workColIdx = (timeColIdx === 1 ? 2 : 1);

        let currentDate = null;
        const allParsedRows = [];
        const usedSlots = new Set();

        for (let i = 1; i < lines.length; i++) {
          const cols = parseCSVRow(lines[i]);
          if (cols.length === 0 || cols.every(c => !c)) continue;

          const rawDate = cols[dateColIdx];
          const normalizedDate = normalizeSheetDate(rawDate);
          if (normalizedDate) currentDate = normalizedDate;

          const rawTime = cols[timeColIdx] || '';
          const rawWork = cols[workColIdx] || '';
          const rawRemarks = remarksColIdx !== -1 ? cols[remarksColIdx] : '';

          if (!rawWork || rawWork.length <= 1 || /^(total|count|summary|done|\d+)$/i.test(rawWork.trim())) {
            continue;
          }

          if (currentDate) {
            const slot = mapTimeToSlot(rawTime, allParsedRows.length, usedSlots);
            allParsedRows.push({
              date: currentDate,
              time: rawTime,
              slotKey: slot,
              title: rawWork,
              status: 'Completed',
              remarks: rawRemarks
            });
          }
        }

        let dateTasks = allParsedRows.filter(r => r.date === targetDate);
        if (dateTasks.length === 0 && allParsedRows.length > 0) {
          const latestDate = allParsedRows[allParsedRows.length - 1].date;
          if (latestDate) dateTasks = allParsedRows.filter(r => r.date === latestDate);
        }

        if (dateTasks.length > 0) {
          const effectiveDate = dateTasks[0].date;
          const d = new Date(effectiveDate);
          const day = d.getDay();
          const diffToMon = d.getDate() - day + (day === 0 ? -6 : 1);
          const mon = new Date(d.setDate(diffToMon));
          const sun = new Date(mon);
          sun.setDate(mon.getDate() + 6);
          const weekStart = mon.toISOString().split('T')[0];
          const weekEnd = sun.toISOString().split('T')[0];

          for (const emp of deptEmployees) {
            for (const t of dateTasks) {
              await Task.findOneAndUpdate(
                { employeeId: emp._id, date: effectiveDate, slotKey: t.slotKey },
                {
                  title: t.title,
                  status: 'Completed',
                  employeeId: emp._id,
                  date: effectiveDate,
                  slotKey: t.slotKey
                },
                { upsert: true, new: true }
              );
            }

            const existingTimesheet = await Timesheet.findOne({ employeeId: emp._id, date: effectiveDate });
            if (!existingTimesheet || existingTimesheet.status === 'Pending') {
              const allDayTasks = await Task.find({ employeeId: emp._id, date: effectiveDate });
              const hourlyTasks = allDayTasks.map(t => ({
                date: t.date,
                slotKey: t.slotKey,
                title: t.title,
                status: 'Completed'
              }));

              await Timesheet.findOneAndUpdate(
                { employeeId: emp._id, date: effectiveDate },
                {
                  employeeId: emp._id,
                  employeeName: emp.fullName,
                  department: emp.department || deptName,
                  date: effectiveDate,
                  weekStart,
                  weekEnd,
                  hourlyTasks,
                  dailyRemarks: dateTasks.find(t => t.remarks)?.remarks || existingTimesheet?.dailyRemarks || '',
                  status: 'Pending'
                },
                { upsert: true, new: true }
              );
            }
          }

          totalSyncedTasks += dateTasks.length;
          departmentResults.push({
            department: deptName,
            success: true,
            date: effectiveDate,
            taskCount: dateTasks.length,
            employeesCount: deptEmployees.length
          });
        }
      } catch (err) {
        departmentResults.push({ department: deptName, success: false, error: err.message });
      }
    }

    const io = getIo();
    if (io) {
      io.emit('timesheetUpdated', { all: true, date: targetDate });
    }

    return res.status(200).json({
      success: true,
      message: `Successfully synced ${totalSyncedTasks} task updates across department sheets into HRMS database as Draft!`,
      totalSyncedTasks,
      date: targetDate,
      departments: departmentResults
    });
  } catch (error) {
    console.error('Error in syncAllDepartmentSheets:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Admin view: Get all employees' work reports for a given date in HRMS format
 * Returns an array of employees with their tasks mapped to the 9 standard HRMS slots,
 * their timesheet status (Draft/Pending, Submitted, Completed, No Entry), and daily remarks.
 */
export const getTodayWorkMatrix = async (req, res) => {
  try {
    const { date, department, search } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const empQuery = { status: 'Active' };
    if (department && department !== 'All Departments') {
      empQuery.department = new RegExp(`^${department.trim()}$`, 'i');
    }
    if (search && search.trim()) {
      const s = search.trim();
      empQuery.$or = [
        { fullName: new RegExp(s, 'i') },
        { empCode: new RegExp(s, 'i') },
        { department: new RegExp(s, 'i') }
      ];
    }

    const employees = await Employee.find(empQuery)
      .select('fullName empCode department profileImage email')
      .sort({ department: 1, fullName: 1 });

    const matrix = [];
    let totalTasksToday = 0;
    let employeesWithTasksCount = 0;

    for (const emp of employees) {
      const tasks = await Task.find({ employeeId: emp._id, date: targetDate });
      const timesheet = await Timesheet.findOne({ employeeId: emp._id, date: targetDate });

      const slots = {};
      STANDARD_TIME_SLOTS.forEach(slot => {
        slots[slot] = '';
      });

      tasks.forEach(t => {
        if (t.slotKey) {
          slots[t.slotKey] = t.title;
        }
      });

      if (tasks.length > 0) {
        employeesWithTasksCount++;
        totalTasksToday += tasks.length;
      }

      matrix.push({
        id: emp._id,
        fullName: emp.fullName,
        empCode: emp.empCode,
        department: emp.department || 'General',
        profileImage: emp.profileImage,
        email: emp.email,
        date: targetDate,
        taskCount: tasks.length,
        status: timesheet?.status || (tasks.length > 0 ? 'Pending' : 'No Entry'),
        dailyRemarks: timesheet?.dailyRemarks || '',
        loginTime: timesheet?.loginTime || '--:--',
        logoutTime: timesheet?.logoutTime || '--:--',
        totalHours: timesheet?.totalHours || '0h 0m',
        slots
      });
    }

    return res.status(200).json({
      success: true,
      date: targetDate,
      totalEmployees: employees.length,
      employeesWithTasksCount,
      totalTasksToday,
      slots: STANDARD_TIME_SLOTS,
      matrix
    });
  } catch (error) {
    console.error('Error in getTodayWorkMatrix:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};



