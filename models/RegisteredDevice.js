import mongoose from 'mongoose';

const RegisteredDeviceSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
    unique: true // Exactly one active registered mobile device per employee
  },
  deviceTokenHash: {
    type: String,
    required: true,
    index: true
  },
  deviceName: {
    type: String,
    default: 'Mobile Device'
  },
  deviceModel: {
    type: String,
    default: 'Smartphone'
  },
  os: {
    type: String,
    default: 'Android' // Android, iOS, etc.
  },
  browser: {
    type: String,
    default: 'Chrome'
  },
  registrationDate: {
    type: Date,
    default: Date.now
  },
  lastUsedDate: {
    type: Date,
    default: Date.now
  },
  lastIpAddress: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Active', 'Blocked', 'Unregistered'],
    default: 'Active'
  },
  scanHistory: [{
    action: {
      type: String,
      enum: ['CHECK-IN', 'CHECK-OUT', 'COMPLETED_ATTEMPT', 'FAILED'],
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    ipAddress: {
      type: String,
      default: ''
    },
    status: {
      type: String,
      default: 'Success'
    },
    remarks: {
      type: String,
      default: ''
    }
  }]
}, { timestamps: true });

export default mongoose.model('RegisteredDevice', RegisteredDeviceSchema);
