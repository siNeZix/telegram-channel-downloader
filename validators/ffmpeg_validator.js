const { exec } = require("child_process");
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
	const lines = combined.split(/\r?\n/).filter(l => l.trim());

	const fatalErrors = [];
	const nonFatalErrors = [];

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
			fatalErrors.push(trimmed);
		}
	}

	return { fatalErrors, nonFatalErrors };
}

function getScaledTimeout(filePath, baseTimeout) {
	try {
		const stats = fs.statSync(filePath);
		const sizeMB = stats.size / (1024 * 1024);
		if (sizeMB > SIZE_BASED_TIMEOUT_MB) {
			return baseTimeout + Math.ceil(sizeMB - SIZE_BASED_TIMEOUT_MB) * TIMEOUT_PER_MB_MS;
		}
	} catch (e) { /* use base */ }
	return baseTimeout;
}

let ffmpegPath = null;
let ffprobePath = null;

const log = {
	debug: (msg) => {
		if (process.argv.includes("--debug")) {
			console.log(`[VALID] ${msg}`);
		}
	},
	error: (msg) => console.error(`[VALID ERROR] ${msg}`)
};

function escapePathForCmd(filePath) {
	let escaped = filePath.replace(/'/g, "''");
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
				log.debug(`findFFmpeg: ffmpeg not found, error=${error?.message || 'no stdout'}`);
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

		const proc = exec(cmd, { timeout }, (error, stdout, stderr) => {
			if (settled) return;
			const elapsed = Date.now() - startTime;
			const exitCode = error && error.killed
				? 1
				: (error && error.code !== "SIGTERM" && error.code !== "SIGKILL" ? error.code : 0);
			
			log.debug(`execPromise: completed in ${elapsed}ms, exitCode=${exitCode}, stdout.length=${stdout?.length || 0}, stderr.length=${stderr?.length || 0}`);
			
			done({
				stdout: stdout || "",
				stderr: stderr || "",
				exitCode: exitCode,
				timedOut: false
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
					exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
				} catch (e) {}
			} else {
				proc.kill("SIGKILL");
			}
			done({ stdout: "", stderr: "Validation timed out", exitCode: 1, timedOut: true });
		});
	});
}

async function validateImage(filePath, ffmpegBin) {
	log.debug(`validateImage: file=${filePath}, ffmpeg=${ffmpegBin}`);
	
	const escapedPath = escapePathForCmd(filePath);
	const escapedFfmpeg = escapePathForCmd(ffmpegBin);
	const cmd = `${escapedFfmpeg} -v error -i ${escapedPath} -f null -`;
	
	log.debug(`validateImage: running command: ${cmd}`);

	const result = await execPromise(cmd, VALIDATION_TIMEOUT);

	if (result.exitCode === 0) {
		log.debug(`validateImage: valid, file=${path.basename(filePath)}`);
		return { valid: true, error: null };
	}

	if (result.timedOut) {
		log.debug(`validateImage: timeout (treating as valid), file=${path.basename(filePath)}`);
		return { valid: true, error: null, timedOut: true };
	}

	const { fatalErrors, nonFatalErrors } = classifyFFmpegErrors(result.stderr, result.stdout);

	if (fatalErrors.length === 0 && nonFatalErrors.length > 0) {
		log.debug(`validateImage: non-fatal errors only, treating as valid, file=${path.basename(filePath)}, nonFatal=${nonFatalErrors.length}`);
		return { valid: true, error: null };
	}

	if (fatalErrors.length === 0) {
		log.debug(`validateImage: no classified errors, treating as valid, file=${path.basename(filePath)}`);
		return { valid: true, error: null };
	}

	const errorMsg = fatalErrors.join("; ").substring(0, 200);
	log.debug(`validateImage: invalid, file=${path.basename(filePath)}, error=${errorMsg}`);
	return { valid: false, error: `ffmpeg: ${errorMsg}` };
}

