const fs = require("fs");
const crypto = require("crypto");
const { Api } = require("telegram");
const bigInt = require("big-integer");
const { logMessage } = require("../utils/helper");
const { isFileReferenceExpired } = require("./FloodControl");

/**
 * L8 — exact integrity verification via Telegram's `upload.getFileHashes`.
 *
 * Telegram can return SHA256 hashes covering byte ranges of a stored file. We
 * walk the file by repeatedly calling getFileHashes (the server returns a window
 * of FileHash records; we advance `offset` to the end of the covered range and
 * ask again) and compare each returned hash against a locally computed SHA256 of
 * the same byte range.
 *
 * This is the most accurate integrity check available but costs at least one RPC
 * per file (often several) plus a full local read, so it is opt-in: used only
 * for the `--verify-hash` flag or to resolve an otherwise "inconclusive" verdict.
 *
 * Results use the shared validator shape: { valid: true|false|null, status, error }.
 */

const MAX_HASH_REQUESTS = 64; // safety cap on getFileHashes round-trips per file

function ok(extra = {}) {
	return { valid: true, status: "valid", error: null, profile: "verify-hash", ...extra };
}
function bad(error, extra = {}) {
	return { valid: false, status: "invalid", error, profile: "verify-hash", ...extra };
}
function unknown(error, extra = {}) {
	return { valid: null, status: "inconclusive", error: error || null, profile: "verify-hash", ...extra };
}

/**
 * Build the MTProto InputFileLocation for a message's media so getFileHashes can
 * address it. Returns null for media types that cannot be hash-verified.
 * @param {Object} message
 * @returns {Api.TypeInputFileLocation|null}
 */
function buildInputLocation(message) {
	const media = message?.media;
	if (!media) return null;

	const doc = media.document;
	if (doc) {
		return new Api.InputDocumentFileLocation({
			id: doc.id,
			accessHash: doc.accessHash,
			fileReference: doc.fileReference,
			thumbSize: "",
		});
	}

	const photo = media.photo;
	if (photo && Array.isArray(photo.sizes) && photo.sizes.length > 0) {
		// Largest available size (last entry); use its `type` as thumbSize.
		let chosen = null;
		for (let i = photo.sizes.length - 1; i >= 0; i--) {
			const t = photo.sizes[i]?.type;
			if (typeof t === "string" && t.length > 0) {
				chosen = t;
				break;
			}
		}
		if (!chosen) return null;
		return new Api.InputPhotoFileLocation({
			id: photo.id,
			accessHash: photo.accessHash,
			fileReference: photo.fileReference,
			thumbSize: chosen,
		});
	}

	return null;
}

/**
 * Read a byte range [offset, offset+limit) from a file into a Buffer.
 * @param {number} fd
 * @param {number} offset
 * @param {number} limit
 * @returns {Buffer}
 */
function readRange(fd, offset, limit) {
	const buf = Buffer.alloc(limit);
	const bytesRead = fs.readSync(fd, buf, 0, limit, offset);
	return bytesRead === limit ? buf : buf.subarray(0, bytesRead);
}

/**
 * Verify a downloaded file against Telegram's SHA256 file hashes.
 *
 * @param {Object} params
 * @param {Object} params.client - gramjs TelegramClient (must support invoke)
 * @param {Object} params.message - the source message (for InputFileLocation)
 * @param {string} params.filePath - local file to verify
 * @param {Object} [params.floodState] - FloodControl instance for RPC wrapping
 * @param {Function} [params.refetchMessage] - async () => message, to refresh an
 *        expired file_reference; called at most once on FILE_REFERENCE_EXPIRED
 * @returns {Promise<{valid:boolean|null,status:string,error:string|null,profile:string}>}
 */
async function verifyFileHashes(params) {
	const { client, filePath, floodState = null, refetchMessage = null } = params;
	let { message } = params;

	if (!client || typeof client.invoke !== "function") {
		return unknown("hash verify: telegram client unavailable");
	}

	let size;
	try {
		size = fs.statSync(filePath).size;
	} catch (error) {
		return bad(`hash verify: cannot stat file: ${error.message}`);
	}
	if (size === 0) {
		return bad("hash verify: file is empty");
	}

	let location = buildInputLocation(message);
	if (!location) {
		return unknown("hash verify: unsupported media type for hashing");
	}

	const invoke = async (request) => {
		if (floodState && typeof floodState.runWithFloodControl === "function") {
			return floodState.runWithFloodControl("getFileHashes", () => client.invoke(request));
		}
		return client.invoke(request);
	};

	let fd = null;
	let coveredEnd = 0;
	let refetched = false;
	let requests = 0;

	try {
		fd = fs.openSync(filePath, "r");

		while (coveredEnd < size && requests < MAX_HASH_REQUESTS) {
			requests++;
			let hashes;
			try {
				hashes = await invoke(
					new Api.upload.GetFileHashes({
						location,
						offset: bigInt(coveredEnd),
					}),
				);
			} catch (error) {
				if (isFileReferenceExpired(error) && !refetched && typeof refetchMessage === "function") {
					refetched = true;
					try {
						const fresh = await refetchMessage();
						if (fresh) {
							message = fresh;
							const newLocation = buildInputLocation(message);
							if (newLocation) {
								location = newLocation;
								requests--; // retry this window
								continue;
							}
						}
					} catch (refetchError) {
						return unknown(`hash verify: refetch failed: ${refetchError.message}`);
					}
					return unknown("hash verify: could not rebuild location after FILE_REFERENCE_EXPIRED");
				}
				return unknown(`hash verify: getFileHashes failed: ${error.message}`);
			}

			if (!Array.isArray(hashes) || hashes.length === 0) {
				// No more coverage available from the server.
				break;
			}

			let advanced = false;
			for (const fh of hashes) {
				const offset = typeof fh.offset?.toJSNumber === "function" ? fh.offset.toJSNumber() : Number(fh.offset);
				const limit = Number(fh.limit);
				const expected = Buffer.isBuffer(fh.hash) ? fh.hash : Buffer.from(fh.hash);

				if (!Number.isFinite(offset) || !Number.isFinite(limit) || limit <= 0) {
					continue;
				}
				if (offset >= size) {
					continue;
				}

				const chunk = readRange(fd, offset, Math.min(limit, size - offset));
				const actual = crypto.createHash("sha256").update(chunk).digest();

				if (!actual.equals(expected)) {
					return bad(`hash verify: SHA256 mismatch at offset ${offset} (len ${chunk.length})`, {
						offset,
						limit,
					});
				}

				const end = offset + limit;
				if (end > coveredEnd) {
					coveredEnd = end;
					advanced = true;
				}
			}

			if (!advanced) {
				// Server returned hashes but none advanced our cursor → stop to
				// avoid an infinite loop.
				break;
			}
		}
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best effort */
			}
		}
	}

	if (coveredEnd >= size) {
		logMessage.valid(`[VALID] Hash verify: full file matched (${size} bytes, ${requests} requests)`);
		return ok({ verifiedBytes: coveredEnd });
	}

	// Partial coverage: we matched everything the server told us about but it did
	// not cover the whole file. Treat as inconclusive rather than a false pass.
	return unknown(`hash verify: only ${coveredEnd}/${size} bytes covered by server hashes`, {
		verifiedBytes: coveredEnd,
	});
}

module.exports = {
	verifyFileHashes,
	buildInputLocation,
	MAX_HASH_REQUESTS,
};
