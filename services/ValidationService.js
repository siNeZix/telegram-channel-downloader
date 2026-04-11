const fs = require("fs");
const path = require("path");
const paths = require("../utils/paths");
const config = require("../utils/config");
const { logMessage } = require("../utils/helper");
const { validateFile, validateVideoDeep, validateVideo, validateImage, execPromise, escapePathForCmd } = require("../validators/ffmpeg_validator");

const DEFAULT_VIDEO_PROFILE = "sampled";
const PARTIAL_SUFFIX = ".partial";
const SAMPLE_WINDOW_SECONDS = 8;
const QUARANTINE_RETRY_DELAY_MS = 1500;
const QUARANTINE_RETRY_ATTEMPTS = 10;
const QUARANTINE_UNLINK_DELAY_MS = 2000;
const QUARANTINE_UNLINK_ATTEMPTS = 5;

function getValidationProfile({ deepValidation = false, mediaType = "", explicitProfile = null } = {}) {
	if (explicitProfile) {
		return explicitProfile;
	}

	if (deepValidation) {
		return "full";
	}

	const configured = config.get("download.validationProfile", DEFAULT_VIDEO_PROFILE);
	if (typeof configured === "string" && configured.trim()) {
		return configured.trim().toLowerCase();
	}

	if (!String(mediaType).toLowerCase().includes("video")) {
		return "fast";
	}

	return DEFAULT_VIDEO_PROFILE;
}

function getQuarantineTarget(channelId, filePath, outputFolder = null) {
	const quarantineRoot = outputFolder
		? path.join(outputFolder, paths.quarantine)
		: paths.getQuarantinePath(channelId);
	const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
	const basename = path.basename(filePath);
	return {
		root: quarantineRoot,
		filePath: path.join(quarantineRoot, `${timestamp}_${basename}`),
		metaPath: path.join(quarantineRoot, `${timestamp}_${basename}.json`),
	};
}

async function validateVideoSampled(filePath, ffmpegBin, ffprobeBin) {
	const probeResult = await validateVideo(filePath, ffprobeBin);
	if (!probeResult.valid) {
		return probeResult;
	}

	const escapedPath = escapePathForCmd(filePath);
	const escapedFfmpeg = escapePathForCmd(ffmpegBin);
	const escapedFfprobe = escapePathForCmd(ffprobeBin);
	const durationCmd = `${escapedFfprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${escapedPath}`;
	const durationResult = await execPromise(durationCmd, 30000);
	const duration = parseFloat(durationResult.stdout.trim());

	if (!Number.isFinite(duration) || duration <= 0) {
		return { valid: false, error: "ffprobe: invalid duration for sampled validation" };
	}

	const samplePoints = [0];
	if (duration >= 12) {
		samplePoints.push(Math.max(0, duration * 0.33));
	}
	if (duration >= 18) {
		samplePoints.push(Math.max(0, duration * 0.66));
	}
	if (duration >= 20) {
		samplePoints.push(Math.max(0, duration - Math.min(12, duration * 0.15)));
	}

	for (const point of samplePoints) {
		const sampleCmd = `${escapedFfmpeg} -v error -xerror -err_detect explode -i ${escapedPath} -ss ${point.toFixed(3)} -t ${SAMPLE_WINDOW_SECONDS} -f null -`;
		const result = await execPromise(sampleCmd, 45000);
		if (result.exitCode !== 0) {
			const errorMsg = result.stderr || result.stdout || `sample decode failed at ${point.toFixed(3)}s`;
			return { valid: false, error: `ffmpeg sampled decode: ${errorMsg.substring(0, 160)}` };
		}
	}

	if (duration >= 15) {
		const tailWindow = Math.min(12, Math.max(6, Math.floor(duration * 0.15)));
		const tailCmd = `${escapedFfmpeg} -v error -xerror -err_detect explode -sseof -${tailWindow} -i ${escapedPath} -t ${tailWindow} -f null -`;
		const tailResult = await execPromise(tailCmd, 45000);
		if (tailResult.exitCode !== 0) {
			const errorMsg = tailResult.stderr || tailResult.stdout || "tail decode failed";
			return { valid: false, error: `ffmpeg tail decode: ${errorMsg.substring(0, 160)}` };
		}
	}

	return { valid: true, error: null };
}

function validateExpectedSize(filePath, expectedSize) {
	if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
		return { valid: true, error: null };
	}

	const actualSize = fs.statSync(filePath).size;
	if (actualSize !== expectedSize) {
		return {
			valid: false,
			error: `size mismatch: expected ${expectedSize} bytes, got ${actualSize}`,
		};
	}

	return { valid: true, error: null };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableFileLockError(error) {
	return ["EBUSY", "EPERM", "EACCES"].includes(error?.code);
}

