const fs = require("fs");

/**
 * Cheap structural validation via file magic bytes (header) and trailer markers.
 *
 * This is the L1/L2 layer of the validation cascade: it reads only the first and
 * last few bytes of a file (no full read, no decode, no child process) and can
 * cheaply prove that a file is either structurally sound for its declared type
 * or definitively garbage (wrong/empty/truncated). When it can neither confirm
 * nor reject, it returns "inconclusive" so a heavier layer (ffprobe/ffmpeg) can
 * decide.
 *
 * Results use the same shape as ffmpeg_validator:
 *   { valid: true|false|null, status, error }
 */

const HEADER_BYTES = 32;
const TRAILER_BYTES = 32;

/**
 * @typedef {Object} SignatureResult
 * @property {boolean|null} valid
 * @property {string} status - "valid" | "invalid" | "inconclusive"
 * @property {string|null} error
 * @property {string} [detectedType]
 */

function ok(detectedType) {
	return { valid: true, status: "valid", error: null, detectedType: detectedType || null };
}

function bad(error, detectedType) {
	return { valid: false, status: "invalid", error, detectedType: detectedType || null };
}

function unknown(error, detectedType) {
	return { valid: null, status: "inconclusive", error: error || null, detectedType: detectedType || null };
}

/**
 * Read the first `headerBytes` and last `trailerBytes` of a file in a single
 * open handle. Returns null on any IO error (caller treats as inconclusive).
 * @param {string} filePath
 * @param {number} size - known file size in bytes
 * @param {number} [headerBytes]
 * @param {number} [trailerBytes]
 * @returns {{ header: Buffer, trailer: Buffer }|null}
 */
function readEnds(filePath, size, headerBytes = HEADER_BYTES, trailerBytes = TRAILER_BYTES) {
	let fd = null;
	try {
		fd = fs.openSync(filePath, "r");
		const headLen = Math.min(headerBytes, size);
		const header = Buffer.alloc(headLen);
		if (headLen > 0) {
			fs.readSync(fd, header, 0, headLen, 0);
		}

		const tailLen = Math.min(trailerBytes, size);
		const trailer = Buffer.alloc(tailLen);
		if (tailLen > 0) {
			fs.readSync(fd, trailer, 0, tailLen, Math.max(0, size - tailLen));
		}
		return { header, trailer };
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best effort */
			}
		}
	}
}

function startsWith(buf, bytes) {
	if (buf.length < bytes.length) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (buf[i] !== bytes[i]) return false;
	}
	return true;
}

function endsWith(buf, bytes) {
	if (buf.length < bytes.length) return false;
	const offset = buf.length - bytes.length;
	for (let i = 0; i < bytes.length; i++) {
		if (buf[offset + i] !== bytes[i]) return false;
	}
	return true;
}

function bytesAt(buf, offset, bytes) {
	if (buf.length < offset + bytes.length) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (buf[offset + i] !== bytes[i]) return false;
	}
	return true;
}

// --- Per-format checkers. Each returns a SignatureResult. ---

function checkJpeg(header, trailer) {
	// SOI marker FF D8 FF
	if (!startsWith(header, [0xff, 0xd8, 0xff])) {
		return bad("jpeg: missing SOI marker (FFD8FF)", "image/jpeg");
	}
	// EOI marker FF D9 at end (some files have trailing padding, so check last bytes)
	if (!endsWith(trailer, [0xff, 0xd9])) {
		// Trailing metadata/padding can hide EOI; treat as inconclusive, not invalid.
		return unknown("jpeg: EOI marker (FFD9) not at file end", "image/jpeg");
	}
	return ok("image/jpeg");
}

function checkPng(header, trailer) {
	if (!startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return bad("png: bad signature", "image/png");
	}
	// IEND chunk: 49 45 4E 44 AE 42 60 82 at the very end
	if (!endsWith(trailer, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])) {
		return bad("png: missing IEND chunk (truncated)", "image/png");
	}
	return ok("image/png");
}

