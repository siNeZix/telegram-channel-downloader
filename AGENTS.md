# Agent Guide: telegram-channel-downloader

## Project Overview

Node.js CLI application for archiving Telegram channels, groups, and users.
Authenticates via Telegram API, downloads message history and media, stores
messages in per-channel SQLite databases, exports JSON Lines and HTML, and
validates media with FFmpeg.

**Repository:** https://github.com/siNeZix/telegram-channel-downloader

## Tech Stack

- **Runtime:** Node.js 20 (see `.nvmrc`)
- **Core libs:** `better-sqlite3`, `telegram` (MTProto client), `ejs`, `inquirer`, `mime-db`, `file-type` (ESM-only; dynamic import), `mp4box`
- **Dev tools:** ESLint + Prettier, native Node.js test runner
- **External deps:** FFmpeg / FFprobe in PATH (for validation features)

## Project Structure

```text
├── index.js                     # entry point; CLI menu, auth, shutdown logic
├── config.json                  # Telegram credentials + download settings (auto-created)
├── package.json
├── export/                      # per-channel output folders
│   └── <channelId>/
│       ├── messages.db          # SQLite (raw + processed messages, download state)
│       ├── raw_message.json     # JSON Lines raw Telegram objects
│       ├── all_message.json     # JSON Lines processed messages
│       ├── messages.html        # HTML export
│       ├── image/ video/ audio/ pdf/ sticker/
│       └── snapshots/           # validation snapshots
├── cli/
│   └── commands.js              # command catalog: specs, parseCommand, help
├── modules/
│   ├── auth.js                  # Telegram session auth & StringSession
│   ├── dialoges.js              # dialog search / selection helpers
│   └── messages.js              # message fetching & download orchestration
├── services/
│   ├── DownloadManager.js       # batch media download with concurrency control
│   ├── MessageService.js        # raw → processed message transformation; DB persistence
│   ├── TelegramEntityResolver.js# entity caching (LRU 1000) for channel info
│   ├── ValidationService.js     # cheap-first validation cascade orchestrator
│   ├── ValidationOutcome.js     # shared verdict classifier + DB/quarantine applier
│   ├── HashVerifier.js          # L8 integrity via Telegram upload.getFileHashes (SHA256)
│   ├── FloodControl.js          # RPC flood handling & exponential backoff
│   └── ProgressLogger.js        # periodic progress summaries
├── utils/
│   ├── db.js                    # SQLite abstraction; upserts, exports, snapshots
│   ├── config.js                # live-reloading config manager with defaults
│   ├── logger.js                # file + console logger with async debug stream
│   ├── helper.js                # MEDIA_TYPES constants, snapshot caching utils
│   ├── concurrency.js           # shared `runPool` worker-pool helper
│   ├── cli_utils.js             # shared CLI flag parser (`takeOptionValue`, `parseArgs`, `parseRuntimeOptions`)
│   ├── input_helper.js          # inquirer wrappers (`promptSafe`, EOF handling)
│   ├── file_helper.js           # last-selection JSON, quarantine logic
│   ├── paths.js                 # centralized path constants
│   ├── save_files.js            # create snapshots across export channels
│   ├── export_messages.js       # rebuild raw_message.json & all_message.json from DB
│   └── restore_quarantine.js    # restore files from quarantine
├── validators/
│   ├── index.js                 # validation engine (`runValidation`); standalone-runnable
│   ├── ffmpeg_validator.js      # FFmpeg/FFprobe media checks (spawn-based, no shell)
│   ├── error_patterns.js        # ffmpeg stderr fatal/non-fatal/unknown classifier
│   ├── signatures.js            # L1/L2 magic-byte header + trailer checks (no deps)
│   ├── container_probe.js       # L3 file-type + L4 mp4box moov structural probes
│   └── file_scanner.js          # directory scanning for validation targets
├── templates/
│   └── (ejs templates for HTML export)
└── tests/
    ├── config-manager.test.js
    ├── download-manager.test.js
    ├── flood-control.test.js
    └── message-service.test.js
```

