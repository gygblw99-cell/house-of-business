# Operations Runbook — House of Business

## Quick Reference

| Service | Port | Health Check |
|---------|------|-------------|
| Backend API | 3001 | `GET /health` |
| Web (Next.js) | 3002 | `GET /` |
| Marketing site | 4000 | `GET /` |
| PostgreSQL | 5432 | `pg_isready` |
| Redis | 6379 | `redis-cli ping` |
| Nginx | 80/443 | `nginx -t` |

---

## Deploy

```bash
# Standard deploy
bash deploy.sh

# First deploy (provisions SSL certificate)
DOMAIN=yourdomain.com EMAIL=you@example.com bash deploy.sh --init-ssl

# Deploy with forced rebuild (no cache)
docker compose build --no-cache && docker compose up -d
```

The deploy script validates all required secrets before touching production.

---

## Rollback

```bash
# Find previous image tags
docker images | grep hob-backend

# Roll back to previous tag
docker compose stop backend
docker tag hob-backend:previous hob-backend:latest
docker compose up -d backend

# Or revert to a specific git commit
git log --oneline -10
git checkout <commit-hash>
bash deploy.sh
```

---

## Incidents

### Backend is down (5xx on all routes)

1. Check container status:
   ```bash
   docker compose ps
   docker compose logs backend --tail=100
   ```
2. Common causes:
   - **DB connection refused** → see "Database is down" below
   - **JWT_SECRET missing** → check `.env`, restart: `docker compose restart backend`
   - **Port conflict** → `lsof -i :3001`
3. Restart:
   ```bash
   docker compose restart backend
   ```

### Database is down

1. Check Postgres:
   ```bash
   docker compose ps postgres
   docker compose logs postgres --tail=50
   ```
2. Check disk space (most common cause):
   ```bash
   df -h
   ```
3. Restart Postgres:
   ```bash
   docker compose restart postgres
   ```
4. If data corruption:
   ```bash
   # Stop all services first
   docker compose stop
   # Restore from backup (see Backup section)
   ```

### Redis is down

Redis is optional — the backend falls back to in-memory cache automatically. No immediate action needed. Restart when convenient:
```bash
docker compose restart redis
```
Performance will degrade (cache miss on every request) until Redis is back.

### High memory / CPU

```bash
# See resource usage per container
docker stats

# Backend memory leak — restart
docker compose restart backend

# Check slow queries
docker exec -it hob-postgres psql -U hob_user -d house_of_business \
  -c "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

### SSL certificate expired

```bash
# Renew via Certbot
docker compose run --rm certbot renew
docker compose exec nginx nginx -s reload
```

Certificates auto-renew via cron (set up by `--init-ssl`).

---

## Backup & Restore

### Database Backup — automated

The `backup` service in `docker-compose.yml` (`prodrigestivill/postgres-backup-local`)
runs `pg_dump` on a schedule and keeps daily/weekly/monthly rotations automatically —
no crontab setup needed. It starts along with everything else on `docker compose up -d`.

- **Where**: `./backups/daily`, `./backups/weekly`, `./backups/monthly` on the host
  (bind-mounted, so `docker compose down -v` never touches them — only deleting the
  `backups/` folder itself does).
- **Schedule / retention**: controlled by `BACKUP_SCHEDULE`, `BACKUP_KEEP_DAYS`,
  `BACKUP_KEEP_WEEKS`, `BACKUP_KEEP_MONTHS` in `.env` (defaults: daily at 03:00,
  keep 14 days / 8 weeks / 6 months).
- **Verify it's actually running**:
  ```bash
  docker compose logs backup --tail 50
  ls -la backups/daily/
  ```
  A gzip file dated today should appear in `backups/daily/` after the scheduled time —
  check this once after the first deploy, not just that the container shows "up".

### Restore

```bash
# Pick the file to restore from (most recent daily, or a weekly/monthly for older data)
gunzip -c backups/daily/house_of_business-YYYY-MM-DD_HH-MM-SS.sql.gz | docker exec -i hob_postgres psql -U hob_user house_of_business
```

### Manual one-off backup (doesn't wait for the schedule)

```bash
docker exec hob_postgres pg_dump -U hob_user house_of_business | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

---

## Logs

```bash
# All services
docker compose logs -f

# Specific service, last N lines
docker compose logs backend --tail=200
docker compose logs nginx --tail=50

# Application logs (Winston, written to /logs/)
tail -f logs/error.log
tail -f logs/combined.log

# Find 500 errors in last hour
grep '"level":"error"' logs/combined.log | tail -50
```

---

## Database Maintenance

```bash
# Connect to DB
docker exec -it hob-postgres psql -U hob_user -d house_of_business

# Check table sizes
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
FROM pg_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

# Check slow queries (requires pg_stat_statements)
SELECT query, calls, mean_exec_time::numeric(10,2) AS avg_ms
FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;

# Vacuum / analyze (run monthly or when performance degrades)
VACUUM ANALYZE;
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | 64+ chars in production |
| `ANTHROPIC_API_KEY` | ✅ | Claude AI API key |
| `ALLOWED_ORIGINS` | ✅ (prod) | Comma-separated frontend origins |
| `APP_URL` | ✅ (prod) | Frontend URL |
| `BACKEND_URL` | ✅ (prod) | Backend URL |
| `SMTP_HOST` | ⚠️ | Email — required for password reset |
| `REDIS_URL` | ⚠️ | Cache — falls back to in-memory |
| `FIREBASE_*` | ⚠️ | Push notifications |
| `ERROR_WEBHOOK_URL` | ⚠️ | Error monitoring webhook |

See `.env.example` for full list and format.

---

## Health Checks

```bash
# Backend health
curl https://yourdomain.com/health

# DB connectivity (via backend)
curl -H "Authorization: Bearer $TOKEN" https://yourdomain.com/api/dashboard

# Redis (direct)
docker exec hob-redis redis-cli ping
```

---

## Emergency Contacts

| Role | Contact |
|------|---------|
| On-call engineer | [fill in] |
| Database admin | [fill in] |
| Domain/DNS | [fill in] |
