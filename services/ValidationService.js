const fs = require("fs");
const path = require("path");
const paths = require("../utils/paths");
const config = require("../utils/config");
const { logMessage } = require("../utils/helper");
const {
	validateFile,
	validateVideoDeep,
	validateVideo,
	validateImage,
	execPromise,
	classifyFFmpegErrors,
	getScaledTimeout,
	validResult,
	invalidResult,
	inconclusiveResult,
	SAMPLE_DECODE_TIMEOUT,
	TAIL_DECODE_TIMEOUT,
	VALIDATION_TIMEOUT,
	DEEP_DECODE_TIMEOUT,
} = require("../validators/ffmpeg_validator");
const { checkSignature } = require("../validators/signatures");
const { probeContainer } = require("../validators/container_probe");

const DEFAULT_VIDEO_PROFILE = "sampled";
const PARTIAL_SUFFIX = ".partial";
const SAMPLE_WINDOW_SECONDS = 8;
const MIN_SAMPLE_PASSES_FOR_VALID = 1;
const IS_WINDOWS = process.platform === "win32";
const QUARANTINE_RETRY_DELAY_MS = IS_WINDOWS ? 2500 : 1500;
const QUARANTINE_RETRY_ATTEMPTS = IS_WINDOWS ? 15 : 10;
const QUARANTINE_UNLINK_DELAY_MS = IS_WINDOWS ? 3000 : 2000;
const QUARANTINE_UNLINK_ATTEMPTS = IS_WINDOWS ? 8 : 5;