## Important Code Conventions

- **Indent:** tabs, width 4 (see `.editorconfig` and `.prettierrc`)
- **Quotes:** double quotes preferred
- **ESLint:** `no-var: error`, `prefer-const: warn`, `no-console: off`
- **Imports:** CommonJS (`require`/`module.exports`)
- **No dead code / no console dumps in modules** — use `logger.js` or `logMessage()` from `utils/helper.js`

## Configuration

`config.json` is created on first run with these sections:

```json
{
	"apiId": 123456,
	"apiHash": "...",
	"sessionId": null,
	"download": {
		"maxParallel": 20,
		"minParallel": 2,
		"baseRpcDelaySeconds": 0.05,
		"messageLimit": 200,
		"fastForwardMessageLimit": 1000,
		"checkProgressIntervalFiles": 100,
		"maxValidationRetries": 3,
		"retryDelaySeconds": 2,
		"validationProfile": "sampled",
		"validationParallel": 10,
		"verifyHash": false,
		"quarantineInvalidFiles": true,
		"trustSnapshotsForValidation": false
	},
	"logging": {
		"progressLogIntervalSeconds": 5
	}
}
```

The config watcher in `utils/config.js` reloads values automatically while the
process is running.

## CLI Entry Modes

All commands route through a single unified CLI layer:

- `utils/cli_utils.js` — shared `takeOptionValue`, declarative `parseArgs(spec)`,
  `resolveChannelId`, `resolveExportDir`, `formatHelp`.
- `cli/commands.js` — the command catalog (specs, `parseCommand`,
  `toValidationOptions`, `toCheckMode`, help renderers).

`index.js` strips runtime path options first (`parseRuntimeOptions`), resolves the
leading non-flag token as the command, then parses command-specific flags.

| Command                                             | Behavior                                |
| --------------------------------------------------- | --------------------------------------- |
| `node index.js`                                     | Interactive menu                        |
| `node index.js download [--channel <id>]`           | Full download (messages + media)        |
| `node index.js download --auto` (`-y`)              | Non-interactive download                |
| `node index.js download --check` / `--deep`         | Validate existing files during download |
| `node index.js rebuild-db [--channel <id>]`         | Rebuild SQLite from Telegram API        |
| `node index.js listen [--channel <id>]`             | Real-time monitor                       |
| `node index.js ids --channel <id> --messages <a,b>` | Download specific message IDs           |
| `node index.js valid [path] [--deep] [--cache] ...` | Validate downloaded media               |
| `node index.js snapshot [path]`                     | Create validation snapshots             |
| `node index.js export [path]`                       | Rebuild JSON Lines from SQLite          |
| `node index.js restore [channelId...]`              | Restore quarantined files               |

Global options on every command: `--root`, `--export-dir`, `--config-file`,
`--logs-dir`, plus `--help`/`-h` and `--version`. Validation depth is unified to
`--check` (fast cascade, no decode), `--deep` (full decode), `--strict` (deep +
strict profile). `--verify-hash` adds exact SHA256 integrity verification via
Telegram (download/listen only; extra RPC per file). Unknown commands/flags exit
non-zero and print help.

## Architecture Notes for Agents

### Shutdown Flow

All graceful exits must go through `shutdown()` in `index.js`. It:

1. Cancels active downloads (`cancelAllDownloads()`)
2. Disconnects Telegram client
3. Closes all DB connections (`db.closeAllConnections()`)
4. Closes logger streams

**Do NOT call `process.exit()` directly** in modules; instead call `shutdown()` or
throw to let the top-level handler catch it.

### Database

- One SQLite DB per channel under `export/<channelId>/messages.db`.
- `better-sqlite3` is synchronous; keep write transactions scoped.
- `upsertStatements` is a module-level WeakMap-style cache per DB path.
  Cleared on `closeDatabase()` / `closeAllConnections()`.

### Download Manager

- Instance holds mutable state: `client`, `channelId`, `outputFolder`,
  `cancelCurrent`. Validation depth flows in via the batch `context`
  (`validationProfile`, `deepValidation`, `verifyHash`).
