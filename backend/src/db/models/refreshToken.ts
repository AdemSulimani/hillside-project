import pool from '../pool';

export interface RefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  persistent: boolean;
}

export async function createRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  persistent: boolean,
): Promise<RefreshToken> {
  const { rows } = await pool.query<RefreshToken>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, persistent)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, tokenHash, expiresAt, persistent],
  );
  return rows[0];
}

export async function findRefreshTokenByHash(
  tokenHash: string,
): Promise<RefreshToken | null> {
  const { rows } = await pool.query<RefreshToken>(
    'SELECT * FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function deleteRefreshTokenByHash(tokenHash: string): Promise<void> {
  await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
}

export async function deleteAllRefreshTokensForUser(userId: string): Promise<void> {
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}
