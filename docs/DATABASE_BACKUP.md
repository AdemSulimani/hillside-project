# Database backup (DigitalOcean droplet)

Postgres runs in Docker (`postgres` service, database `hillside`). Backups use `pg_dump` — a **logical** copy you can restore on the same server.

## What you need on the droplet

- Project at `~/hillside-project`
- `backend/.env` with correct `DATABASE_URL` / Postgres password
- Production stack: `docker-compose.yml` + `docker-compose.prod.yml`

## One-time setup

```bash
sudo mkdir -p /var/backups/hillside
sudo chown "$USER":"$USER" /var/backups/hillside
chmod 700 /var/backups/hillside

cd ~/hillside-project
chmod +x scripts/backup-postgres.sh scripts/restore-postgres.sh
```

## Manual backup (test first)

```bash
cd ~/hillside-project
bash scripts/backup-postgres.sh
```

You should see a file like `/var/backups/hillside/hillside-20260320T120000Z.sql.gz`.

## Automatic daily backup (cron)

```bash
crontab -e
```

Add (runs every day at 03:15 UTC):

```cron
15 3 * * * cd /root/hillside-project && BACKUP_DIR=/var/backups/hillside RETENTION_DAYS=14 bash scripts/backup-postgres.sh >> /var/log/hillside-backup.log 2>&1
```

If your project path or user is not `root`, change `/root/hillside-project`.

Check cron log:

```bash
tail -50 /var/log/hillside-backup.log
```

## Restore (emergency only)

1. Pick a backup file: `ls -lht /var/backups/hillside/`
2. Restore (stops backend briefly):

```bash
cd ~/hillside-project
bash scripts/restore-postgres.sh /var/backups/hillside/hillside-YYYYMMDDTHHMMSSZ.sql.gz
```

3. Open the app and verify data + `https://api.byhillside.com/api/health`

## Copy backup off the droplet (recommended)

A backup only on the same disk does not protect you if the droplet dies.

**Option A — download to your PC (occasionally):**

```bash
scp root@YOUR_DROPLET_IP:/var/backups/hillside/hillside-*.sql.gz .
```

**Option B — DigitalOcean Spaces** (S3-compatible): install `s3cmd` or `rclone`, upload after each backup (advanced).

**Option C — Droplet snapshot** in DigitalOcean panel: whole-disk image; good extra safety, not a substitute for SQL dumps.

## Rules

- Test restore on a **copy** before you need it in production.
- Keep at least **7–14 days** of daily dumps (`RETENTION_DAYS=14` default).
- Never commit backup files or `.env` to Git.
