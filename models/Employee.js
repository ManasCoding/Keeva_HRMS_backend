import mongoose from 'mongoose';

const EmployeeSchema = new mongoose.Schema({
  empCode: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String },
  department: { type: String },
  status: { type: String, default: 'Active' },
  joinDate: { type: Date, default: Date.now },
  profileImage: { type: String },
  role: { type: String, default: 'Team Member' },
  salary: { type: Number, default: 0 },
  password: { type: String, default: '123456' },
  // Separate credential fields — not tied to login email
  gmailCredential: { type: String, default: '' },
  credentialPassword: { type: String, default: '' },
  
  // Employment Journey
  employmentType: { type: String, default: 'Regular' },
  employmentHistory: [{
    empCode: String,
    employmentType: String,
    designation: String,
    department: String,
    startDate: Date,
    endDate: Date,
    status: { type: String, default: 'Completed' },
    salary: String,
    reason: String
  }],

  
  // Disciplinary & Floor Penalties
  penalties: [{
    ruleNumber: { type: Number },
    ruleTitle: { type: String },
    penaltyType: { type: String },
    amount: { type: String },
    displayAmount: { type: String },
    reason: { type: String },
    date: { type: Date, default: Date.now },
    month: { type: Number },
    year: { type: Number },
    status: { type: String, default: 'Applied' }
  }],

  // Admin-applied monthly paid leaves
  manualPaidLeaves: [{
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    days: { type: Number, default: 1 },
    appliedAt: { type: Date, default: Date.now }
  }],

  // Bank & Identity Details
  accountHolderName: { type: String },
  bankName: { type: String },
  accountNumber: { type: String },
  ifscCode: { type: String },
  branchName: { type: String },
  panNumber: { type: String },
  aadharNumber: { type: String },
  upiId: { type: String },
  pfAccount: { type: String }
}, { timestamps: true });

export default mongoose.model('Employee', EmployeeSchema);
