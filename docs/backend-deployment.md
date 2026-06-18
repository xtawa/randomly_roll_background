# Backend Deployment Guide

## Stack

- Runtime: Node.js 22
- API framework: Fastify
- Persistence: Prisma + SQLite
- Auth: JWT bearer token
- Upload storage: local filesystem under `backend/storage/`

This backend runs directly on Linux or inside Docker. For larger deployments, switch `DATABASE_URL` to PostgreSQL and keep the API layer unchanged.

## Local Setup

```bash
cd backend
cp .env.example .env
npm install
npm run setup
npm run dev
```

Default service address: `http://127.0.0.1:3000`

Default SQLite file: `backend/dev.db`

Default seeded admin account:

- email: `admin@example.com`
- password: `ChangeMe123!`

Change both values in `.env` before production use.

## Linux Process Deployment

```bash
cd /opt/randomly-roll/backend
cp .env.example .env
npm install
npm run setup
npm run build
PORT=3000 HOST=127.0.0.1 node dist/server.js
```

Recommended service manager: `systemd` or `pm2`.

## Docker Deployment

```bash
cd backend
cp .env.example .env
sed -i 's#^DATABASE_URL=.*#DATABASE_URL=file:/app/storage/dev.db#' .env
docker compose -f deploy/docker-compose.yml up -d --build
```

## Domain Binding

1. Point your DNS record to the Linux server public IP.
2. Install Nginx.
3. Copy `backend/deploy/nginx.randomly-roll.conf` to `/etc/nginx/conf.d/randomly-roll.conf`.
4. Replace `roll.example.com` with the real domain.
5. Reload Nginx: `sudo nginx -s reload`.
6. Issue HTTPS certificates with Certbot:

```bash
sudo certbot --nginx -d roll.example.com
```

After that, set:

- backend `PUBLIC_BASE_URL=https://roll.example.com`
- admin console API base URL to `https://roll.example.com`
- desktop default backend URL to the same domain

## Important Production Notes

- The current descriptor extractor is a deterministic placeholder based on upload content or declared file names. It is sufficient for contract integration, package publishing, device pairing and desktop sync validation, but it is not a real face embedding model.
- To reach production-grade recognition, replace the placeholder logic in `backend/src/lib/descriptors.ts` with a real embedding pipeline and keep the existing API contract.
- Keep `JWT_SECRET` long and random.
- Restrict `CORS_ORIGINS` to trusted admin console origins only.
