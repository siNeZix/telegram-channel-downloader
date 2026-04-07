# Telegram Channel Downloader

Telegram Channel Downloader is a Node.js CLI application for archiving Telegram channels, groups, and users. It authenticates through the Telegram API, downloads message history and media files, stores message data in SQLite, exports JSON Lines files, creates HTML output, and can validate exported media with FFmpeg.

## What the project does

The project currently supports these workflows:

- Interactive Telegram authentication with saved session reuse.
- Full history download for a selected dialog.
- Real-time monitoring of new messages in a selected dialog.
- Downloading media from specific message IDs.
- SQLite-backed message storage per channel.
- Export of raw and processed messages into JSON Lines files.
- Snapshot creation for already downloaded files.
- FFmpeg-based validation of exported media files.
- Cache validation mode that checks exported files against the SQLite download state.

## Main features

### Interactive CLI menu
Running the main application opens an interactive menu with these actions:

- `Full Download (All messages with media)`
- `Real-time Monitor (Listen for new messages)`
- `Download by IDs (Specific message IDs)`
- `Run File Validators`
- `Exit`

### Authentication and session reuse
On the first run, the app asks for Telegram credentials and login confirmation data. The session string is then saved into `config.json` and reused on later runs so you do not need to log in every time.

### Full archive download
The downloader can fetch a full message history for a selected channel/group/user, save message metadata to SQLite, and download supported media into the `export/` folder.

### Real-time listener
The listener mode subscribes to new Telegram messages and keeps the process alive, downloading new content as it appears.

### Download by message IDs
You can manually provide a channel ID and one or more message IDs to download media only for specific messages.

### Validation and cleanup
The validator scans the export directory, verifies supported media using FFmpeg/FFprobe, can skip files already covered by snapshots, and can optionally compare files against the SQLite download cache.

## Project structure

```text
.
├── index.js
├── package.json
├── config.json                # auto-created on first run if missing
├── export/
│   ├── last_selection.json
│   └── <channelId>/
│       ├── messages.db
│       ├── raw_message.json
│       ├── all_message.json
│       ├── messages.html
│       ├── image/
│       ├── video/
│       ├── audio/
│       ├── pdf/
│       ├── sticker/
│       └── snapshots/
├── modules/
├── services/
├── templates/
├── utils/
└── validators/
```

Notes:

- `messages.db` stores raw and processed messages plus media download state.
- `raw_message.json` contains raw Telegram message objects in JSON Lines format.
- `all_message.json` contains processed message objects in JSON Lines format.
- `last_selection.json` stores the last selected dialog/channel.
- `snapshots/` stores generated file snapshots used by validation.

## Requirements

Before using the project, install:

- Node.js (current LTS recommended)
- npm or yarn
- FFmpeg and FFprobe in `PATH` if you plan to use validation features

## Installation

```bash
npm install
```

or

```bash
yarn install
```

## Telegram API setup

1. Create a Telegram application at https://my.telegram.org/apps.
2. Copy your `apiId` and `apiHash`.
3. Start the project once. If `config.json` does not exist, it is created automatically with default values.
4. Fill in `apiId` and `apiHash` in `config.json`.

Example `config.json`:

```json
{
  "apiId": 123456,
  "apiHash": "your_api_hash",
  "sessionId": null,
  "download": {
    "maxParallel": 20,
    "minParallel": 2,
    "baseRpcDelaySeconds": 0.05,
    "messageLimit": 200,
    "fastForwardMessageLimit": 1000,
    "checkProgressIntervalFiles": 100
  },
  "logging": {
    "progressLogIntervalSeconds": 5
  }
}
```

Configuration notes:

- `sessionId` is written automatically after a successful first login.
- The configuration loader merges your file with internal defaults.
- The app watches `config.json`, so updated values can be reloaded automatically while the process is running.

## Running the application

Start the interactive CLI:

```bash
npm start
```

Development mode with auto-restart:

```bash
npm run dev
```

### First login flow

On the first run, the application will:

1. Ask where to receive the OTP code (`Telegram app` or `SMS`).
2. Ask for your phone number.
3. Ask for the Telegram login code.
4. Ask for 2FA password if your account uses it.
5. Save the resulting `sessionId` into `config.json`.

On later runs, the saved session is reused automatically.

## Main usage scenarios

### 1. Full download
Use this to archive an entire dialog.

Flow:

1. Start the app with `npm start`.
2. Select `Full Download`.
3. Reuse the last selected channel or pick another one.
4. Choose which file types should be downloaded.
5. Wait until message history and media are processed.