class ValidationService {
	constructor(options = {}) {
		this.channelId = options.channelId || null;
		this.outputFolder = options.outputFolder || null;
		this.ffmpegPaths = options.ffmpegPaths || null;
	}

	getPartialPath(finalPath) {
		return `${finalPath}${PARTIAL_SUFFIX}`;
	}

	async validateMediaFile(filePath, mediaType, options = {}) {
		if (!this.ffmpegPaths) {
			return { valid: true, error: null, profile: "none", action: "skip" };
		}

		if (!fs.existsSync(filePath)) {
			return { valid: false, error: "File does not exist", profile: "none" };
		}

		const sizeCheck = validateExpectedSize(filePath, options.expectedSize);
		if (!sizeCheck.valid) {
			return { ...sizeCheck, profile: "size-check" };
		}

		const normalizedType = String(mediaType || "").toLowerCase();
		const fileType = normalizedType.includes("video") ? "video" : "image";
		const profile = getValidationProfile({
			deepValidation: options.deepValidation,
			mediaType,
			explicitProfile: options.profile,
		});

		logMessage.valid(`[VALID] Validation profile=${profile} file=${path.basename(filePath)} type=${fileType}`);

		if (fileType === "image") {
			const result = await validateImage(filePath, this.ffmpegPaths.ffmpeg);
			return { ...result, profile, fileType };
		}

		if (profile === "full") {
			const result = await validateVideoDeep(filePath, this.ffmpegPaths.ffmpeg);
			return { ...result, profile, fileType };
		}

		if (profile === "sampled") {
			const result = await validateVideoSampled(filePath, this.ffmpegPaths.ffmpeg, this.ffmpegPaths.ffprobe);
			return { ...result, profile, fileType };
		}

		const result = await validateFile(filePath, fileType, this.ffmpegPaths.ffmpeg, this.ffmpegPaths.ffprobe, false);
		return { ...result, profile, fileType };
	}

	async quarantineFile(filePath, reason, metadata = {}) {
		if (!this.channelId || !fs.existsSync(filePath)) {
			return null;
		}

		await sleep(QUARANTINE_RETRY_DELAY_MS);

		const target = getQuarantineTarget(this.channelId, filePath, this.outputFolder);
		paths.ensureDir(target.root);

		const payload = {
			reason,
			originalPath: filePath,
			quarantinedAt: new Date().toISOString(),
			...metadata,
		};

		let lastError = null;
		for (let attempt = 1; attempt <= QUARANTINE_RETRY_ATTEMPTS; attempt++) {
			try {
				fs.renameSync(filePath, target.filePath);
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
				if (!isRetriableFileLockError(error) || attempt === QUARANTINE_RETRY_ATTEMPTS) {
					break;
				}

				logMessage.warn(`[VALID] Quarantine retry ${attempt}/${QUARANTINE_RETRY_ATTEMPTS} for ${path.basename(filePath)}: ${error.code}`);
				await sleep(QUARANTINE_RETRY_DELAY_MS);
			}
		}

		if (lastError) {
			try {
				fs.copyFileSync(filePath, target.filePath);
				lastError = null;
				for (let attempt = 1; attempt <= QUARANTINE_UNLINK_ATTEMPTS; attempt++) {
					try {
						fs.unlinkSync(filePath);
						break;
					} catch (unlinkError) {
						if (attempt === QUARANTINE_UNLINK_ATTEMPTS) {
							throw unlinkError;
						}
						await sleep(QUARANTINE_UNLINK_DELAY_MS);
					}
				}
			} catch (copyError) {
				lastError = copyError;
				if (fs.existsSync(target.filePath)) {
					try { fs.unlinkSync(target.filePath); } catch (e) {}
				}
			}
		}

		if (lastError) {
			logMessage.error(`[VALID] Failed to quarantine file ${filePath}: ${lastError.message}`);
			return { ok: false, error: lastError.message, code: lastError.code || null, target };
		}

		fs.writeFileSync(target.metaPath, JSON.stringify(payload, null, 2), "utf8");
		logMessage.warn(`[VALID] File moved to quarantine: ${target.filePath}`);
		return { ok: true, target };
	}

	finalizeValidatedDownload(partialPath, finalPath) {
		if (!fs.existsSync(partialPath)) {
			throw new Error(`Partial download not found: ${partialPath}`);
		}

		const finalDir = path.dirname(finalPath);
		paths.ensureDir(finalDir);

		if (fs.existsSync(finalPath)) {
			fs.unlinkSync(finalPath);
		}

		fs.renameSync(partialPath, finalPath);
		return fs.statSync(finalPath).size;
	}
}

module.exports = {
	ValidationService,
	getValidationProfile,
	PARTIAL_SUFFIX,
};
