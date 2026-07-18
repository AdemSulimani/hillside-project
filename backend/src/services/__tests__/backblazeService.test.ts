/**
 * The S3 client is constructed on first use, not at module load.
 *
 * This file's mere existence is half the test. `backblazeService` used to build its `S3Client` at
 * the top level, and the AWS SDK validates eagerly — an empty `region` makes the constructor throw
 * `Region is missing`. Since the module is transitively reachable from `app.ts`, that turned a
 * missing FILE-UPLOAD credential into a server that could not boot: it printed its config banner
 * and exited before `listen`, with an SDK-internal error naming nothing useful. A CI job hit
 * exactly that.
 *
 * These cases run with no Backblaze environment at all, so on the old code the IMPORT below would
 * throw and the whole suite would fail to load.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { uploadFile, deleteFile, resetBackblazeClientForTests } from '../backblazeService';

const BACKBLAZE_VARS = [
  'BACKBLAZE_ENDPOINT',
  'BACKBLAZE_REGION',
  'BACKBLAZE_BUCKET_NAME',
  'BACKBLAZE_PUBLIC_URL',
  'BACKBLAZE_KEY_ID',
  'BACKBLAZE_APP_KEY',
  'BACKBLAZE_MAX_FILE_SIZE_BYTES',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of BACKBLAZE_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetBackblazeClientForTests();
});

afterEach(() => {
  for (const key of BACKBLAZE_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetBackblazeClientForTests();
});

describe('backblazeService — importing must never throw', () => {
  it('exposes its API with no Backblaze configuration present', () => {
    // If the module threw at load, this file could not have been imported at all.
    assert.equal(typeof uploadFile, 'function');
    assert.equal(typeof deleteFile, 'function');
  });
});

describe('backblazeService — misconfiguration surfaces at call time', () => {
  it('names BACKBLAZE_REGION rather than leaking the SDK’s "Region is missing"', async () => {
    // Get past the two earlier preconditions so the failure is genuinely the client construction.
    process.env.BACKBLAZE_PUBLIC_URL = 'https://files.example.com';
    process.env.BACKBLAZE_BUCKET_NAME = 'test-bucket';

    await assert.rejects(
      () => uploadFile(Buffer.from('hi'), 'a.txt', 'text/plain', 'docs'),
      (err: Error) => {
        assert.match(err.message, /BACKBLAZE_REGION/);
        assert.doesNotMatch(err.message, /Region is missing/);
        return true;
      },
    );
  });

  it('names BACKBLAZE_ENDPOINT once the region is present', async () => {
    process.env.BACKBLAZE_PUBLIC_URL = 'https://files.example.com';
    process.env.BACKBLAZE_BUCKET_NAME = 'test-bucket';
    process.env.BACKBLAZE_REGION = 'eu-central-003';

    await assert.rejects(
      () => uploadFile(Buffer.from('hi'), 'a.txt', 'text/plain', 'docs'),
      (err: Error) => {
        assert.match(err.message, /BACKBLAZE_ENDPOINT/);
        return true;
      },
    );
  });

  it('surfaces the same clear error from deleteFile', async () => {
    await assert.rejects(
      () => deleteFile('a.txt', 'docs'),
      (err: Error) => {
        assert.match(err.message, /BACKBLAZE_REGION/);
        return true;
      },
    );
  });
});

describe('backblazeService — existing preconditions are unchanged', () => {
  it('rejects an oversized file before touching any configuration', async () => {
    // The size guard runs first and must not depend on Backblaze being configured at all.
    process.env.BACKBLAZE_MAX_FILE_SIZE_BYTES = '10';
    await assert.rejects(
      () => uploadFile(Buffer.alloc(11), 'big.bin', 'application/octet-stream', 'docs'),
      /exceeds maximum allowed size/,
    );
  });

  it('still requires BACKBLAZE_PUBLIC_URL first', async () => {
    await assert.rejects(
      () => uploadFile(Buffer.from('hi'), 'a.txt', 'text/plain', 'docs'),
      /BACKBLAZE_PUBLIC_URL is not configured/,
    );
  });

  it('still requires BACKBLAZE_BUCKET_NAME after the public URL', async () => {
    process.env.BACKBLAZE_PUBLIC_URL = 'https://files.example.com';
    await assert.rejects(
      () => uploadFile(Buffer.from('hi'), 'a.txt', 'text/plain', 'docs'),
      /BACKBLAZE_BUCKET_NAME is not configured/,
    );
  });
});
