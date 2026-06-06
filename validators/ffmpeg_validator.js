const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { classifyFFmpegErrors } = require("./error_patterns");

const MAX_OUTPUT_BYTES = 1024 * 1024; // cap ffmpeg/ffprobe captured stdout+stderr at 1 MiB each
const VALIDATION_TIMEOUT = 30000;
const SAMPLE_DECODE_TIMEOUT = 45000;
const TAIL_DECODE_TIMEOUT = 60000;
const DEEP_DECODE_TIMEOUT = 90000;
const SIZE_BASED_TIMEOUT_MB = 256;
const TIMEOUT_PER_MB_MS = 80;

function validResult(extra = {}) {
	return { valid: true, status: "valid", error: null, ...extra };
}

function invalidResult(error, extra = {}) {
	return { valid: false, status: "invalid", error, ...extra };
}

function inconclusiveResult(error, extra = {}) {
	return { valid: null, status: "inconclusive", error, ...extra };
}

/**
 * Scale a base timeout up for large files. Accepts an optional pre-resolved file
 * size (bytes) to avoid a redundant fs.statSync in hot loops; falls back to
 * statSync only when the size is not provided.
 * @param {string} filePath
 * @param {number} baseTimeout
 * @param {number} [knownSize] - file size in bytes if already known
 * @returns {number}
 */
function getScaledTimeout(filePath, baseTimeout, knownSize = null) {
	let sizeBytes = Number.isFinite(knownSize) ? knownSize : null;
	if (sizeBytes === null) {
		try {
			sizeBytes = fs.statSync(filePath).size;
		} catch {
			return baseTimeout;
		}
	}
	const sizeMB = sizeBytes / (1024 * 1024);
	if (sizeMB > SIZE_BASED_TIMEOUT_MB) {
		return baseTimeout + Math.ceil(sizeMB - SIZE_BASED_TIMEOUT_MB) * TIMEOUT_PER_MB_MS;
	}
	return baseTimeout;
}

let ffmpegPath = null;
let ffprobePath = null;

const logger = require("../utils/logger");

const log = {
	debug: (msg) => {
		if (process.argv.includes("--debug")) {
			logger.writeSync("debug", `[VALID] ${msg}`);
		}
	},
	error: (msg) => logger.writeSync("error", `[VALID ERROR] ${msg}`),
};

/**
 * @deprecated Use spawn-based approach (execPromise with array arguments) instead.
 * This function does NOT sanitize embedded quotes and is unsafe for shell execution.
 * Kept only for backward compatibility with external consumers.
 */
