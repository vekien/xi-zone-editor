# XI Zone Editor

> ## WORK IN PROGRESS
>
> This project is under active development and **not production-ready**.
> Expect rough edges, missing setup steps, and features that only work on a
> fully configured dev machine.
>
> **Not in the first-run setup yet:** database credentials (`XI_DB_*`) and some
> server/navmesh paths. Anything that talks to the game DB (zone music writes,
> custom NPC SQL, certain publish helpers, etc.) needs those values in the
> xi-tools `.env` manually for now.

---

Browser/WebGL level editor for FFXI zones — placements, collision, VFX, cutscenes,
navmesh, and more — packaged as a **Tauri 2** desktop app.

Backend DAT work is handled by **[xi-tools](https://github.com/vekien/xi-tools)** over a
local WebSocket + HTTP bridge.

---

## How it works

```text
┌──────────────────────────┐     ws://127.0.0.1:8777/ws      ┌─────────────────────┐
│  XI Zone Editor (Tauri)  │ ◄─────────────────────────────► │  xi bridge (Python) │
│  ui/  three.js + Vite     │     http://127.0.0.1:8777/      │  xi-tools package   │
└──────────────────────────┘     /game  /exports  /health    └──────────┬──────────┘
                                                                           │
                                                    FFXI_DIR / HD / pivot ─┘
                                                    (+ optional DB, Blender)
```

1. **Editor UI** runs in a Tauri window (WebView). No Electron.
2. On boot it ensures **xi-tools** is available (download from GitHub Releases, or a local folder you pick).
3. It ensures a **real Python** is available (system install, or auto-download of the official Windows embeddable build from python.org — Store stubs are ignored).
4. It starts **`xi bridge`**, which:
   - accepts editor commands over **WebSocket** (`/ws`)
   - serves game files from **`FFXI_DIR`** at `/game/…` (and HD at `/game-hd/…`)
   - serves optional tool exports at `/exports/…` (pre-decoded audio, etc.)
5. First-run wizards collect:
   - **Workspace folder** — where project JSON / zone change-sets are saved (git optional)
   - **Game paths** — `FFXI_DIR` (required), HD / pivot / Blender (optional)
6. Closing the app stops the bridge (Windows Job Object kill-on-close + idle timeout).

Asset Browser **icons / sprites / manifests** are **bundled** in the UI
(`ui/public/exports/assets`). You do **not** need a `game/` or `exports/` junction
next to the editor anymore.

---

## Setup (dev)

### Prerequisites

| Tool | Required? | Notes |
|------|-----------|--------|
| **Node.js** | For building/running dev UI | Vite |
| **Rust + VS C++ Build Tools** | For Tauri | Needs `rc.exe` / Windows SDK |
| **Python 3.11+** | Runtime for the bridge | **3.12+ recommended.** If missing, the app downloads the official embeddable build automatically. |

### Run

```bat
Start.bat
```

That installs UI deps if needed, ensures the Tauri CLI, and runs `cargo tauri dev`
(hot reload for the frontend).

### First launch flow

1. **XI Tools** modal — download/update xi-tools (or **Use local folder…** → e.g. `D:\xi-tools`)
2. Python bootstrap if needed (may take a bit on first run; pip installs requirements)
3. Bridge starts on `127.0.0.1:8777`
4. **Workspace Setup** — pick a folder for projects / change-sets
5. **Game Paths** — set `FFXI_DIR` (browse); optional HD, pivot, Blender  
   Green ticks when paths look valid (`FFXiMain.dll` found, etc.)
6. **Projects** launcher — open or create a project and load a zone

### Manual `.env` (until DB setup is in the UI)

xi-tools settings live in the tools install’s `.env`, e.g.

`%LOCALAPPDATA%\XiZoneEditor\xi-tools\.env`

or your local checkout’s `.env` if you used **Use local folder…**.

For DB-backed features, add (example):

```env
XI_DB_HOST=127.0.0.1
XI_DB_PORT=3306
XI_DB_USER=root
XI_DB_PASSWORD=xi
XI_DB_NAME=tpzdb
```

Optional extras: `XI_SERVER_DIR`, `XI_NAVMESH_DIR`, `XI_EXPORTS_DIR` (if pre-decoded audio lives outside the tools tree).

Restart the editor (or let the bridge restart) after editing `.env` if values were already loaded — path setup via the UI hot-reloads; hand-edited DB keys may need a relaunch.

---

## Production build

```bat
Build.bat
```

Produces `src-tauri\target\release\xi-zone-editor.exe`.  
End users of the `.exe` do **not** need Node; they still need the bridge stack
(xi-tools + Python), which the app bootstraps on first run.

---

## Layout

| Path | Role |
|------|------|
| `ui/` | Frontend (Vite + three.js) |
| `ui/public/exports/assets/` | Bundled Asset Browser manifests, sprites, PNG thumbs |
| `src-tauri/` | Tauri shell: download tools, Python bootstrap, spawn/kill bridge |
| `Start.bat` / `Build.bat` | Dev / release |

Runtime data (downloaded tools, embeddable Python, logs):

`%LOCALAPPDATA%\XiZoneEditor\`

---

## Bridge reference

| Endpoint | Purpose |
|----------|---------|
| `ws://127.0.0.1:8777/ws` | JSON-RPC style editor commands |
| `http://127.0.0.1:8777/game/…` | Files under `FFXI_DIR` |
| `http://127.0.0.1:8777/game-hd/…` | Files under `FFXI_HD_DIR` |
| `http://127.0.0.1:8777/exports/…` | Optional xi-tools exports (e.g. cached WAVs) |
| `http://127.0.0.1:8777/health` | Liveness |

---

## Related

- [xi-tools](https://github.com/vekien/xi-tools) — CLI + bridge
- [xi-model-viewer](https://github.com/vekien/xi-model-viewer) — asset browser
