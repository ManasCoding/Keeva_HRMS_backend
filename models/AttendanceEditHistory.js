import mongoose from 'mongoose';

const AttendanceEditHistorySchema = new mongoose.Schema({
  attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  editedByName: { type: String, required: true },
  editedAt: { type: Date, default: Date.now },
  changes: { type: Object, required: true },
  reason: { type: String }
});

export default mongoose.model('AttendanceEditHistory', AttendanceEditHistorySchema);
