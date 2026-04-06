import pool from '../pool';

export interface User {
  id: string;
  tenant_id: string | null;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

export type PublicUser = Omit<User, 'password_hash'>;

export async function createUser(
  name: string,
  email: string,
  passwordHash: string,
  role = 'owner',
): Promise<User> {
  const { rows } = await pool.query<User>(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, email, passwordHash, role],
  );
  return rows[0];
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function updateUser(
  id: string,
  fields: Partial<Pick<User, 'name' | 'email' | 'tenant_id' | 'role'>>,
): Promise<User | null> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return findUserById(id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 2}`);
  setClauses.push(`updated_at = now()`);

  const values = keys.map((key) => fields[key]);

  const { rows } = await pool.query<User>(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] ?? null;
}

export async function findUserByEmailExcluding(
  email: string,
  excludeUserId: string,
): Promise<User | null> {
  const { rows } = await pool.query<User>(
    'SELECT * FROM users WHERE email = $1 AND id != $2',
    [email, excludeUserId],
  );
  return rows[0] ?? null;
}

export async function updatePasswordHash(
  id: string,
  passwordHash: string,
): Promise<void> {
  await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
    [passwordHash, id],
  );
}

export function toPublicUser(user: User): PublicUser {
  const { password_hash: _, ...publicUser } = user;
  return publicUser;
}