function checkGif(header) {
	if (
		startsWith(header, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
		startsWith(header, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
	) {
		return ok("image/gif");
	}
	return bad("gif: bad signature (GIF87a/GIF89a)", "image/gif");
}

function checkWebp(header) {
	// RIFF....WEBP
	if (startsWith(header, [0x52, 0x49, 0x46, 0x46]) && bytesAt(header, 8, [0x57, 0x45, 0x42, 0x50])) {
		return ok("image/webp");
	}
	return bad("webp: bad RIFF/WEBP signature", "image/webp");
}

function checkBmp(header) {
	if (startsWith(header, [0x42, 0x4d])) {
		return ok("image/bmp");
	}
	return bad("bmp: bad signature (BM)", "image/bmp");
}

function checkTiff(header) {
	if (startsWith(header, [0x49, 0x49, 0x2a, 0x00]) || startsWith(header, [0x4d, 0x4d, 0x00, 0x2a])) {
		return ok("image/tiff");
	}
	return bad("tiff: bad byte-order signature", "image/tiff");
}

function checkIco(header) {
	if (startsWith(header, [0x00, 0x00, 0x01, 0x00])) {
		return ok("image/x-icon");
	}
	return bad("ico: bad signature", "image/x-icon");
}

function checkMp4(header) {
	// ISO BMFF: bytes 4..8 == "ftyp"
	if (bytesAt(header, 4, [0x66, 0x74, 0x79, 0x70])) {
		return ok("video/mp4");
	}
	return bad("mp4: missing ftyp box at offset 4", "video/mp4");
}

function checkMatroska(header) {
	// EBML header 1A 45 DF A3 (mkv/webm)
	if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) {
		return ok("video/x-matroska");
	}
	return bad("matroska: missing EBML header", "video/x-matroska");
}

function checkOgg(header) {
	if (startsWith(header, [0x4f, 0x67, 0x67, 0x53])) {
		return ok("audio/ogg");
	}
	return bad("ogg: missing OggS signature", "audio/ogg");
}

function checkFlac(header) {
	if (startsWith(header, [0x66, 0x4c, 0x61, 0x43])) {
		return ok("audio/flac");
	}
	return bad("flac: missing fLaC signature", "audio/flac");
}

function checkWav(header) {
	if (startsWith(header, [0x52, 0x49, 0x46, 0x46]) && bytesAt(header, 8, [0x57, 0x41, 0x56, 0x45])) {
		return ok("audio/wav");
	}
	return bad("wav: bad RIFF/WAVE signature", "audio/wav");
}

function checkMp3(header) {
	// ID3 tag or MPEG frame sync (FF Ex/Fx)
	if (startsWith(header, [0x49, 0x44, 0x33])) {
		return ok("audio/mpeg");
	}
	if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) {
		return ok("audio/mpeg");
	}
	return unknown("mp3: no ID3 tag or frame sync in header", "audio/mpeg");
}

/**
 * Map a file extension (no dot, lowercase) to its checker.
 */
const CHECKERS_BY_EXT = {
	jpg: checkJpeg,
	jpeg: checkJpeg,
	jpe: checkJpeg,
	png: checkPng,
	gif: checkGif,
	webp: checkWebp,
	bmp: checkBmp,
	tif: checkTiff,
	tiff: checkTiff,
	ico: checkIco,
	mp4: checkMp4,
	m4v: checkMp4,
	mov: checkMp4,
	"3gp": checkMp4,
	m4a: checkMp4,
	mkv: checkMatroska,
	webm: checkMatroska,
	ogg: checkOgg,
	oga: checkOgg,
	opus: checkOgg,
	flac: checkFlac,
	wav: checkWav,
	mp3: checkMp3,
};

/**
 * Validate a file's structural signature based on its extension.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {number} [options.size] - known file size (bytes); statSync used if omitted
 * @param {string} [options.extension] - extension without dot (lowercase)
 * @returns {SignatureResult}
 */
function checkSignature(filePath, options = {}) {
	let size = Number.isFinite(options.size) ? options.size : null;
	if (size === null) {
		try {
			size = fs.statSync(filePath).size;
		} catch (error) {
			return bad(`cannot stat file: ${error.message}`);
		}
	}

	if (size === 0) {
		return bad("file is empty");
	}

	let ext = options.extension;
	if (!ext) {
		const idx = filePath.lastIndexOf(".");
		ext = idx >= 0 ? filePath.slice(idx + 1).toLowerCase() : "";
	} else {
		ext = String(ext).toLowerCase().replace(/^\./, "");
	}

	const checker = CHECKERS_BY_EXT[ext];
	if (!checker) {
		return unknown(`no signature checker for extension '${ext}'`);
	}

	const ends = readEnds(filePath, size);
	if (!ends) {
		return unknown("could not read file ends");
	}

	return checker(ends.header, ends.trailer);
}

module.exports = {
	checkSignature,
	HEADER_BYTES,
	TRAILER_BYTES,
	// exported for tests
	startsWith,
	endsWith,
	bytesAt,
};