function getValidationProfile({ deepValidation = false, mediaType = "", explicitProfile = null } = {}) {
	if (explicitProfile) {
		return explicitProfile.trim().toLowerCase();
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

function getMediaFileType(mediaType) {
	const normalizedType = String(mediaType || "").toLowerCase();
	if (normalizedType.includes("video")) return "video";
	if (normalizedType.includes("audio")) return "audio";
	return "image";
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

async function validateVideoSampled(filePath, ffmpegBin, ffprobeBin, knownSize = null) {
	// Reuse a single probe (duration + streams) instead of a separate ffprobe.
	const probeResult = await validateProbeJson(filePath, ffprobeBin, "video", knownSize);
	if (!probeResult.valid) {
		if (probeResult.timedOut) {
			logMessage.valid(
				`[VALID] Sampled: ffprobe timed out, treating as inconclusive: ${path.basename(filePath)}`,
			);
			return inconclusiveResult("ffprobe validation timed out", { profile: "sampled" });
		}
		return probeResult;
	}

	const duration = probeResult.duration;
	if (!Number.isFinite(duration) || duration <= 0) {
		return invalidResult("ffprobe: invalid duration for sampled validation");
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

	let passedCount = 0;
	let unknownCount = 0;
	const failedPoints = [];

	const sampleTimeout = getScaledTimeout(filePath, SAMPLE_DECODE_TIMEOUT, knownSize);

	// Classify a single decode window's result.
	// Returns "pass" | "fatal" | "unknown" | "timeout".
	const classifyWindow = (result) => {
		if (result.exitCode === 0) return { kind: "pass" };
		if (result.timedOut) return { kind: "timeout" };
		const { fatalErrors, nonFatalErrors, unknownErrors } = classifyFFmpegErrors(result.stderr, result.stdout);
		if (fatalErrors.length > 0) {
			return { kind: "fatal", fatalErrors, nonFatalErrors };
		}
		if (unknownErrors.length > 0) {
			// Non-zero exit with only unclassified output: do NOT count as a pass.
			return { kind: "unknown", unknownErrors, nonFatalErrors };
		}
		// Non-zero exit but only non-fatal warnings → a genuine pass.
		return { kind: "pass", nonFatalErrors };
	};

	for (const point of samplePoints) {
		const sampleCmd = [
			ffmpegBin,
			"-v",
			"error",
			"-i",
			filePath,
			"-ss",
			point.toFixed(3),
			"-t",
			String(SAMPLE_WINDOW_SECONDS),
			"-f",
			"null",
			"-",
		];
		const result = await execPromise(sampleCmd, sampleTimeout);
		const verdict = classifyWindow(result);

		if (verdict.kind === "timeout") {
			logMessage.valid(
				`[VALID] Sampled: timeout at ${point.toFixed(1)}s (inconclusive): ${path.basename(filePath)}`,
			);
			return inconclusiveResult(`ffmpeg sampled decode timed out at ${point.toFixed(1)}s`, { timedOut: true });
		}
		if (verdict.kind === "pass") {
			passedCount++;
			continue;
		}
		if (verdict.kind === "unknown") {
			unknownCount++;
			logMessage.valid(
				`[VALID] Sampled: unknown errors at ${point.toFixed(1)}s (not counted as pass): ${path.basename(filePath)}`,
			);
			continue;
		}
		failedPoints.push({ point, fatalErrors: verdict.fatalErrors, nonFatalErrors: verdict.nonFatalErrors });
	}

	const needTail = duration >= 15;
	if (needTail) {
		const tailWindow = Math.min(12, Math.max(6, Math.floor(duration * 0.15)));
		const tailCmd = [
			ffmpegBin,
			"-v",
			"error",
			"-sseof",
			String(-tailWindow),
			"-i",
			filePath,
			"-t",
			String(tailWindow),
			"-f",
			"null",
			"-",
		];
		const tailTimeout = getScaledTimeout(filePath, TAIL_DECODE_TIMEOUT, knownSize);
		const tailResult = await execPromise(tailCmd, tailTimeout);
		const verdict = classifyWindow(tailResult);

		if (verdict.kind === "timeout") {
			logMessage.valid(`[VALID] Sampled: tail timeout (inconclusive): ${path.basename(filePath)}`);
			return inconclusiveResult("ffmpeg sampled tail decode timed out", { timedOut: true });
		} else if (verdict.kind === "pass") {
			passedCount++;
		} else if (verdict.kind === "unknown") {
			unknownCount++;
		} else {
			failedPoints.push({
				point: `tail-${tailWindow}s`,
				fatalErrors: verdict.fatalErrors,
				nonFatalErrors: verdict.nonFatalErrors,
			});
		}
	}

	const totalAttempts = samplePoints.length + (needTail ? 1 : 0);

	if (failedPoints.length === 0 && passedCount >= MIN_SAMPLE_PASSES_FOR_VALID) {
		return validResult();
	}

	// No fatal failures, but we never got a clean pass (only unknown windows):
	// inconclusive rather than a false pass.
	if (failedPoints.length === 0 && passedCount === 0 && unknownCount > 0) {
		logMessage.valid(
			`[VALID] Sampled: ${unknownCount}/${totalAttempts} unknown, 0 clean passes (inconclusive): ${path.basename(filePath)}`,
		);
		return inconclusiveResult(
			`ffmpeg sampled decode inconclusive: ${unknownCount}/${totalAttempts} windows had unclassified output`,
		);
	}

	if (passedCount >= MIN_SAMPLE_PASSES_FOR_VALID && failedPoints.length > 0) {
		const summary = failedPoints
			.map((f) => `${f.point.toFixed ? f.point.toFixed(1) : f.point}s: ${f.fatalErrors.slice(0, 2).join("; ")}`)
			.join(" | ");
		logMessage.valid(
			`[VALID] Sampled: ${passedCount}/${totalAttempts} passed, accepted with warnings: ${path.basename(filePath)} (${summary})`,
		);
		return validResult();
	}

	const allFatal = failedPoints
		.flatMap((f) => f.fatalErrors)
		.join("; ")
		.substring(0, 200);
	logMessage.valid(
		`[VALID] Sampled: ${passedCount}/${totalAttempts} passed, rejected: ${path.basename(filePath)} (fatal: ${allFatal})`,
	);
	return invalidResult(`ffmpeg sampled decode: ${passedCount}/${totalAttempts} passed; fatal: ${allFatal}`);
}

function validateExpectedSize(filePath, expectedSize, mediaType, knownSize = null) {
	if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
		return validResult();
	}

	const normalizedType = String(mediaType || "").toLowerCase();
	const isImage = normalizedType.includes("image") || normalizedType.includes("photo");
	if (isImage) {
		return validResult();
	}

	const actualSize = Number.isFinite(knownSize) ? knownSize : fs.statSync(filePath).size;
	if (actualSize !== expectedSize) {
		return {
			...invalidResult(`size mismatch: expected ${expectedSize} bytes, got ${actualSize}`),
			actualSize,
			expectedSize,
		};
	}

	return validResult({ actualSize, expectedSize });
}

async function validateProbeJson(filePath, ffprobeBin, fileType, knownSize = null) {
	const cmd = [
		ffprobeBin,
		"-v",
		"error",
		"-show_entries",
		"format=duration,size:stream=codec_type,codec_name",
		"-of",
		"json",
		filePath,
	];
	const result = await execPromise(cmd, getScaledTimeout(filePath, VALIDATION_TIMEOUT, knownSize));

	if (result.timedOut) {
		return inconclusiveResult("ffprobe strict validation timed out", { timedOut: true });
	}

	if (result.exitCode !== 0) {
		const { fatalErrors, nonFatalErrors, unknownErrors } = classifyFFmpegErrors(result.stderr, result.stdout);
		if (fatalErrors.length > 0) {
			return invalidResult(`ffprobe strict: ${fatalErrors.join("; ").substring(0, 200)}`, {
				fatalErrors,
				nonFatalErrors,
				unknownErrors,
			});
		}
		return inconclusiveResult(`ffprobe strict exit code ${result.exitCode}`, { nonFatalErrors, unknownErrors });
	}

	let probe;
	try {
		probe = JSON.parse(result.stdout || "{}");
	} catch (error) {
		return inconclusiveResult(`ffprobe strict returned invalid JSON: ${error.message}`);
	}

	const streams = Array.isArray(probe.streams) ? probe.streams : [];
	if (fileType === "video" && !streams.some((stream) => stream.codec_type === "video")) {
		return invalidResult("ffprobe strict: no video stream found");
	}
	if (fileType === "audio" && !streams.some((stream) => stream.codec_type === "audio")) {
		return invalidResult("ffprobe strict: no audio stream found");
	}

	const duration = Number.parseFloat(probe.format?.duration);
	if ((fileType === "video" || fileType === "audio") && (!Number.isFinite(duration) || duration <= 0)) {
		return invalidResult("ffprobe strict: invalid duration");
	}

	return validResult({ duration, streams });
}

async function validateStrictDecode(filePath, ffmpegBin, fileType, knownSize = null) {
	const mapArgs = fileType === "audio" ? ["-map", "0:a"] : fileType === "video" ? ["-map", "0:v?"] : [];
	const cmd = [ffmpegBin, "-v", "error", "-xerror", "-i", filePath, ...mapArgs, "-f", "null", "-"];
	const result = await execPromise(cmd, getScaledTimeout(filePath, DEEP_DECODE_TIMEOUT, knownSize));

	if (result.exitCode === 0) {
		return validResult();
	}

	if (result.timedOut) {
		return inconclusiveResult("ffmpeg strict decode timed out", { timedOut: true });
	}

	const { fatalErrors, nonFatalErrors, unknownErrors } = classifyFFmpegErrors(result.stderr, result.stdout);
	if (fatalErrors.length > 0) {
		return invalidResult(`ffmpeg strict decode: ${fatalErrors.join("; ").substring(0, 200)}`, {
			fatalErrors,
			nonFatalErrors,
			unknownErrors,
		});
	}

	if (nonFatalErrors.length > 0 && unknownErrors.length === 0) {
		return validResult({ nonFatalErrors });
	}

	const unknownMsg = unknownErrors.join("; ").substring(0, 200) || `ffmpeg strict exit code ${result.exitCode}`;
	return inconclusiveResult(`ffmpeg strict decode inconclusive: ${unknownMsg}`, { nonFatalErrors, unknownErrors });
}

async function validateMediaStrict(filePath, ffmpegBin, ffprobeBin, fileType, knownSize = null) {
	if (fileType === "image") {
		const result = await validateStrictDecode(filePath, ffmpegBin, fileType, knownSize);
		return { ...result, profile: "strict" };
	}

	const probeResult = await validateProbeJson(filePath, ffprobeBin, fileType, knownSize);
	if (!probeResult.valid) {
		return { ...probeResult, profile: "strict" };
	}

	const decodeResult = await validateStrictDecode(filePath, ffmpegBin, fileType, knownSize);
	return {
		...decodeResult,
		profile: "strict",
		duration: probeResult.duration,
		streams: probeResult.streams,
	};
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

	/**
	 * Validate a media file using a cheap-first cascade:
	 *   L0 size match -> L1/L2 magic bytes + trailer -> L3/L4 container probe
	 *   -> Ln ffmpeg/ffprobe (only when the profile requires a decode or the
	 *   cheap layers were inconclusive).
	 *
	 * @param {string} filePath
	 * @param {string} mediaType
	 * @param {Object} [options]
	 * @param {boolean} [options.deepValidation]
	 * @param {string} [options.profile] - explicit profile override
	 * @param {number} [options.expectedSize]
	 * @returns {Promise<Object>} validation result with { profile, fileType, ... }
	 */
	async validateMediaFile(filePath, mediaType, options = {}) {
		if (!this.ffmpegPaths) {
			return validResult({ profile: "none", action: "skip" });
		}

		let stat;
		try {
			stat = fs.statSync(filePath);
		} catch {
			return invalidResult("File does not exist", { profile: "none" });
		}
		const size = stat.size;
		if (size === 0) {
			return invalidResult("File is empty", { profile: "none" });
		}

		// L0 — size match (cheapest; catches truncated downloads instantly).
		const sizeCheck = validateExpectedSize(filePath, options.expectedSize, mediaType, size);
		if (!sizeCheck.valid) {
			return { ...sizeCheck, profile: "size-check" };
		}

		const fileType = getMediaFileType(mediaType);
		const profile = getValidationProfile({
			deepValidation: options.deepValidation,
			mediaType,
			explicitProfile: options.profile,
		});

		if (profile === "none") {
			return validResult({ profile: "none", action: "skip", fileType });
		}

		const extension = path.extname(filePath).slice(1).toLowerCase();

		logMessage.valid(`[VALID] Validation profile=${profile} file=${path.basename(filePath)} type=${fileType}`);

		// L1/L2 — magic bytes + trailer. A definitive "invalid" short-circuits.
		const sig = checkSignature(filePath, { size, extension });
		if (sig.valid === false) {
			return { ...invalidResult(sig.error), profile: "signature", fileType, detectedType: sig.detectedType };
		}

		// L3/L4 — container probe (file-type family + ISO BMFF moov). Definitive
		// "invalid" short-circuits; "valid" is only trusted to skip decode in the
		// fast profile (heavier profiles still want a real decode).
		const containerResult = await probeContainer(filePath, { extension, size });
		if (containerResult.valid === false) {
			return {
				...invalidResult(containerResult.error),
				profile: "container",
				fileType,
				detectedType: containerResult.detectedType,
			};
		}

		// Fast profile: no decode. If the cheap layers confirmed structure, accept;
		// otherwise return their (possibly inconclusive) verdict, falling back to a
		// lightweight ffprobe metadata check for A/V containers.
		if (profile === "fast") {
			if (fileType === "image") {
				// Images: signature/container already cover structure. If a checker
				// confirmed it, accept; if inconclusive, do a single ffmpeg image
				// decode as a cheap fallback.
				if (sig.valid === true || containerResult.valid === true) {
					return { ...validResult(), profile: "fast", fileType };
				}
				const result = await validateImage(filePath, this.ffmpegPaths.ffmpeg, size);
				return { ...result, profile: "fast", fileType };
			}
			// A/V: a quick ffprobe metadata check (duration/streams) is the fast tier.
			const result = await validateProbeJson(filePath, this.ffmpegPaths.ffprobe, fileType, size);
			return { ...result, profile: "fast", fileType };
		}

		// Decode tiers below.
		if (fileType === "image") {
			const result =
				profile === "strict"
					? await validateMediaStrict(
							filePath,
							this.ffmpegPaths.ffmpeg,
							this.ffmpegPaths.ffprobe,
							fileType,
							size,
						)
					: await validateImage(filePath, this.ffmpegPaths.ffmpeg, size);
			return { ...result, profile, fileType };
		}

		if (profile === "strict") {
			const result = await validateMediaStrict(
				filePath,
				this.ffmpegPaths.ffmpeg,
				this.ffmpegPaths.ffprobe,
				fileType,
				size,
			);
			return { ...result, profile, fileType };
		}

		if (profile === "full") {
			const result =
				fileType === "audio"
					? await validateStrictDecode(filePath, this.ffmpegPaths.ffmpeg, fileType, size)
					: await validateVideoDeep(filePath, this.ffmpegPaths.ffmpeg, size);
			return { ...result, profile, fileType };
		}

		if (profile === "sampled") {
			const result =
				fileType === "audio"
					? await validateVideo(filePath, this.ffmpegPaths.ffprobe, size)
					: await validateVideoSampled(filePath, this.ffmpegPaths.ffmpeg, this.ffmpegPaths.ffprobe, size);
			return { ...result, profile, fileType };
		}

		const result = await validateFile(filePath, fileType, this.ffmpegPaths.ffmpeg, this.ffmpegPaths.ffprobe, false);
		return { ...result, profile, fileType };
	}

	async quarantineFile(filePath, reason, metadata = {}) {
		if (!this.channelId || !fs.existsSync(filePath)) {
			return null;
		}

		const target = getQuarantineTarget(this.channelId, filePath, this.outputFolder);
		paths.ensureDir(target.root);

		const payload = {
			reason,
			originalPath: filePath,
			quarantinedAt: new Date().toISOString(),
			metadata,
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

				logMessage.warn(
					`[VALID] Quarantine retry ${attempt}/${QUARANTINE_RETRY_ATTEMPTS} for ${path.basename(filePath)}: ${error.code}`,
				);
				await sleep(QUARANTINE_RETRY_DELAY_MS);
			}
		}

		if (lastError) {
			// Rename failed (often a Windows file lock). Fall back to copy+delete,
			// but guarantee no duplicate is left behind: if the original cannot be
			// removed after copying, we delete the quarantine copy and report
			// failure, leaving exactly one (live) copy on disk.
			let copied = false;
			try {
				fs.copyFileSync(filePath, target.filePath);
				copied = true;

				let unlinked = false;
				for (let attempt = 1; attempt <= QUARANTINE_UNLINK_ATTEMPTS; attempt++) {
					try {
						fs.unlinkSync(filePath);
						unlinked = true;
						break;
					} catch (unlinkError) {
						lastError = unlinkError;
						if (attempt === QUARANTINE_UNLINK_ATTEMPTS) {
							break;
						}
						await sleep(QUARANTINE_UNLINK_DELAY_MS);
					}
				}

				if (unlinked) {
					lastError = null;
				}
			} catch (copyError) {
				lastError = copyError;
			}

			// If we ended up failing (copy failed, or original still present),
			// remove the quarantine copy so we never duplicate the file.
			if (lastError && copied && fs.existsSync(target.filePath) && fs.existsSync(filePath)) {
				try {
					fs.unlinkSync(target.filePath);
				} catch {
					// best effort cleanup
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
