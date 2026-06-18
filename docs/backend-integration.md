# Backend Integration Specification

## 1. Goal

Backend service is responsible for:

- user account and email verification
- face profile CRUD
- original face sample storage
- face descriptor extraction
- full snapshot package generation
- device pairing by desktop `deviceCode`
- package publish / rollback
- audit logging for all sensitive operations

This document is the authoritative contract for the Electron desktop client under `src/`.

## 2. Recommended Backend Modules

### 2.1 Auth

- register by email
- verify email code
- login
- forgot password / reset password
- role-based permissions for admin and editor

### 2.2 Face Library

- create and edit face profiles
- upload original face samples
- run quality checks
- extract 128-d face descriptors
- maintain 3 to 5 descriptor prototypes per person

### 2.3 Device Management

- accept `deviceCode`
- bind device to classroom / tenant / branch / org
- control which face package version that device should receive
- control whether paired device can see face debug visualization through `devModeEnabled`

### 2.4 Package Pipeline

- build full snapshot package from current active face profiles
- mark one version as current
- rollback to a previously published version

### 2.5 Audit

- record actor
- record action
- record target entity
- record request id and timestamp
- record before/after summary when possible

## 3. Recommended Data Entities

| Entity | Purpose |
| --- | --- |
| `users` | backend operators, roles, password hash, email status |
| `email_verifications` | email verification codes or tokens |
| `password_resets` | password recovery tokens |
| `devices` | physical desktop clients identified by `deviceCode` |
| `device_pairings` | bind device to classroom / org / current policy |
| `face_profiles` | business identity record for each person |
| `face_samples` | original uploaded face images and capture metadata |
| `face_descriptors` | normalized descriptor vectors generated from samples |
| `face_packages` | published snapshot version metadata |
| `package_people` | face profile membership within a package snapshot |
| `audit_logs` | operation traces |

## 4. Client Contract

### 4.1 Sync Mode

```ts
type ClientSyncMode = "AUTO_SYNC" | "LOCAL_ONLY"
```

```ts
type ClientPolicy = {
  allowUnknownFaces: boolean
  unknownBaseWeight: number
  devModeEnabled: boolean
}
```

### 4.2 Face Package

```ts
type FaceLibraryPackage = {
  version: string
  publishedAt: string
  thresholdDefault: number
  people: Array<{
    personId: string
    displayName: string
    descriptors: number[][]
    preferred: boolean
    ignored: boolean
    baseWeight: number
    tags: string[]
    updatedAt: string
  }>
}
```

### 4.3 Desktop Startup Request

`POST /api/client/bootstrap`

Request:

```json
{
  "deviceCode": "15e27ca2fd9f3b2f7d...",
  "appVersion": "0.1.0",
  "mode": "AUTO_SYNC",
  "localPackageVersion": "2026.06.18.1"
}
```

Response:

```json
{
  "paired": true,
  "latestPackageVersion": "2026.06.18.2",
  "updateAvailable": true,
  "downloadUrl": "/api/client/packages/2026.06.18.2",
  "policy": {
    "allowUnknownFaces": true,
    "unknownBaseWeight": 1,
    "devModeEnabled": false
  },
  "serverTime": "2026-06-18T10:20:15.000Z"
}
```

Rules:

- `paired = false` means device exists but is not bound to an active classroom / org / package scope.
- `updateAvailable = false` means desktop must continue using local cache.
- `downloadUrl` can be relative or absolute.
- backend should not return original face images in this flow.
- `policy.devModeEnabled` defaults to `false` and must only become `true` after the device is already paired and an operator explicitly enables dev mode.

### 4.4 Package Download

`GET /api/client/packages/:version`

Response body must be a full `FaceLibraryPackage` snapshot.

Important:

- first implementation uses full snapshot only, not incremental diff
- package must be immutable after publish
- rollback creates or re-points the active version, but downloaded snapshot content must stay deterministic

## 5. Admin API Contract

### 5.1 Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/verify-email`
- `POST /api/auth/forgot-password`

Recommended fields:

```json
{
  "email": "teacher@school.edu",
  "password": "secret"
}
```

### 5.2 Face Profiles

- `GET /api/admin/faces`
- `POST /api/admin/faces`
- `PATCH /api/admin/faces/:id`
- `POST /api/admin/faces/:id/samples`

Recommended `POST /api/admin/faces` body:

```json
{
  "personId": "stu-001",
  "displayName": "张三",
  "preferred": true,
  "ignored": false,
  "baseWeight": 2,
  "tags": ["class-a", "team-red"]
}
```

Recommended `POST /api/admin/faces/:id/samples` behavior:

