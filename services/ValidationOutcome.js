const config = require("../utils/config");

/**
 * Single source of truth for interpreting a validateMediaFile() result and
 * applying its consequences. Both the download path (DownloadManager) and the
 * standalone validator (validators/index.js) route through here so that the
 * verdict — and crucially the treatment of "inconclusive" — is identical.
 *
 * Verdicts:
 *   "verified"     - result.valid === true
 *   "inconclusive" - result.valid === null / status "inconclusive" (KEPT)
 *   "invalid"      - result.valid === false (quarantine/requeue)
 *   "skipped"      - validation disabled (profile "none" / action "skip")
 */

const OUTCOME = Object.freeze({
	VERIFIED: "verified",
	INCONCLUSIVE: "inconclusive",
	INVALID: "invalid",
	SKIPPED: "skipped",
});

/**
 * Classify a raw validation result into a stable verdict, without side effects.
 * @param {Object} result - return value of ValidationService.validateMediaFile
 * @returns {"verified"|"inconclusive"|"invalid"|"skipped"}
 */
function classifyOutcome(result) {
	if (!result) {
		return OUTCOME.INCONCLUSIVE;
	}
	if (result.action === "skip" || result.profile === "none") {
		return OUTCOME.SKIPPED;
	}
	if (result.valid === true) {
		return OUTCOME.VERIFIED;
	}
	if (result.valid === false) {
		return OUTCOME.INVALID;
	}
	// valid === null / undefined => inconclusive (kept in place)
	return OUTCOME.INCONCLUSIVE;
}

/**
 * Resolve the DB validation_status string to persist for a verdict.
 * @param {"verified"|"inconclusive"|"invalid"|"skipped"} verdict
 * @param {boolean} quarantined - whether an invalid file was quarantined
 * @returns {string}
 */
function statusForVerdict(verdict, quarantined) {
	switch (verdict) {
		case OUTCOME.VERIFIED:
			return "verified";
		case OUTCOME.INCONCLUSIVE:
			return "inconclusive";
		case OUTCOME.INVALID:
			return quarantined ? "quarantined" : "failed";
		default:
			return "verified";
	}
}

/**
 * Apply the consequences of a validation result: persist DB validation state,
 * and for invalid files quarantine (or delete) and mark them for re-download.
 * "inconclusive" files are always kept in place.
 *
 * Side-effecting collaborators are injected so this is unit-testable and free of
 * hard module coupling.
 *
 * @param {Object} params
 * @param {Object} params.result - validateMediaFile result
 * @param {string} params.channelId
 * @param {string} params.outputFolder
 * @param {number} params.messageId
 * @param {string} params.filePath
 * @param {boolean} [params.dryRun=false]
 * @param {Object} params.db - db module (setFileDownloaded, setValidationState)
 * @param {Function} [params.quarantineFn] - async (filePath, reason, metadata) => {ok,...}
 * @param {Object} [params.metadata] - extra metadata for quarantine sidecar
 * @returns {Promise<{verdict:string, status:string, quarantined:boolean, requeue:boolean}>}
 */
async function applyValidationOutcome(params) {
	const {
		result,
		channelId,
		outputFolder,
		messageId,
		filePath,
		dryRun = false,
		db,
		quarantineFn = null,
		metadata = {},
	} = params;

	const verdict = classifyOutcome(result);
	const hasDbTarget = Boolean(channelId && outputFolder && messageId);
	const profile = result?.profile || null;

	if (verdict === OUTCOME.SKIPPED) {
		return { verdict, status: "skipped", quarantined: false, requeue: false };
	}

	if (verdict === OUTCOME.VERIFIED) {
		if (hasDbTarget && db) {
			db.setValidationState(channelId, outputFolder, messageId, {
				status: "verified",
				profile,
				error: null,
			});
		}
		return { verdict, status: "verified", quarantined: false, requeue: false };
	}

	if (verdict === OUTCOME.INCONCLUSIVE) {
		if (hasDbTarget && db) {
			db.setValidationState(channelId, outputFolder, messageId, {
				status: "inconclusive",
				profile,
				error: result?.error || null,
			});
		}
		return { verdict, status: "inconclusive", quarantined: false, requeue: false };
	}

	// INVALID
	let quarantined = false;
	if (!dryRun && quarantineFn) {
		const wantQuarantine = config.get("download.quarantineInvalidFiles", true);
		const q = await quarantineFn(filePath, result?.error || "validation failed", metadata);
		quarantined = wantQuarantine ? Boolean(q?.ok) : false;
	}

	const status = statusForVerdict(OUTCOME.INVALID, quarantined);
	if (!dryRun && hasDbTarget && db) {
		db.setFileDownloaded(channelId, outputFolder, messageId, 0);
		db.setValidationState(channelId, outputFolder, messageId, {
			status,
			profile,
			error: result?.error || null,
		});
	}

	return { verdict, status, quarantined, requeue: true };
}

module.exports = {
	OUTCOME,
	classifyOutcome,
	statusForVerdict,
	applyValidationOutcome,
};
