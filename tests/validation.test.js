const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyFFmpegErrors } = require("../validators/ffmpeg_validator");
const { getTypeByExtension } = require("../validators/file_scanner");
const { parseArgs } = require("../validators");

test("file scanner classifies audio separately from video", () => {
	assert.equal(getTypeByExtension("mp3"), "audio");
	assert.equal(getTypeByExtension("opus"), "audio");
	assert.equal(getTypeByExtension("mp4"), "video");
	assert.equal(getTypeByExtension("jpg"), "image");
});

test("ffmpeg classifier keeps unknown lines inconclusive", () => {
	const result = classifyFFmpegErrors("Some codec warning without known fatal signature", "");

	assert.deepEqual(result.fatalErrors, []);
	assert.deepEqual(result.nonFatalErrors, []);
	assert.deepEqual(result.unknownErrors, ["Some codec warning without known fatal signature"]);
});

test("ffmpeg classifier still detects high-confidence fatal errors", () => {
	const result = classifyFFmpegErrors("moov atom not found", "");

	assert.deepEqual(result.fatalErrors, ["moov atom not found"]);
	assert.deepEqual(result.unknownErrors, []);
});

test("validator CLI parses audio and strict options", () => {
	const oldArgv = process.argv;
	process.argv = ["node", "validators/index.js", "--audio", "--strict", "--dry-run"];

	try {
		const options = parseArgs();
		assert.equal(options.type, "audio");
		assert.equal(options.strict, true);
		assert.equal(options.deep, true);
		assert.equal(options.dryRun, true);
	} finally {
		process.argv = oldArgv;
	}
});
