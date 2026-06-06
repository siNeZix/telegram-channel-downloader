/**
 * FFmpeg/FFprobe stderr error classification.
 *
 * Lines are matched against NON_FATAL patterns first (recoverable decode
 * warnings that valid media legitimately produces) and only then against FATAL
 * patterns (structural / unrecoverable corruption). Anything matching neither
 * is reported as "unknown" so callers can decide whether to treat it as
 * inconclusive rather than silently passing or failing.
 */

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
	/end of file/i,
	/partial file/i,
	/header missing/i,
	/invalid nal size/i,
	/error splitting the input into nal units/i,
	/decoding failed/i,
	/failed to read frame size/i,
	/unable to find a suitable output format/i,
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
	/deprecated pixel format used/i,
	/co located POCs unavailable/i,
	/illegal short term buffer state detected/i,
	/reference picture missing during reorder/i,
	/number of reference frames .* exceeds max/i,
];

/**
 * Classify ffmpeg/ffprobe output lines into fatal / non-fatal / unknown buckets.
 * @param {string} stderr
 * @param {string} [stdout]
 * @returns {{ fatalErrors: string[], nonFatalErrors: string[], unknownErrors: string[] }}
 */
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
		if (!isFatal) {
			unknownErrors.push(trimmed);
		}
	}

	return { fatalErrors, nonFatalErrors, unknownErrors };
}

module.exports = {
	FATAL_ERROR_PATTERNS,
	NON_FATAL_ERROR_PATTERNS,
	classifyFFmpegErrors,
};
