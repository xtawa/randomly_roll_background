# Admin Console Specification

## 1. Purpose

`admin-console/` is a standalone frontend for backend teammates and operators. It is not the same as the desktop runtime and should not share end-user logic with `Web/`.

Its responsibilities are:

- verify auth flow
- edit face profiles
- create sample upload entries
- pair desktop devices using `deviceCode`
- publish face packages
- rollback package versions
- inspect audit log entry points

## 2. Information Architecture

### 2.1 Dashboard

Shows:

- total face profiles
- paired device count
- package count
- audit event count
- implementation flow checklist

### 2.2 Auth

Forms:

- register
- login
- verify email
- forgot password

Bound APIs:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/verify-email`
- `POST /api/auth/forgot-password`

### 2.3 Face Library

Forms:

- create face profile
- edit face profile
- upload face sample batch

Bound APIs:

- `GET /api/admin/faces`
- `POST /api/admin/faces`
- `PATCH /api/admin/faces/:id`
- `POST /api/admin/faces/:id/samples`

Key fields:

- `personId`
- `displayName`
- `preferred`
- `ignored`
- `baseWeight`
- `tags`
- sample notes

### 2.4 Device Pairing

Form:

- input desktop `deviceCode`
- assign classroom / org scope
- assign active package version
- manually toggle `devModeEnabled`

Bound API:

- `POST /api/admin/devices/pair`

### 2.5 Package Publish / Rollback

Forms:

- publish snapshot version
- rollback existing version

Bound APIs:

- `POST /api/admin/packages/publish`
- `POST /api/admin/packages/:version/rollback`

### 2.6 Audit

Read entry point for:

- publish history
- rollback history
- face profile changes
- device pairing records
- auth-sensitive events

Recommended backend support:

- `GET /api/admin/audit-logs`

The current frontend only reserves the page entry and record visualization shape; backend can expose a read API later.

## 3. UI Conventions

- API base URL is editable in the hero toolbar so backend teammates can point the console to local, staging or test environments.
- default API base URL is `https://roll.underflo.ink`.
- Current implementation keeps a local preview fallback:
  - if live API call succeeds, success status is shown
  - if live API call fails, UI still mutates local preview data so backend teammates can continue visual QA
- auth token is cached in local storage only for local development convenience

## 4. Form Contract Mapping

### Register

```json
POST /api/auth/register
{
  "email": "teacher@school.edu",
  "password": "secret"
}
```

### Login

```json
POST /api/auth/login
{
  "email": "admin@example.com",
  "password": "secret"
}
```

### Verify Email

```json
POST /api/auth/verify-email
{
  "email": "teacher@school.edu",
  "code": "123456"
}
```

### Create / Update Face Profile

```json
POST /api/admin/faces
{
  "personId": "stu-001",
  "displayName": "张三",
  "preferred": true,
  "ignored": false,
  "baseWeight": 2,
  "tags": ["class-a"]
}
```

```json
PATCH /api/admin/faces/stu-001
{
  "displayName": "张三",
  "preferred": true,
  "ignored": false,
  "baseWeight": 2,
  "tags": ["class-a", "team-red"]
}
```

### Upload Samples

```json
POST /api/admin/faces/stu-001/samples
{
  "notes": "frontal / side / glasses",
  "fileNames": ["sample-a.jpg", "sample-b.jpg", "sample-c.jpg"]
}
```

### Pair Device

```json
POST /api/admin/devices/pair
{
  "deviceCode": "15e27ca2fd9f3b2f7d...",
  "classroom": "Room 301",
  "packageVersion": "2026.06.18.2",
  "devModeEnabled": false
}
```

### Publish Package

```json
POST /api/admin/packages/publish
{
  "version": "2026.06.18.2",
  "notes": "add 2 students"
}
```

### Rollback Package

```json
POST /api/admin/packages/2026.06.18.1/rollback
{}
```

## 5. Suggested Backend Enhancements

To make operations smoother, backend should additionally consider:

- organization / tenant separation
- classroom grouping
- operator roles: admin, editor, auditor
- soft delete for face profiles
- package compare endpoint for version diff
- audit export endpoint
- sample quality scoring and rejection reason field
- device last-seen heartbeat for deployment health

## 6. Frontend Acceptance

Admin console is considered ready when:

- all main pages render without backend
- all forms point to the agreed API contracts
- backend teammate can switch base URL quickly
- backend teammate can pair a device and explicitly turn dev mode on or off
- local preview data clearly demonstrates expected payload fields
- docs and frontend naming stay consistent with `docs/backend-integration.md`
