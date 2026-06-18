# randomly_roll_background

This repository now includes:

- `admin-console/`: Vite admin console for backend operations
- `backend/`: Fastify backend for auth, face library, device pairing, package publish/rollback and desktop bootstrap
- `docs/`: product and integration documents

## Backend quick start

```bash
cd backend
cp .env.example .env
npm install
npm run setup
npm run dev
```

Backend default address: `http://127.0.0.1:3000`

Deployment details: [docs/backend-deployment.md](/F:/Projects/randomly_roll_background/docs/backend-deployment.md)