function escapePathForCmd(filePath) {
	const escaped = filePath.replace(/'/g, "''");
	return `"${escaped}"`;
}

async function findFFmpeg() {
	if (ffmpegPath && ffprobePath) {
		log.debug(`findFFmpeg: using cached paths ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
		return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
	}

	return new Promise((resolve) => {
		const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
		log.debug(`findFFmpeg: searching with command: ${cmd}`);

		exec(cmd, (error, stdout) => {
			if (error || !stdout.trim()) {
				log.debug(`findFFmpeg: ffmpeg not found, error=${error?.message || "no stdout"}`);
				resolve(null);
				return;
			}

			const ffmpegBin = stdout.trim().split("\n")[0];
			log.debug(`findFFmpeg: found ffmpeg at ${ffmpegBin}`);

			const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
			log.debug(`findFFmpeg: checking ffprobe at ${ffprobeBin}`);

			if (fs.existsSync(ffprobeBin)) {
				ffmpegPath = ffmpegBin;
				ffprobePath = ffprobeBin;
				log.debug(`findFFmpeg: success, ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
				resolve({ ffmpeg: ffmpegPath, ffprobe: ffprobePath });
			} else {
				log.debug(`findFFmpeg: ffprobe not at expected path, trying alternative`);
				const altFfprobe = ffmpegBin.replace(/ffmpeg\.exe$/, "ffprobe.exe");
				if (fs.existsSync(altFfprobe)) {
					ffmpegPath = ffmpegBin;
					ffprobePath = altFfprobe;
					log.debug(`findFFmpeg: success with alt ffprobe, ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
					resolve({ ffmpeg: ffmpegPath, ffprobe: altFfprobe });
				} else {
					log.debug(`findFFmpeg: ffprobe not found at ${altFfprobe}`);
					resolve(null);
				}
			}
		});
	});
}

function execPromise(cmd, timeout = VALIDATION_TIMEOUT) {
	log.debug(`execPromise: executing command, timeout=${timeout}ms`);

	return new Promise((resolve) => {
		let settled = false;
		const startTime = Date.now();
		const done = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		if (Array.isArray(cmd)) {
			const [bin, ...args] = cmd;
			// Do NOT pass spawn's own `timeout` option: it sends SIGTERM and the
			// resulting `close` event reports timedOut:false, masking a timeout as
			// a normal non-zero exit. We manage the timeout ourselves below via
			// setTimeout + killProcessTree, which labels it correctly.
			const proc = spawn(bin, args, { windowsHide: true });

			let stdout = "";
			let stderr = "";

			const appendCapped = (current, chunk) => {
				if (current.length >= MAX_OUTPUT_BYTES) {
					return current;
				}
				return (current + chunk.toString()).slice(0, MAX_OUTPUT_BYTES);
			};

			proc.stdout.on("data", (chunk) => {
				stdout = appendCapped(stdout, chunk);
			});
			proc.stderr.on("data", (chunk) => {
				stderr = appendCapped(stderr, chunk);
			});

			const killProcessTree = () => {
				if (process.platform === "win32" && proc.pid) {
					try {
						const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
							windowsHide: true,
						});
						killer.on("error", () => {});
					} catch {
						/* best effort on Windows */
					}
				} else {
					proc.kill("SIGKILL");
				}
			};

			proc.on("error", (err) => {
				log.error(`execPromise: process error: ${err.message}`);
				done({ stdout, stderr, exitCode: 1, timedOut: false });
			});

			proc.on("close", (exitCode) => {
				if (settled) return;
				const elapsed = Date.now() - startTime;
				log.debug(
					`execPromise: completed in ${elapsed}ms, exitCode=${exitCode}, stdout.length=${stdout.length}, stderr.length=${stderr.length}`,
				);
				done({ stdout, stderr, exitCode: exitCode !== null ? exitCode : 0, timedOut: false });
			});

			const timeoutId = setTimeout(() => {
				log.error(`execPromise: timeout after ${timeout}ms`);
				killProcessTree();
				done({ stdout, stderr, exitCode: 1, timedOut: true });
			}, timeout);

			proc.on("close", () => clearTimeout(timeoutId));
			proc.on("error", () => clearTimeout(timeoutId));

			return;
		}

		const proc = exec(cmd, { timeout }, (error, stdout, stderr) => {
			if (settled) return;
			const elapsed = Date.now() - startTime;
			const exitCode =
				error && error.killed
					? 1
					: error && error.code !== "SIGTERM" && error.code !== "SIGKILL"
						? error.code
						: 0;

			log.debug(
				`execPromise: completed in ${elapsed}ms, exitCode=${exitCode}, stdout.length=${stdout?.length || 0}, stderr.length=${stderr?.length || 0}`,
			);

			done({
				stdout: stdout || "",
				stderr: stderr || "",
				exitCode: exitCode,
				timedOut: false,
			});
		});

		proc.on("error", (err) => {
			log.error(`execPromise: process error: ${err.message}`);
			done({ stdout: "", stderr: "Process error", exitCode: 1, timedOut: false });
		});

		proc.on("timeout", () => {
			log.error(`execPromise: timeout after ${timeout}ms`);
			if (process.platform === "win32" && proc.pid) {
				try {
					// taskkill via spawn-based exec to avoid shell injection
					const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
					killer.on("error", () => {});
				} catch {
					/* best effort on Windows */
				}
			} else {
				proc.kill("SIGKILL");
			}
			done({ stdout: "", stderr: "Validation timed out", exitCode: 1, timedOut: true });
		});
	});
}

async function validateImage(filePath, ffmpegBin, knownSize = null) {
	log.debug(`validateImage: file=${filePath}, ffmpeg=${ffmpegBin}`);

	const cmd = [ffmpegBin, "-v", "error", "-i", filePath, "-f", "null", "-"];

	log.debug(`validateImage: running command: ${cmd.join(" ")}`);

	const result = await execPromise(cmd, getScaledTimeout(filePath, VALIDATION_TIMEOUT, knownSize));

	if (result.exitCode === 0) {
		log.debug(`validateImage: valid, file=${path.basename(filePath)}`);
		return validResult();
	}

	if (result.timedOut) {
		log.debug(`validateImage: timeout (inconclusive), file=${path.basename(filePath)}`);
		return inconclusiveResult("ffmpeg image validation timed out", { timedOut: true });
	}

	const { fatalErrors, nonFatalErrors, unknownErrors } = classifyFFmpegErrors(result.stderr, result.stdout);

	if (fatalErrors.length === 0 && nonFatalErrors.length > 0) {
		log.debug(
			`validateImage: non-fatal errors only, treating as valid, file=${path.basename(filePath)}, nonFatal=${nonFatalErrors.length}`,
		);
		return validResult();
	}

	if (fatalErrors.length === 0) {
		const unknownMsg = unknownErrors.join("; ").substring(0, 200) || `ffmpeg exit code ${result.exitCode}`;
		log.debug(`validateImage: inconclusive, file=${path.basename(filePath)}, error=${unknownMsg}`);
		return inconclusiveResult(`ffmpeg image inconclusive: ${unknownMsg}`, { unknownErrors });
	}

	const errorMsg = fatalErrors.join("; ").substring(0, 200);
	log.debug(`validateImage: invalid, file=${path.basename(filePath)}, error=${errorMsg}`);
	return invalidResult(`ffmpeg: ${errorMsg}`, { fatalErrors, nonFatalErrors, unknownErrors });
}

async function validateVideo(filePath, ffprobeBin, knownSize = null) {
	log.debug(`validateVideo: file=${filePath}, ffprobe=${ffprobeBin}`);

	const cmd = [
		ffprobeBin,
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		filePath,
	];

	log.debug(`validateVideo: running command: ${cmd.join(" ")}`);

	const timeout = getScaledTimeout(filePath, VALIDATION_TIMEOUT, knownSize);
	const result = await execPromise(cmd, timeout);

	if (result.exitCode !== 0) {
		if (result.timedOut) {
			log.debug(`validateVideo: timed out (inconclusive), file=${path.basename(filePath)}`);
			return inconclusiveResult("ffprobe validation timed out", { timedOut: true });
		}
		const { fatalErrors, nonFatalErrors, unknownErrors } = classifyFFmpegErrors(result.stderr, result.stdout);
		if (fatalErrors.length > 0) {
			const errorMsg = fatalErrors.join("; ").substring(0, 200);
			return invalidResult(`ffprobe: ${errorMsg}`, { fatalErrors, nonFatalErrors, unknownErrors });
		}
		log.debug(`validateVideo: invalid (exit code), file=${path.basename(filePath)}, exitCode=${result.exitCode}`);
		return inconclusiveResult(`ffprobe exit code ${result.exitCode}`, { nonFatalErrors, unknownErrors });
	}

	const output = result.stdout.trim();
	log.debug(`validateVideo: output="${output}"`);

	if (output && !isNaN(parseFloat(output))) {
		log.debug(`validateVideo: valid, file=${path.basename(filePath)}, duration=${output}`);
		return validResult({ duration: parseFloat(output) });
	}

	// ffprobe exited 0 (it parsed the container without error) but did not report
	// a numeric duration. Some valid media legitimately lack a format duration
	// (e.g. certain streams/images-as-video). Treat as inconclusive rather than
	// invalid so we do not falsely quarantine a file ffprobe accepted.
	log.debug(
		`validateVideo: inconclusive (no duration), file=${path.basename(filePath)}, output="${output.substring(0, 50)}"`,
	);
	return inconclusiveResult(`ffprobe: no duration found (${output.substring(0, 50)})`);
}

async function validateVideoDeep(filePath, ffmpegBin, knownSize = null) {
	log.debug(`validateVideoDeep: file=${filePath}, ffmpeg=${ffmpegBin}`);

	const cmd = [ffmpegBin, "-v", "error", "-i", filePath, "-f", "null", "-"];

	const timeout = getScaledTimeout(filePath, DEEP_DECODE_TIMEOUT, knownSize);
	log.debug(`validateVideoDeep: running deep validation command, timeout=${timeout}ms`);

	const result = await execPromise(cmd, timeout);

	if (result.exitCode === 0) {
		log.debug(`validateVideoDeep: valid (deep), file=${path.basename(filePath)}`);
		return validResult();
	}

	if (result.timedOut) {
		log.debug(`validateVideoDeep: timed out (inconclusive), file=${path.basename(filePath)}`);
		return inconclusiveResult("ffmpeg deep decode timed out", { timedOut: true });
	}

	const { fatalErrors, nonFatalErrors, unknownErrors } = classifyFFmpegErrors(result.stderr, result.stdout);

	if (fatalErrors.length === 0) {
		if (nonFatalErrors.length > 0) {
			log.debug(
				`validateVideoDeep: non-fatal errors only, treating as valid, file=${path.basename(filePath)}, nonFatal=${nonFatalErrors.length}`,
			);
			return validResult({ nonFatalErrors });
		}
		log.debug(
			`validateVideoDeep: no classified errors but non-zero exit, inconclusive, file=${path.basename(filePath)}`,
		);
		const unknownMsg =
			unknownErrors.join("; ").substring(0, 200) || "ffmpeg deep decode exited without classified errors";
		return inconclusiveResult(`ffmpeg decode inconclusive: ${unknownMsg}`, { unknownErrors });
	}

	const errorMsg = fatalErrors.join("; ").substring(0, 200);
	log.debug(`validateVideoDeep: invalid (deep), file=${path.basename(filePath)}, error=${errorMsg}`);
	return invalidResult(`ffmpeg decode: ${errorMsg}`, { fatalErrors, nonFatalErrors, unknownErrors });
}

async function validateFile(filePath, type, ffmpegBin, ffprobeBin, deep = false) {
	log.debug(`validateFile: path=${filePath}, type=${type}, deep=${deep}`);

	if (!fs.existsSync(filePath)) {
		log.debug(`validateFile: file does not exist: ${filePath}`);
		return invalidResult("File does not exist");
	}

	let stats;
	try {
		stats = fs.statSync(filePath);
	} catch (err) {
		log.error(`validateFile: cannot stat file ${filePath}: ${err.message}`);
		return inconclusiveResult("Cannot stat file");
	}

	log.debug(`validateFile: file size=${stats.size} bytes`);

	if (stats.size === 0) {
		log.debug(`validateFile: file is empty: ${filePath}`);
		return invalidResult("File is empty");
	}

	const size = stats.size;
	if (type === "image") {
		return validateImage(filePath, ffmpegBin, size);
	} else {
		if (deep) {
			return validateVideoDeep(filePath, ffmpegBin, size);
		}
		return validateVideo(filePath, ffprobeBin, size);
	}
}

async function isFFmpegAvailable() {
	const result = await findFFmpeg();
	log.debug(`isFFmpegAvailable: ${result !== null}`);
	return result !== null;
}

async function getFFmpegPaths() {
	return findFFmpeg();
}

module.exports = {
	findFFmpeg,
	isFFmpegAvailable,
	getFFmpegPaths,
	execPromise,
	validateFile,
	validateImage,
	validateVideo,
	validateVideoDeep,
	validResult,
	invalidResult,
	inconclusiveResult,
	escapePathForCmd,
	classifyFFmpegErrors,
	getScaledTimeout,
	SAMPLE_DECODE_TIMEOUT,
	TAIL_DECODE_TIMEOUT,
	VALIDATION_TIMEOUT,
	DEEP_DECODE_TIMEOUT,
	SIZE_BASED_TIMEOUT_MB,
	TIMEOUT_PER_MB_MS,
};
