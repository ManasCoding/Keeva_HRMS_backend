import mongoose from 'mongoose';

/**
 * FaceVerificationLog Schema
 * Tracks verification attempts, similarity scores, and timestamps.
 * CRITICAL PRIVACY REQUIREMENT:
 * Daily face photographs / selfies must NEVER be saved or stored.
 * This schema stores ONLY metadata and verification outcomes.
 */
const FaceVerificationLogSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
    index: true
  },
  date: {
    type: String, // YYYY-MM-DD (IST)
    required: true,
    index: true
  },
  attendanceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attendance',
    default: null
  },
  verificationStatus: {
    type: String,
    enum: ['VERIFIED', 'FAILED', 'SKIPPED', 'NOT ATTEMPTED'],
    default: 'NOT ATTEMPTED'
  },
  similarityScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  attemptCount: {
    type: Number,
    default: 1
  },
  failureReason: {
    type: String,
    default: ''
  },
  metadata: {
    device: { type: String, default: '' },
    browser: { type: String, default: '' },
    ipAddress: { type: String, default: '' }
  }
}, {
  timestamps: true
});

// Composite index to quickly fetch or update an employee's face log for a given date
FaceVerificationLogSchema.index({ employeeId: 1, date: 1 });

export default mongoose.model('FaceVerificationLog', FaceVerificationLogSchema);