async function validateVideo(filePath, ffprobeBin) {
	log.debug(`validateVideo: file=${filePath}, ffprobe=${ffprobeBin}`);
	
	const escapedPath = escapePathForCmd(filePath);
	const escapedFfprobe = escapePathForCmd(ffprobeBin);
	const cmd = `${escapedFfprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${escapedPath}`;
	
	log.debug(`validateVideo: running command: ${cmd}`);

	const timeout = getScaledTimeout(filePath, VALIDATION_TIMEOUT);
	const result = await execPromise(cmd, timeout);

	if (result.exitCode !== 0) {
		if (result.timedOut) {
			log.debug(`validateVideo: timed out (treating as valid), file=${path.basename(filePath)}`);
			return { valid: true, error: null, timedOut: true };
		}
		log.debug(`validateVideo: invalid (exit code), file=${path.basename(filePath)}, exitCode=${result.exitCode}`);
		return { valid: false, error: `ffprobe exit code ${result.exitCode}` };
	}

	const output = result.stdout.trim();
	log.debug(`validateVideo: output="${output}"`);

	if (output && !isNaN(parseFloat(output))) {
		log.debug(`validateVideo: valid, file=${path.basename(filePath)}, duration=${output}`);
		return { valid: true, error: null, duration: parseFloat(output) };
	}

	log.debug(`validateVideo: invalid (no duration), file=${path.basename(filePath)}, output="${output.substring(0, 50)}"`);
	return { valid: false, error: `ffprobe: no duration found (${output.substring(0, 50)})` };
}

async function validateVideoDeep(filePath, ffmpegBin) {
	log.debug(`validateVideoDeep: file=${filePath}, ffmpeg=${ffmpegBin}`);
	
	const escapedPath = escapePathForCmd(filePath);
	const escapedFfmpeg = escapePathForCmd(ffmpegBin);
	const cmd = `${escapedFfmpeg} -v error -i ${escapedPath} -f null -`;
	
	const timeout = getScaledTimeout(filePath, DEEP_DECODE_TIMEOUT);
	log.debug(`validateVideoDeep: running deep validation command, timeout=${timeout}ms`);

	const result = await execPromise(cmd, timeout);

	if (result.exitCode === 0) {
		log.debug(`validateVideoDeep: valid (deep), file=${path.basename(filePath)}`);
		return { valid: true, error: null };
	}

	if (result.timedOut) {
		log.debug(`validateVideoDeep: timed out (treating as inconclusive/valid), file=${path.basename(filePath)}`);
		return { valid: true, error: null, timedOut: true };
	}

	const { fatalErrors, nonFatalErrors } = classifyFFmpegErrors(result.stderr, result.stdout);

	if (fatalErrors.length === 0) {
		if (nonFatalErrors.length > 0) {
			log.debug(`validateVideoDeep: non-fatal errors only, treating as valid, file=${path.basename(filePath)}, nonFatal=${nonFatalErrors.length}`);
			return { valid: true, error: null };
		}
		log.debug(`validateVideoDeep: no classified errors but non-zero exit, treating as valid, file=${path.basename(filePath)}`);
		return { valid: true, error: null };
	}

	const errorMsg = fatalErrors.join("; ").substring(0, 200);
	log.debug(`validateVideoDeep: invalid (deep), file=${path.basename(filePath)}, error=${errorMsg}`);
	return { valid: false, error: `ffmpeg decode: ${errorMsg}` };
}

async function validateFile(filePath, type, ffmpegBin, ffprobeBin, deep = false) {
	log.debug(`validateFile: path=${filePath}, type=${type}, deep=${deep}`);
	
	if (!fs.existsSync(filePath)) {
		log.debug(`validateFile: file does not exist: ${filePath}`);
		return { valid: false, error: "File does not exist" };
	}

	try {
		const stats = fs.statSync(filePath);
		log.debug(`validateFile: file size=${stats.size} bytes`);
		
		if (stats.size === 0) {
			log.debug(`validateFile: file is empty: ${filePath}`);
			return { valid: false, error: "File is empty" };
		}
	} catch (err) {
		log.error(`validateFile: cannot stat file ${filePath}: ${err.message}`);
		return { valid: false, error: "Cannot stat file" };
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
					size: file.size
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