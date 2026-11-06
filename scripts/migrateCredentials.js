/**
 * One-time migration: copy email → gmailCredential, password → credentialPassword
 * for all employees who don't have the new fields set yet.
 * Run once with: node backend/scripts/migrateCredentials.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;

const EmployeeSchema = new mongoose.Schema({
  email: String,
  password: String,
  gmailCredential: { type: String, default: '' },
  credentialPassword: { type: String, default: '' },
}, { strict: false });

const Employee = mongoose.model('Employee', EmployeeSchema);

async function migrate() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Find all employees where new fields are empty
  const employees = await Employee.find({
    $or: [
      { gmailCredential: { $in: [null, '', undefined] } },
      { credentialPassword: { $in: [null, '', undefined] } }
    ]
  });

  console.log(`Found ${employees.length} employees to migrate`);

  let updated = 0;
  for (const emp of employees) {
    const updateFields = {};

    // Copy email → gmailCredential only if gmailCredential is empty
    if (!emp.gmailCredential && emp.email) {
      updateFields.gmailCredential = emp.email;
    }

    // Copy password → credentialPassword only if credentialPassword is empty
    if (!emp.credentialPassword && emp.password) {
      updateFields.credentialPassword = emp.password;
    }

    if (Object.keys(updateFields).length > 0) {
      await Employee.findByIdAndUpdate(emp._id, { $set: updateFields });
      console.log(`✓ Migrated: ${emp.fullName || emp.email} → gmailCredential: ${updateFields.gmailCredential || '[kept]'}, credentialPassword: ${updateFields.credentialPassword ? '[set]' : '[kept]'}`);
      updated++;
    }
  }

  console.log(`\nMigration complete. Updated ${updated} employees.`);
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
