import 'dotenv/config';
import bcrypt from 'bcrypt';
import { createPlatformOwner, findPlatformOwnerByEmail } from '../db/models/platformOwner';
import pool from '../db/pool';

const SALT_ROUNDS = 12;

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: tsx src/scripts/createPlatformOwner.ts <email> <password>');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await findPlatformOwnerByEmail(email);
  if (existing) {
    console.error('A platform owner with this email already exists.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const owner = await createPlatformOwner(email, passwordHash);
  console.log(`Platform owner created: ${owner.email} (${owner.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
