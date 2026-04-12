import 'dotenv/config';
import { cryptoService } from '../services/cryptoService';

/**
 * Encrypt a channel access token the same way the app stores it (see cryptoService.ts).
 *
 * Usage (prefer env — avoids shell history):
 *   PLAIN_ACCESS_TOKEN='EAA...' npx tsx src/scripts/encryptAccessToken.ts
 *
 * Then update the row, e.g.:
 *   UPDATE channels SET access_token_encrypted = '<paste-output-here>' WHERE id = '...';
 */
function main(): void {
  const plain = process.env.PLAIN_ACCESS_TOKEN?.trim() ?? process.argv[2]?.trim();
  if (!plain) {
    console.error(
      'Missing token. Set PLAIN_ACCESS_TOKEN or pass the token as the first argument.\n' +
        'Example: PLAIN_ACCESS_TOKEN="EAA..." npx tsx src/scripts/encryptAccessToken.ts',
    );
    process.exit(1);
  }

  const encrypted = cryptoService.encrypt(plain);
  console.log(encrypted);
}

main();
