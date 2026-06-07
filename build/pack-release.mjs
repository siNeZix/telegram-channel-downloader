import { readFileSync, copyFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distDir = resolve(projectRoot, "dist");

const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
const version = pkg.version;
const exeName = "telegram-channel-downloader.exe";
const exePath = join(distDir, exeName);

const archiveName = `telegram-channel-downloader-v${version}-win-x64`;
const archiveDir = join(distDir, archiveName);

if (!existsSync(exePath)) {
	console.error(`EXE not found: ${exePath}`);
	console.error("Run 'npm run build' first.");
	process.exit(1);
}

mkdirSync(archiveDir, { recursive: true });

copyFileSync(exePath, join(archiveDir, exeName));

mkdirSync(join(archiveDir, "templates"), { recursive: true });
copyFileSync(resolve(projectRoot, "templates", "channels.ejs"), join(archiveDir, "templates", "channels.ejs"));

const readmeContent = `telegram-channel-downloader v${version} (Windows x64)
================================================

USAGE:
  telegram-channel-downloader.exe [command] [options]

EXTERNAL DEPENDENCIES:
  - FFmpeg/FFprobe must be installed and available in your system PATH
    for media validation features to work.
    Download from: https://ffmpeg.org/download.html

CONFIGURATION:
  On first run, config.json will be created in the same directory as the exe.
  Edit it to add your Telegram API credentials (apiId and apiHash).

  Alternatively, set environment variables:
    TGDL_RUNTIME_ROOT  - Root directory (default: exe directory)
    TGDL_EXPORT_DIR    - Export output directory
    TGDL_CONFIG_FILE   - Config file path
    TGDL_LOGS_DIR      - Logs directory

TEMPLATES:
  The templates/ directory must be next to the exe for HTML export to work.

COMMANDS:
  download    - Full download (messages + media)
  rebuild-db  - Rebuild SQLite from Telegram API
  listen      - Real-time monitor
  valid       - Validate downloaded media
  snapshot    - Create validation snapshots
  export      - Rebuild JSON Lines from SQLite
  restore     - Restore quarantined files
  ids         - Download specific message IDs

Run: telegram-channel-downloader.exe --help
`;

writeFileSync(join(archiveDir, "README-standalone.txt"), readmeContent, "utf8");

const archivePath = join(distDir, `${archiveName}.zip`);
if (existsSync(archivePath)) {
	unlinkSync(archivePath);
}

const sevenZip = existsSync("C:\\Program Files\\7-Zip\\7z.exe");
if (sevenZip) {
	execSync(`"C:\\Program Files\\7-Zip\\7z.exe" a -tzip "${archivePath}" "${archiveDir}\\*"`, {
		cwd: distDir,
		stdio: "inherit",
	});
} else {
	try {
		execSync(
			`powershell -Command "Compress-Archive -Path '${archiveDir}\\*' -DestinationPath '${archivePath}' -Force"`,
			{
				stdio: "inherit",
			},
		);
	} catch {
		console.error("Neither 7-Zip nor PowerShell Compress-Archive available.");
		process.exit(1);
	}
}

console.log(`\nRelease archive: ${archivePath}`);
