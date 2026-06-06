const test = require("node:test");
const assert = require("node:assert/strict");

const {
	classifyFFmpegErrors,
	FATAL_ERROR_PATTERNS,
	NON_FATAL_ERROR_PATTERNS,
} = require("../validators/error_patterns");

test("classifyFFmpegErrors classifies fatal errors", () => {
	const result = classifyFFmpegErrors("moov atom not found", "");
	assert.deepEqual(result.fatalErrors, ["moov atom not found"]);
	assert.deepEqual(result.nonFatalErrors, []);
	assert.deepEqual(result.unknownErrors, []);
});

test("classifyFFmpegErrors classifies non-fatal errors", () => {
	const result = classifyFFmpegErrors("missing reference picture", "");
	assert.deepEqual(result.fatalErrors, []);
	assert.deepEqual(result.nonFatalErrors, ["missing reference picture"]);
	assert.deepEqual(result.unknownErrors, []);
});

test("classifyFFmpegErrors reports unknown lines", () => {
	const result = classifyFFmpegErrors("Some unrecognised warning line", "");
	assert.deepEqual(result.fatalErrors, []);
	assert.deepEqual(result.nonFatalErrors, []);
	assert.deepEqual(result.unknownErrors, ["Some unrecognised warning line"]);
});

test("classifyFFmpegErrors prioritises non-fatal over fatal", () => {
	const line = "error while decoding MB";
	const result = classifyFFmpegErrors(line, "");
	assert.deepEqual(result.nonFatalErrors, [line]);
	assert.deepEqual(result.fatalErrors, []);
});

test("classifyFFmpegErrors combines stderr and stdout", () => {
	const result = classifyFFmpegErrors("moov atom not found", "invalid data found");
	assert.equal(result.fatalErrors.length, 2);
});

test("classifyFFmpegErrors handles empty input", () => {
	const result = classifyFFmpegErrors("", "");
	assert.deepEqual(result.fatalErrors, []);
	assert.deepEqual(result.nonFatalErrors, []);
	assert.deepEqual(result.unknownErrors, []);
});

test("classifyFFmpegErrors handles null/undefined input", () => {
	const result = classifyFFmpegErrors(null, undefined);
	assert.deepEqual(result.fatalErrors, []);
	assert.deepEqual(result.nonFatalErrors, []);
	assert.deepEqual(result.unknownErrors, []);
});

test("classifyFFmpegErrors filters blank lines", () => {
	const result = classifyFFmpegErrors("\n  \nmoov atom not found\n  \n", "");
	assert.deepEqual(result.fatalErrors, ["moov atom not found"]);
	assert.equal(result.unknownErrors.length, 0);
});

test("all fatal patterns are regexes", () => {
	for (const p of FATAL_ERROR_PATTERNS) {
		assert.ok(p instanceof RegExp, `${p} is not a RegExp`);
	}
});

test("all non-fatal patterns are regexes", () => {
	for (const p of NON_FATAL_ERROR_PATTERNS) {
		assert.ok(p instanceof RegExp, `${p} is not a RegExp`);
	}
});

test("classifyFFmpegErrors handles multiple lines of mixed types", () => {
	const stderr = [
		"moov atom not found",
		"missing reference picture",
		"some unknown thing",
		"truncated file",
		"decode_slice_header error",
	].join("\n");
	const result = classifyFFmpegErrors(stderr, "");
	assert.equal(result.fatalErrors.length, 2);
	assert.equal(result.nonFatalErrors.length, 2);
	assert.equal(result.unknownErrors.length, 1);
});
