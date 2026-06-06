const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const VALIDATION_TIMEOUT = 30000;
const SAMPLE_DECODE_TIMEOUT = 45000;
const TAIL_DECODE_TIMEOUT = 60000;
const DEEP_DECODE_TIMEOUT = 90000;
const SIZE_BASED_TIMEOUT_MB = 256;
const TIMEOUT_PER_MB_MS = 80;

const FATAL_ERROR_PATTERNS = [
	/moov atom not found/i,
	/truncated file/i,
	/no frame found/i,
	/could not find codec parameters/i,
	/could not find header/i,
	/invalid data found/i,
	/cannot find codec/i,
	/no such file or directory/i,
	/permission denied/i,
	/error number .+ occurred/i,
	/bitstream filter error/i,
	/format not found/i,
	/could not open/i,
	/protocol not found/i,
	/invalid argument/i,
	/no output stream/i,
	/encoder .* not found/i,
	/muxer .* not found/i,
];

const NON_FATAL_ERROR_PATTERNS = [
	/missing reference picture/i,
	/concealing .* errors/i,
	/decode_slice_header error/i,
	/non-existing SPS .* decoded/i,
	/non-existing PPS .* decoded/i,
	/non-existing SPS/i,
	/non-existing PPS/i,
	/error while decoding MB/i,
	/corrupt input packet/i,
	/AVPacket side data/i,
	/invalid NAL unit size/i,
	/missing picture in access unit/i,
	/First frame .* second frame/i,
	/discarding .* samples/i,
	/mismatch in allocated/i,
	/hmm: cannot stream .* fast/i,
	/out of range:/i,
	/noise .* exceed/i,
	/picture size .* invalid/i,
	/mismatch.*in.*header/i,
];

function classifyFFmpegErrors(stderr, stdout) {
	const combined = (stderr || "") + "\n" + (stdout || "");
	const lines = combined.split(/\r?\n/).filter((l) => l.trim());

	const fatalErrors = [];
	const nonFatalErrors = [];
	const unknownErrors = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let isNonFatal = false;
		for (const pattern of NON_FATAL_ERROR_PATTERNS) {
			if (pattern.test(trimmed)) {
				nonFatalErrors.push(trimmed);
				isNonFatal = true;
				break;
			}
		}
		if (isNonFatal) continue;

		let isFatal = false;
		for (const pattern of FATAL_ERROR_PATTERNS) {
			if (pattern.test(trimmed)) {
				fatalErrors.push(trimmed);
				isFatal = true;
				break;
			}
		}
		if (!isFatal && !isNonFatal && trimmed.length > 0) {
			unknownErrors.push(trimmed);
		}
	}

	return { fatalErrors, nonFatalErrors, unknownErrors };
}

function validResult(extra = {}) {
	return { valid: true, status: "valid", error: null, ...extra };
}

function invalidResult(error, extra = {}) {
	return { valid: false, status: "invalid", error, ...extra };
}

function inconclusiveResult(error, extra = {}) {
	return { valid: null, status: "inconclusive", error, ...extra };
}

function getScaledTimeout(filePath, baseTimeout) {
	try {
		const stats = fs.statSync(filePath);
		const sizeMB = stats.size / (1024 * 1024);
		if (sizeMB > SIZE_BASED_TIMEOUT_MB) {
			return baseTimeout + Math.ceil(sizeMB - SIZE_BASED_TIMEOUT_MB) * TIMEOUT_PER_MB_MS;
		}
	} catch {
		/* use base */
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
			const proc = spawn(bin, args, { timeout, windowsHide: true });

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			proc.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

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
				proc.kill("SIGKILL");
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
					const { spawn } = require("child_process");
					const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
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

async function validateImage(filePath, ffmpegBin) {
	log.debug(`validateImage: file=${filePath}, ffmpeg=${ffmpegBin}`);

	const cmd = [ffmpegBin, "-v", "error", "-i", filePath, "-f", "null", "-"];

	log.debug(`validateImage: running command: ${cmd.join(" ")}`);

	const result = await execPromise(cmd, VALIDATION_TIMEOUT);

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

async function validateVideo(filePath, ffprobeBin) {
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

	const timeout = getScaledTimeout(filePath, VALIDATION_TIMEOUT);
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

	log.debug(
		`validateVideo: invalid (no duration), file=${path.basename(filePath)}, output="${output.substring(0, 50)}"`,
	);
	return invalidResult(`ffprobe: no duration found (${output.substring(0, 50)})`);
}

async function validateVideoDeep(filePath, ffmpegBin) {
	log.debug(`validateVideoDeep: file=${filePath}, ffmpeg=${ffmpegBin}`);

	const cmd = [ffmpegBin, "-v", "error", "-i", filePath, "-f", "null", "-"];

	const timeout = getScaledTimeout(filePath, DEEP_DECODE_TIMEOUT);
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

	try {
		const stats = fs.statSync(filePath);
		log.debug(`validateFile: file size=${stats.size} bytes`);

		if (stats.size === 0) {
			log.debug(`validateFile: file is empty: ${filePath}`);
			return invalidResult("File is empty");
		}
	} catch (err) {
		log.error(`validateFile: cannot stat file ${filePath}: ${err.message}`);
		return inconclusiveResult("Cannot stat file");
	}

	if (type === "image") {
		return validateImage(filePath, ffmpegBin);
	} else {
		if (deep) {
			return validateVideoDeep(filePath, ffmpegBin);
		}
		return validateVideo(filePath, ffprobeBin);
	}
}

async function validateFiles(files, ffmpegPaths, progressCallback, maxParallel = 10, deep = false) {
	log.debug(`validateFiles: count=${files.length}, maxParallel=${maxParallel}, deep=${deep}`);

	let valid = 0;
	let invalid = 0;
	const errors = [];

	let fileIndex = 0;

	async function worker() {
		while (fileIndex < files.length) {
			const currentIndex = fileIndex++;

			if (currentIndex >= files.length) {
				break;
			}

			const file = files[currentIndex];
			log.debug(`validateFiles: processing file ${currentIndex + 1}/${files.length}: ${file.path}`);

			const result = await validateFile(file.path, file.type, ffmpegPaths.ffmpeg, ffmpegPaths.ffprobe, deep);

			if (progressCallback) {
				progressCallback(file, result);
			}

			if (result.valid) {
				valid++;
			} else {
				invalid++;
				errors.push({
					path: file.relativePath || file.path,
					error: result.error,
					size: file.size,
				});
			}
		}
	}

	log.debug(`validateFiles: starting ${Math.min(maxParallel, files.length)} workers`);
	const workers = [];
	for (let i = 0; i < Math.min(maxParallel, files.length); i++) {
		workers.push(worker());
	}

	await Promise.all(workers);

	log.debug(`validateFiles: complete, valid=${valid}, invalid=${invalid}, errors=${errors.length}`);

	return { valid, invalid, errors };
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
	validateFiles,
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