The downloader can optionally work with additional checks:

```bash
node index.js --check
```

```bash
node index.js --deep-check
```

- `--check` enables fast checking during the download flow.
- `--deep-check` enables deeper checking during the download flow.

### 2. Real-time monitor
Use this mode to keep watching a dialog for new messages.

Flow:

1. Start the app with `npm start`.
2. Select `Real-time Monitor`.
3. Reuse the last selected channel or pick another one.
4. Leave the process running.

Stop the listener with `Ctrl+C`.

### 3. Download by IDs
Use this mode when you already know the Telegram channel ID and the message IDs you need.

Flow:

1. Start the app with `npm start`.
2. Select `Download by IDs`.
3. Enter the channel ID.
4. Enter comma-separated message IDs.

## Available npm scripts

### `npm start`
Runs the main interactive CLI from `index.js`.

### `npm run dev`
Runs the same CLI with Nodemon.

### `npm run valid`
Runs the standalone validator CLI from `validators/index.js`.

### `npm run save-files`
Scans every exported channel and creates snapshot files in each channel `snapshots/` folder.

### `npm run export-messages`
Reads every channel SQLite database and regenerates:

- `raw_message.json`
- `all_message.json`

## Export data layout

All exported data is stored under `export/`.

### Per-channel folder
Each downloaded channel gets its own folder:

```text
export/
└── <channelId>/
    ├── messages.db
    ├── raw_message.json
    ├── all_message.json
    ├── messages.html
    ├── image/
    ├── video/
    ├── audio/
    ├── pdf/
    ├── sticker/
    └── snapshots/
```

### SQLite storage
The project stores message data in `messages.db` for each channel. The database keeps:

- Telegram message ID
- message date
- raw JSON payload
- processed JSON payload
- `downloaded` status for media cache tracking

This database is later used by:

- export regeneration
- cache-aware validation
- media download state tracking

## Message export format

The current export files are written in JSON Lines format.

### `raw_message.json`
Contains one raw Telegram message JSON object per line.

Example:

```json
{"id":1,"message":"Hello","date":"2024-01-01T00:00:00.000Z"}
{"id":2,"message":"World","date":"2024-01-02T00:00:00.000Z"}
```

### `all_message.json`
Contains one processed message JSON object per line.

This format is useful because:

- files can be appended incrementally
- memory usage stays low
- exports can be rebuilt from SQLite later

## Validation

The validator is implemented as a separate CLI in `validators/index.js` and uses FFmpeg/FFprobe.

### Basic validation

```bash
npm run valid
```

### Dry run
Show what would be deleted without actually deleting files:

```bash
node validators/index.js --dry-run
```

### Verbose mode

```bash
node validators/index.js --verbose
```

### Validate only images

```bash
node validators/index.js --images
```

### Validate only videos

```bash
node validators/index.js --videos
```

### Deep validation

```bash
node validators/index.js --deep
```

### Ignore snapshots

```bash
node validators/index.js --ignore-snapshots
```

### Cache mode
Compare files against the SQLite `downloaded` state:

```bash
node validators/index.js --cache
```

### Cache mode with deep recovery
Try to validate DB-missing files and restore DB state for valid ones:

```bash
node validators/index.js --cache --deep
```

### Validate a custom export directory

```bash
node validators/index.js ./export
```

Validation behavior summary:

- checks that FFmpeg and FFprobe are available
- scans the export directory for supported media files
- skips files already covered by snapshots unless disabled
- can delete invalid files
- can compare filesystem state with SQLite cache state
- can restore DB flags for valid files in cache deep mode

## Snapshots

Snapshots are created with:

```bash
npm run save-files
```

What snapshots are used for:

- recording existing exported files per channel
- skipping already known-good files during later validation runs
- reducing repeated validation work

Each snapshot is written as a timestamped JSON file inside:

```text
export/<channelId>/snapshots/
```

## Re-exporting messages from SQLite

If JSON export files are missing, outdated, or need to be rebuilt from the database, run:

```bash
npm run export-messages
```

This scans channel folders in `export/`, opens each `messages.db`, and recreates JSON Lines exports.

## Notes and operational details

- The app stores the last selected dialog in `export/last_selection.json`.
- Validation features require FFmpeg binaries available from the command line.
- The project uses `better-sqlite3` for per-channel message storage.
- The interactive menu and most prompts are CLI-based and intended for local use.
- `config.json`, `export/`, and validator output are ignored by Nodemon to avoid unnecessary restarts.

## License

This project is licensed under the ISC License.
