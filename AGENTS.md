# Agent Guide: telegram-channel-downloader

## Project Overview

Node.js CLI application for archiving Telegram channels, groups, and users.
Authenticates via Telegram API, downloads message history and media, stores
messages in per-channel SQLite databases, exports JSON Lines and HTML, and
validates media with FFmpeg.

**Repository:** https://github.com/siNeZix/telegram-channel-downloader

## Tech Stack

- **Runtime:** Node.js 20 (see `.nvmrc`)
- **Core libs:** `better-sqlite3`, `telegram` (MTProto client), `ejs`, `inquirer`, `mime-db`
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
├── modules/
│   ├── auth.js                  # Telegram session auth & StringSession
│   ├── dialoges.js              # dialog search / selection helpers
│   └── messages.js              # message fetching & download orchestration
├── services/
│   ├── DownloadManager.js       # batch media download with concurrency control
│   ├── MessageService.js        # raw → processed message transformation; DB persistence
│   ├── TelegramEntityResolver.js# entity caching (LRU 1000) for channel info
│   ├── ValidationService.js     # batch validator wrapper
│   ├── FloodControl.js          # RPC flood handling & exponential backoff
│   └── ProgressLogger.js        # periodic progress summaries
├── utils/
│   ├── db.js                    # SQLite abstraction; upserts, exports, snapshots
│   ├── config.js                # live-reloading config manager with defaults
│   ├── logger.js                # file + console logger with async debug stream
│   ├── helper.js                # MEDIA_TYPES constants, snapshot caching utils
│   ├── cli_utils.js             # shared CLI flag parser (`takeOptionValue`, `parseRuntimeOptions`)
│   ├── input_helper.js          # inquirer wrappers (`promptSafe`, EOF handling)
│   ├── file_helper.js           # last-selection JSON, quarantine logic
│   ├── paths.js                 # centralized path constants
│   ├── save_files.js            # create snapshots across export channels
│   ├── export_messages.js       # rebuild raw_message.json & all_message.json from DB
│   └── restore_quarantine.js    # restore files from quarantine
├── validators/
│   ├── index.js                 # standalone validation CLI
│   ├── ffmpeg_validator.js      # FFmpeg/FFprobe media checks (spawn-based, no shell)
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

| Command                       | Behavior                             |
| ----------------------------- | ------------------------------------ |
| `node index.js`               | Interactive menu                     |
| `node index.js --auto` (`-y`) | Non-interactive; accept all defaults |
| `node index.js --check`       | Fast file validation duringdownload  |
| `node index.js --deep-check`  | Deep validation during download      |
| `node index.js valid`         | Run standalone validator             |
| `node index.js rebuild-db`    | Rebuild SQLite from Telegram API     |

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
  `cancelCurrent`, `checkMode`.
- **Beware:** `processMessageBatch` receives scoped parameters (`batchChannelId`,
  `batchOutputFolder`, etc.) to avoid concurrent batch overwrites.
- `activeDownloads` is a Set of Promises; **never call `Promise.race([])`**.

### Input Helper

Always use `promptSafe()` from `utils/input_helper.js` instead of raw
`inquirer.prompt()` so EOF (Ctrl+Z) is handled without unhandled rejections.

### Validation & FFmpeg

- Validation commands run via `child_process.spawn()` with argument arrays.
  **Never use shell strings** for file paths (command injection risk).
- `escapePathForCmd()` still exists in `ffmpeg_validator.js` for external
  consumers but is not used internally.

### Logger

- Call `logger.init()` before the first write and `logger.close()` before exit.
- `logger.writeSync()` is safe for shutdown/error paths.
- `logger.write()` returns a Promise (used for batched debug logging).

## npm Scripts

```bash
npm start          # interactive CLI
npm run dev        # nodemon (ignores export/, config.json, validators/)
npm test           # native Node.js test runner
npm run valid      # standalone validator
npm run save-files # generate validation snapshots
npm run export-messages   # rebuild JSON Lines from SQLite
npm run restore-quarantine # restore quarantined files
npm run lint       # eslint
npm run format     # prettier --write
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
