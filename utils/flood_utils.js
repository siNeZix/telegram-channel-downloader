function getErrorText(err) {
	return (err?.errorMessage || err?.message || String(err) || "").toUpperCase();
}

function parseFloodWaitSeconds(err) {
	const directSeconds = Number(err?.seconds);
	if (Number.isFinite(directSeconds) && directSeconds > 0) {
		return directSeconds;
	}
	const text = getErrorText(err);
	const floodMatch = text.match(/FLOOD_WAIT_?(\d+)/);
	if (floodMatch?.[1]) {
		return Number(floodMatch[1]);
	}
	const waitMatch = text.match(/A WAIT OF (\d+) SECONDS/);
	if (waitMatch?.[1]) {
		return Number(waitMatch[1]);
	}
	return null;
}

function isFileReferenceExpired(err) {
	const text = getErrorText(err);
	return text.includes("FILE_REFERENCE") && text.includes("EXPIRED");
}

module.exports = {
	getErrorText,
	parseFloodWaitSeconds,
	isFileReferenceExpired,
};
