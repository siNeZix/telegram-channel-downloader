const fs = require("fs");

/**
 * Container-level structural probes (L3/L4 of the validation cascade).
 *
 * L3: `file-type` — detect the real container/codec family from content and
 *     compare against the declared extension (catches "wrong file" cases).
 * L4: `mp4box` — parse ISO BMFF (mp4/mov/m4a/m4v/3gp) box structure and confirm
 *     a `moov` atom is present and parseable. This is the cheapest reliable way
 *     to catch the single most common broken-video case ("moov atom not found")
 *     without spawning ffprobe/ffmpeg.
 *
 * Both layers degrade gracefully: if a library is unavailable or throws, the
 * probe returns "inconclusive" so a heavier layer decides. Nothing here ever
 * spawns a child process.
 *
 * Result shape matches the rest of the validators:
 *   { valid: true|false|null, status, error }
 */

const ISO_BMFF_EXTENSIONS = new Set(["mp4", "m4v", "m4a", "mov", "3gp", "3g2"]);

// Cache the dynamically-imported ESM `file-type` module (it is ESM-only and
// must be loaded via dynamic import from this CommonJS module).
let _fileTypePromise = null;
function loadFileType() {
	if (!_fileTypePromise) {
		_fileTypePromise = import("file-type").catch(() => null);
	}
	return _fileTypePromise;
}

let _mp4box = null;
let _mp4boxTried = false;
function loadMp4box() {
	if (!_mp4boxTried) {
		_mp4boxTried = true;
		try {
			_mp4box = require("mp4box");
		} catch {
			_mp4box = null;
		}
	}
	return _mp4box;
}

function ok(detectedType, extra = {}) {
	return { valid: true, status: "valid", error: null, detectedType: detectedType || null, ...extra };
}

function bad(error, detectedType, extra = {}) {
	return { valid: false, status: "invalid", error, detectedType: detectedType || null, ...extra };
}

function unknown(error, detectedType, extra = {}) {
	return { valid: null, status: "inconclusive", error: error || null, detectedType: detectedType || null, ...extra };
}

/**
 * Families that should agree between declared extension and detected type.
 * We only fail on a hard family mismatch (e.g. a "video" that is detected as a
 * text/zip), never on minor codec differences.
 */
function familyOf(ext) {
	const e = String(ext || "").toLowerCase();
	if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "ico"].includes(e)) return "image";
	if (["mp4", "m4v", "mov", "mkv", "webm", "avi", "flv", "wmv", "mpg", "mpeg", "3gp", "3g2"].includes(e))
		return "video";
	if (["mp3", "ogg", "oga", "opus", "flac", "wav", "aac", "m4a", "wma"].includes(e)) return "audio";
	return "unknown";
}

function familyOfMime(mime) {
	const m = String(mime || "").toLowerCase();
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	if (m.startsWith("audio/")) return "audio";
	// Common container ambiguities: mp4 audio (m4a) reports audio/* or video/*.
	if (m === "application/ogg") return "audio";
	return "unknown";
}

/**
 * L3 — detect content type and compare family vs declared extension.
 * @param {string} filePath
 * @param {string} extension - declared extension (no dot)
 * @returns {Promise<{valid:boolean|null,status:string,error:string|null,detectedType:string|null}>}
 */
async function probeFileType(filePath, extension) {
	const mod = await loadFileType();
	if (!mod || typeof mod.fileTypeFromFile !== "function") {
		return unknown("file-type unavailable");
	}

	let detected;
	try {
		detected = await mod.fileTypeFromFile(filePath);
	} catch (error) {
		return unknown(`file-type error: ${error.message}`);
	}

	if (!detected) {
		// Many valid files (e.g. some images/text-like) are not recognised.
		return unknown("file-type: type not recognised");
	}

	const declaredFamily = familyOf(extension);
	const detectedFamily = familyOfMime(detected.mime);

	if (declaredFamily !== "unknown" && detectedFamily !== "unknown" && declaredFamily !== detectedFamily) {
		// audio-in-mp4 (m4a) edge: video<->audio for ISO BMFF is acceptable.
		const isoBmffPair =
			(declaredFamily === "video" && detectedFamily === "audio") ||
			(declaredFamily === "audio" && detectedFamily === "video");
		if (!isoBmffPair) {
			return bad(
				`content/extension mismatch: declared '${extension}' (${declaredFamily}), detected ${detected.mime} (${detectedFamily})`,
				detected.mime,
			);
		}
	}

	return ok(detected.mime);
}

