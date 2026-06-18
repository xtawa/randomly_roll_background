# Desktop Architecture

## Scope

- This repository now contains three independent frontends:
  - `src/`: Electron desktop runtime, the only client adapted for face matching + sync.
  - `Web/`: existing web version, intentionally unchanged in this iteration.
  - `admin-console/`: backend operation console for account, face library, device pairing, publish, rollback and audit workflows.
- No backend service code is implemented in this repository. Backend contracts are defined in [backend-integration.md](/F:/Projects/randomly_roll/docs/backend-integration.md).

## Desktop Layers

```text
Electron Main Process
  - device code generation
  - userData persistence
  - remote sync orchestration
  - custom app-assets protocol for local face-api models
  - IPC bridge for renderer

Renderer Process
  - camera acquisition
  - face-api.js detection + descriptor extraction
  - local face package matching
  - real-time X / CHECK rule overlay
  - devmode-gated face debug visualization
  - weighted lottery selection and result presentation

Admin Console
  - account workflows
  - face profile editing
  - sample upload entry
  - device pairing
  - package publish / rollback
  - audit log inspection entry
```

## Desktop Runtime Modules

| Module | Responsibility |
| --- | --- |
| `src/main/client-runtime.js` | Generates stable `deviceCode`, manages `device-profile.json`, `client-settings.json`, `face-package.json`, `sync-state.json`, calls backend bootstrap and package download APIs, persists `devModeEnabled` from pairing policy |
| `src/main.js` | Registers `app-assets://` protocol, creates Electron window, exposes sync IPC handlers |
| `src/preload.js` | Exposes desktop APIs to renderer with `contextBridge` |
| `src/services/face-recognition-service.js` | Loads local `face-api.js` models, performs face detection / landmarks / descriptor extraction, matches against local face package |
| `src/services/detection-service.js` | Merges face recognition output with paper sign and gesture sign rules, deduplicates candidates by `personId` |
| `src/services/ui-controller.js` | Coordinates sync panel, camera settings, manual update, mode switching, weighted lottery flow |
| `src/services/canvas-renderer.js` | Draws neutral circle markers by default and only reveals detailed debug overlays when backend pairing enables devmode |

## Local Persistence

All desktop sync data is stored under `app.getPath("userData")`:

- `device-profile.json`
  - stable `deviceCode`
  - generation source
  - creation timestamp
- `client-settings.json`
  - `syncMode`
  - `backendBaseUrl`
  - request timeout
  - default backend address: `https://roll.underflo.ink`
- `face-package.json`
  - full local face library snapshot
  - only descriptors and metadata, no original face images
- `sync-state.json`
  - online/offline state
  - pairing state
  - `devModeEnabled`
  - current package version
  - last successful sync time
  - last error

## Face Package Shape

```json
{
  "version": "2026.06.18.1",
  "publishedAt": "2026-06-18T10:10:00.000Z",
  "thresholdDefault": 0.52,
  "people": [
    {
      "personId": "stu-001",
      "displayName": "张三",
      "descriptors": [[0.12, -0.03, 0.88]],
      "preferred": true,
      "ignored": false,
      "baseWeight": 2,
      "tags": ["class-a"],
      "updatedAt": "2026-06-18T09:52:00.000Z"
    }
  ]
}
```

## Recognition and Candidate Rules

1. Desktop renderer loads face-api models from `src/assets/face-api-models` via `app-assets://`.
2. Current frame produces face boxes, landmarks and descriptors.
3. Each face is matched against the local package using descriptor distance.
4. If matched:
   - `ignored = true` means never enters the pool.
   - `preferred = true` uses elevated `baseWeight`.
5. If not matched:
   - face is labeled as unknown.
   - it still enters the lottery pool with the same default weight as a normal known face.
6. Real-time sign rules are applied after identity matching:
   - live `X` always excludes.
   - live `CHECK` upgrades current-frame weight.
7. Same `personId` detected multiple times in one frame is deduplicated by highest confidence.
8. Face-level debug visualization is hidden by default:
   - every face uses the same default circle marker
   - matched / unknown / ignored / preferred / live X / live CHECK labels are suppressed
   - only backend-paired devices with `devModeEnabled = true` can see detailed overlays

## Sync Flow

1. Desktop startup always loads local cached package first.
2. If mode is `AUTO_SYNC`, main process calls `POST /api/client/bootstrap`.
3. If remote version equals local version, renderer continues using cache without re-download.
4. If remote version is newer, desktop downloads `GET /api/client/packages/:version`, validates JSON, then atomically replaces local `face-package.json`.
5. If network fails:
   - cached package continues to work.
   - sync state becomes `OFFLINE_FALLBACK`.
6. If no cache exists:
   - desktop shows empty-library warning.
   - unknown faces can still be detected and enter the selection pool.

## Admin Console Role

The new `admin-console/` frontend is not a second client runtime. It is an operation console that mirrors the backend contract and should be used by backend teammates for:

- account registration and login flow checks
- face profile editing
- sample upload entry points
- device pairing by `deviceCode`
- package publish and rollback
- audit log validation