- **Beware:** `processMessageBatch` receives scoped parameters (`batchChannelId`,
  `batchOutputFolder`, etc.) to avoid concurrent batch overwrites.
- `activeDownloads` is a Set of Promises; **never call `Promise.race([])`**.

### Input Helper

Always use `promptSafe()` from `utils/input_helper.js` instead of raw
`inquirer.prompt()` so EOF (Ctrl+Z) is handled without unhandled rejections.

### Validation & FFmpeg

- `ValidationService.validateMediaFile()` runs a **cheap-first cascade** with
  early exit, doing one `fs.statSync` per file:
    - L0 size match (`expectedSize`) — catches truncated downloads instantly.
    - L1/L2 magic bytes + trailer (`validators/signatures.js`) — no deps, no spawn.
    - L3/L4 container probe (`validators/container_probe.js`): `file-type` family
      check + `mp4box` moov structural parse for ISO BMFF.
    - Ln ffmpeg/ffprobe decode — only when the profile requires a decode or the
      cheap layers were inconclusive.
- Profiles are the cascade's stop points: `none`, `fast` (L0–L5, no decode),
  `sampled` (default video), `full`, `strict` (`-xerror`). `--strict` no longer
  collapses into `--deep`; the resolved profile flows through `cli/commands.js`
  → `index.js` → `MessageService` → `DownloadManager` → `validateMediaFile`.
- A non-zero ffmpeg exit with only **unknown** (unclassified) output is treated
  as **inconclusive**, never an automatic pass (see `validateVideoSampled`).
- `services/ValidationOutcome.js` is the single place that turns a result into a
  verdict and applies it (DB state + quarantine/requeue). Both the download path
  and `runValidation` route through it, so `inconclusive` files are **always
  kept**, never re-downloaded.
- `services/HashVerifier.js` (L8) verifies exact integrity via
  `upload.getFileHashes` (SHA256). It is opt-in (`--verify-hash`) and also used to
  auto-resolve an `inconclusive` verdict during download/listen. It costs ≥1 RPC
  per file and a full local read, so it never runs in the standalone `valid`
  command (no live session).
- ffmpeg/ffprobe always run via `child_process.spawn()` with argument arrays.
  **Never use shell strings** for file paths (command injection risk).
- `escapePathForCmd()` still exists in `ffmpeg_validator.js` for external
  consumers but is not used internally.
- ffmpeg error classification lives in `validators/error_patterns.js`
  (`classifyFFmpegErrors` → fatal / non-fatal / unknown buckets).
- Validation concurrency is `download.validationParallel` (default 10), applied
  via the shared `utils/concurrency.js` `runPool` helper.

### Logger

- Call `logger.init()` before the first write and `logger.close()` before exit.
- `logger.writeSync()` is safe for shutdown/error paths.
- `logger.write()` returns a Promise (used for batched debug logging).

## npm Scripts

```bash
npm start            # interactive CLI
npm run dev          # nodemon (ignores export/, config.json, validators/)
npm run download     # node index.js download
npm run download:auto # node index.js download --auto
npm run rebuild-db   # node index.js rebuild-db
npm run listen       # node index.js listen
npm run valid        # node index.js valid
npm run snapshot     # node index.js snapshot
npm run export       # node index.js export (rebuild JSON Lines from SQLite)
npm run restore      # node index.js restore (restore quarantined files)
npm test             # native Node.js test runner
npm run lint         # eslint
npm run format       # prettier --write
npm run format:check # prettier --check
```

## Testing

All tests use the built-in `node --test` runner (no external test framework).
Run with `npm test`.

## Known Hazards (Post-Audit)

- `config.json` stores real Telegram credentials in plain text. It is git-ignored
  but **must not be committed**.
- `TelegramEntityResolver` cache is LRU-limited (1000 entries) to prevent OOM in
  long listener sessions.
- Export generation (`db.js`) uses `fs.createWriteStream`; do not revert to
  `appendFileSync` per row.

## License

ISC