- accept multiple images
- validate blur / angle / face count / brightness
- reject non-face uploads
- generate descriptor vectors
- update `face_descriptors`
- optionally regenerate a "best prototypes" set for publishing

### 5.3 Device Pairing

- `POST /api/admin/devices/pair`

Recommended request:

```json
{
  "deviceCode": "15e27ca2fd9f3b2f7d...",
  "classroom": "Room 301",
  "packageVersion": "2026.06.18.2",
  "devModeEnabled": false
}
```

Recommended backend behavior:

- create or update `devices`
- create current `device_pairings`
- link to tenant / classroom / branch metadata
- persist `devModeEnabled`
- persist operator and timestamp

### 5.4 Package Publish

- `POST /api/admin/packages/publish`

Recommended request:

```json
{
  "version": "2026.06.18.2",
  "notes": "add 2 students, ignore 1 graduate"
}
```

Recommended backend behavior:

1. read all active `face_profiles`
2. collect selected descriptor prototypes from `face_descriptors`
3. build `FaceLibraryPackage`
4. save `face_packages`
5. save `package_people`
6. mark this version as active
7. write audit log

### 5.5 Package Rollback

- `POST /api/admin/packages/:version/rollback`

Recommended backend behavior:

- mark requested version as active for future bootstrap checks
- do not mutate package payload history
- write audit log with operator, source version, destination version

## 6. Desktop Runtime Expectations

### 6.1 Stable Device Code

Desktop generates a stable `deviceCode` once and reuses it forever:

- preferred source: original machine id via `node-machine-id`
- derived with fixed salt and SHA-256
- if machine id read fails, desktop stores a generated UUID-based fallback

Backend should treat `deviceCode` as the durable client identifier.

### 6.2 Local File Cache

Desktop stores the following in `app.getPath("userData")`:

- `device-profile.json`
- `client-settings.json`
- `face-package.json`
- `sync-state.json`

`client-settings.json` should default `backendBaseUrl` to `https://roll.underflo.ink`.

Backend does not need to manage those files directly, but responses should be compatible with local caching and replacement.

### 6.3 Offline Behavior

If backend is unreachable:

- desktop falls back to local package if one exists
- desktop keeps recognition running
- desktop marks sync state as offline fallback
- desktop keeps the last known `devModeEnabled` flag from the most recent successful pairing sync
- if no local package exists, desktop still detects unknown faces and allows them into the selection pool

### 6.4 DevMode Behavior

- by default, desktop must not reveal face-level debug statuses
- normal mode only shows the same neutral circle marker on each face
- detailed overlays such as matched / unknown / ignored / preferred / live X / live CHECK are allowed only when:
  - the device is paired
  - backend pairing policy returns `devModeEnabled = true`

## 7. Error Codes

Recommended error families:

| Code | Meaning |
| --- | --- |
| `AUTH_EMAIL_NOT_VERIFIED` | email exists but not verified |
| `AUTH_INVALID_CREDENTIALS` | login failed |
| `DEVICE_NOT_PAIRED` | desktop device has no active pairing |
| `PACKAGE_NOT_FOUND` | requested package version missing |
| `FACE_PROFILE_NOT_FOUND` | requested face profile missing |
| `FACE_SAMPLE_INVALID` | uploaded sample failed quality rules |
| `PUBLISH_CONFLICT` | package version already exists |
| `ROLLBACK_TARGET_INVALID` | requested rollback version unavailable |

Return shape recommendation:

```json
{
  "code": "DEVICE_NOT_PAIRED",
  "message": "No active pairing found for the provided deviceCode."
}
```

## 8. Security and Privacy

- backend stores original face samples; desktop does not receive them
- package download includes descriptors and metadata only
- admin endpoints should require auth and permission checks
- audit logs should cover:
  - login
  - face create / edit
  - sample upload
  - device pairing
  - publish
  - rollback

## 9. Suggested Rollout Order

1. Auth endpoints and email verification
2. Face profile CRUD
3. Sample upload and descriptor extraction
4. Package publish endpoint
5. Device pairing endpoint
6. Client bootstrap endpoint
7. Package rollback endpoint
8. Audit log endpoints or direct database reporting

## 10. Acceptance Checklist

Backend is ready for desktop联调 when all of the following are true:

- desktop can register one device by `deviceCode`
- `POST /api/client/bootstrap` returns deterministic pairing and version information
- `POST /api/client/bootstrap` returns deterministic `policy.devModeEnabled`
- `GET /api/client/packages/:version` returns a valid full package
- publish creates a new version visible to bootstrap
- rollback changes the active version returned by bootstrap
- admin user can register, verify email, log in, create face profiles, upload samples, pair devices and publish packages
