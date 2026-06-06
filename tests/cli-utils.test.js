const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs, takeOptionValue, resolveChannelId } = require("../utils/cli_utils");
const { parseCommand, toValidationOptions, toCheckMode, toValidationProfile } = require("../cli/commands");

test("takeOptionValue consumes a value but not a following flag", () => {
	const a = ["--root", "/tmp", "--deep"];
	assert.equal(takeOptionValue(a, "--root"), "/tmp");
	assert.deepEqual(a, ["--deep"]);

	const b = ["--root", "--deep"];
	assert.equal(takeOptionValue(b, "--root"), undefined);
	assert.deepEqual(b, ["--deep"]);
});

test("parseArgs collects booleans, values, positionals and unknown flags", () => {
	const spec = {
		booleans: [{ name: "deep", flags: ["--deep", "-D"] }],
		values: [{ name: "channel", flags: ["--channel"], transform: resolveChannelId }],
		defaults: { deep: false, channel: null },
	};
	const result = parseArgs(["--deep", "--channel", "123", "extra", "--bogus"], spec);
	assert.equal(result.deep, true);
	assert.equal(result.channel, 123);
	assert.deepEqual(result.positionals, ["extra"]);
	assert.deepEqual(result.unknown, ["--bogus"]);
});

test("boolean apply hook runs (strict implies deep)", () => {
	const parsed = parseCommand("valid", ["--strict"]);
	assert.equal(parsed.strict, true);
	assert.equal(parsed.deep, true);
});

test("resolveChannelId rejects zero and non-numeric", () => {
	assert.equal(resolveChannelId("123"), 123);
	assert.equal(resolveChannelId("0"), null);
	assert.equal(resolveChannelId("abc"), null);
	assert.equal(resolveChannelId(undefined), null);
});

test("download command parses channel + check/deep into a validation plan", () => {
	const fast = parseCommand("download", ["--channel", "42", "--check"]);
	assert.equal(fast.channel, 42);
	assert.deepEqual(toCheckMode(fast), { enabled: true, profile: "fast", verifyHash: false });

	const deep = parseCommand("download", ["--deep"]);
	assert.deepEqual(toCheckMode(deep), { enabled: true, profile: "full", verifyHash: false });

	const none = parseCommand("download", []);
	assert.deepEqual(toCheckMode(none), { enabled: false, profile: "none", verifyHash: false });
});

test("toValidationProfile keeps strict distinct from deep and respects --verify-hash", () => {
	assert.equal(toValidationProfile(parseCommand("download", ["--check"])), "fast");
	assert.equal(toValidationProfile(parseCommand("download", ["--deep"])), "full");
	assert.equal(toValidationProfile(parseCommand("download", ["--strict"])), "strict");
	assert.equal(toValidationProfile(parseCommand("download", [])), "none");

	const strictHash = parseCommand("download", ["--strict", "--verify-hash"]);
	assert.deepEqual(toCheckMode(strictHash), { enabled: true, profile: "strict", verifyHash: true });
});

test("ids command parses comma-separated message ids", () => {
	const parsed = parseCommand("ids", ["--channel", "7", "--messages", "1, 2 ,3"]);
	assert.equal(parsed.channel, 7);
	assert.deepEqual(parsed.messages, [1, 2, 3]);
});

test("toValidationOptions maps flags to runValidation options", () => {
	const parsed = parseCommand("valid", ["--audio", "--strict", "--dry-run"]);
	const options = toValidationOptions(parsed);
	assert.equal(options.type, "audio");
	assert.equal(options.strict, true);
	assert.equal(options.deep, true);
	assert.equal(options.dryRun, true);
});