/**
 * L4 — parse ISO BMFF box structure with mp4box and confirm a moov atom.
 * Reads the file in chunks and feeds it to mp4box until it reports ready
 * (moov parsed) or errors. Bails out early as soon as moov is found.
 * @param {string} filePath
 * @param {number} size - file size in bytes
 * @returns {Promise<{valid:boolean|null,status:string,error:string|null}>}
 */
function probeIsoBmff(filePath, size) {
	const MP4Box = loadMp4box();
	if (!MP4Box || typeof MP4Box.createFile !== "function") {
		return Promise.resolve(unknown("mp4box unavailable"));
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			try {
				stream?.destroy();
			} catch {
				/* ignore */
			}
			resolve(result);
		};

		let mp4file;
		try {
			mp4file = MP4Box.createFile(false);
		} catch (error) {
			return resolve(unknown(`mp4box init error: ${error.message}`));
		}

		mp4file.onReady = (info) => {
			// moov parsed successfully → structurally valid container.
			const hasTracks = info && Array.isArray(info.tracks) && info.tracks.length > 0;
			finish(hasTracks ? ok("video/mp4", { tracks: info.tracks.length }) : ok("video/mp4"));
		};
		mp4file.onError = (err) => {
			finish(bad(`mp4box parse error: ${err}`, "video/mp4"));
		};

		let offset = 0;
		const CHUNK = 256 * 1024;
		const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK });

		stream.on("data", (chunk) => {
			if (settled) return;
			// mp4box needs an ArrayBuffer with a `fileStart` marker.
			const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
			ab.fileStart = offset;
			offset += chunk.byteLength;
			try {
				mp4file.appendBuffer(ab);
			} catch (error) {
				finish(bad(`mp4box append error: ${error.message}`, "video/mp4"));
			}
		});

		stream.on("end", () => {
			if (settled) return;
			try {
				mp4file.flush();
			} catch {
				/* ignore */
			}
			// Reached EOF without onReady firing → moov never parsed.
			finish(bad("mp4box: no parseable moov atom found", "video/mp4"));
		});

		stream.on("error", (error) => {
			finish(unknown(`mp4box read error: ${error.message}`));
		});

		// Safety: never let an mp4box parse run unbounded.
		setTimeout(() => finish(unknown("mp4box probe timed out")), 15000).unref();
	});
}

/**
 * Run the container-level cascade (L3 then, for ISO BMFF, L4).
 * Returns the first definitive (valid/invalid) result, else inconclusive.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {string} [options.extension] - declared extension (no dot)
 * @param {number} [options.size] - file size in bytes
 * @param {boolean} [options.useFileType=true]
 * @param {boolean} [options.useMp4box=true]
 * @returns {Promise<{valid:boolean|null,status:string,error:string|null,detectedType:string|null}>}
 */
async function probeContainer(filePath, options = {}) {
	const { extension = "", useFileType = true, useMp4box = true } = options;
	let size = Number.isFinite(options.size) ? options.size : null;
	if (size === null) {
		try {
			size = fs.statSync(filePath).size;
		} catch (error) {
			return unknown(`cannot stat file: ${error.message}`);
		}
	}

	if (useFileType) {
		const ftResult = await probeFileType(filePath, extension);
		if (ftResult.valid === false) {
			return ftResult; // hard mismatch — definitive
		}
	}

	const ext = String(extension || "")
		.toLowerCase()
		.replace(/^\./, "");
	if (useMp4box && ISO_BMFF_EXTENSIONS.has(ext)) {
		return probeIsoBmff(filePath, size);
	}

	return unknown("no definitive container result");
}

module.exports = {
	probeContainer,
	probeFileType,
	probeIsoBmff,
	ISO_BMFF_EXTENSIONS,
};
