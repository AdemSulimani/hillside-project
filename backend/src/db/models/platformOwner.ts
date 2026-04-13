import pool from '../pool';

export interface PlatformOwner {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export async function findPlatformOwnerByEmail(email: string): Promise<PlatformOwner | null> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await pool.query<PlatformOwner>(
    'SELECT * FROM platform_owners WHERE lower(email) = lower($1) LIMIT 1',
    [normalized],
  );
  return rows[0] ?? null;
}

export async function createPlatformOwner(email: string, passwordHash: string): Promise<PlatformOwner> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await pool.query<PlatformOwner>(
    `INSERT INTO platform_owners (email, password_hash)
     VALUES ($1, $2)
     RETURNING *`,
    [normalized, passwordHash],
  );
  return rows[0];
}
