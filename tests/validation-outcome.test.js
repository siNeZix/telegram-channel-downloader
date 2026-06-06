const test = require("node:test");
const assert = require("node:assert/strict");

const { OUTCOME, classifyOutcome, statusForVerdict, applyValidationOutcome } = require("../services/ValidationOutcome");

test("OUTCOME constants are frozen and correct", () => {
	assert.deepEqual(OUTCOME, {
		VERIFIED: "verified",
		INCONCLUSIVE: "inconclusive",
		INVALID: "invalid",
		SKIPPED: "skipped",
	});
	assert.ok(Object.isFrozen(OUTCOME));
});

test("classifyOutcome returns VERIFIED for valid=true", () => {
	assert.equal(classifyOutcome({ valid: true }), OUTCOME.VERIFIED);
});

test("classifyOutcome returns INVALID for valid=false", () => {
	assert.equal(classifyOutcome({ valid: false }), OUTCOME.INVALID);
});

test("classifyOutcome returns INCONCLUSIVE for valid=null", () => {
	assert.equal(classifyOutcome({ valid: null }), OUTCOME.INCONCLUSIVE);
});

test("classifyOutcome returns INCONCLUSIVE for valid=undefined", () => {
	assert.equal(classifyOutcome({ valid: undefined }), OUTCOME.INCONCLUSIVE);
});

test("classifyOutcome returns INCONCLUSIVE for null result", () => {
	assert.equal(classifyOutcome(null), OUTCOME.INCONCLUSIVE);
});

test("classifyOutcome returns INCONCLUSIVE for undefined result", () => {
	assert.equal(classifyOutcome(undefined), OUTCOME.INCONCLUSIVE);
});

test("classifyOutcome returns SKIPPED for action=skip", () => {
	assert.equal(classifyOutcome({ valid: true, action: "skip" }), OUTCOME.SKIPPED);
});

test("classifyOutcome returns SKIPPED for profile=none", () => {
	assert.equal(classifyOutcome({ valid: null, profile: "none" }), OUTCOME.SKIPPED);
});

test("statusForVerdict maps VERIFIED to 'verified'", () => {
	assert.equal(statusForVerdict(OUTCOME.VERIFIED, false), "verified");
});

test("statusForVerdict maps INCONCLUSIVE to 'inconclusive'", () => {
	assert.equal(statusForVerdict(OUTCOME.INCONCLUSIVE, false), "inconclusive");
});

test("statusForVerdict maps INVALID + quarantined to 'quarantined'", () => {
	assert.equal(statusForVerdict(OUTCOME.INVALID, true), "quarantined");
});

test("statusForVerdict maps INVALID + not quarantined to 'failed'", () => {
	assert.equal(statusForVerdict(OUTCOME.INVALID, false), "failed");
});

test("applyValidationOutcome returns SKIPPED without side effects", async () => {
	const result = await applyValidationOutcome({
		result: { valid: true, action: "skip" },
		channelId: "ch",
		outputFolder: "/out",
		messageId: 1,
		filePath: "/out/file.mp4",
		db: null,
		quarantineFn: null,
	});
	assert.equal(result.verdict, OUTCOME.SKIPPED);
	assert.equal(result.status, "skipped");
	assert.equal(result.quarantined, false);
	assert.equal(result.requeue, false);
});

test("applyValidationOutcome returns VERIFIED and calls db.setValidationState", async () => {
	const calls = [];
	const mockDb = {
		setValidationState: (...args) => calls.push({ method: "setValidationState", args }),
	};

	const result = await applyValidationOutcome({
		result: { valid: true, profile: "fast", error: null },
		channelId: "ch1",
		outputFolder: "/export/ch1",
		messageId: 42,
		filePath: "/export/ch1/video/file_42.mp4",
		db: mockDb,
		quarantineFn: null,
	});

	assert.equal(result.verdict, OUTCOME.VERIFIED);
	assert.equal(result.status, "verified");
	assert.equal(result.quarantined, false);
	assert.equal(result.requeue, false);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[0], "ch1");
	assert.equal(calls[0].args[2], 42);
	assert.equal(calls[0].args[3].status, "verified");
});

test("applyValidationOutcome returns INCONCLUSIVE and persists state", async () => {
	const calls = [];
	const mockDb = {
		setValidationState: (...args) => calls.push({ method: "setValidationState", args }),
	};

	const result = await applyValidationOutcome({
		result: { valid: null, profile: "sampled", error: "no duration" },
		channelId: "ch2",
		outputFolder: "/export/ch2",
		messageId: 99,
		filePath: "/export/ch2/video/file_99.mp4",
		db: mockDb,
		quarantineFn: null,
	});

	assert.equal(result.verdict, OUTCOME.INCONCLUSIVE);
	assert.equal(result.status, "inconclusive");
	assert.equal(result.quarantined, false);
	assert.equal(result.requeue, false);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[3].status, "inconclusive");
});

test("applyValidationOutcome quarantines invalid files and marks requeue", async () => {
	const dbCalls = [];
	const mockDb = {
		setValidationState: (...args) => dbCalls.push({ method: "setValidationState", args }),
		setFileDownloaded: (...args) => dbCalls.push({ method: "setFileDownloaded", args }),
	};

	const quarantineCalls = [];
	const mockQuarantine = async (filePath, reason, meta) => {
		quarantineCalls.push({ filePath, reason, meta });
		return { ok: true };
	};

	const result = await applyValidationOutcome({
		result: { valid: false, profile: "fast", error: "moov atom not found" },
		channelId: "ch3",
		outputFolder: "/export/ch3",
		messageId: 7,
		filePath: "/export/ch3/video/file_7.mp4",
		db: mockDb,
		quarantineFn: mockQuarantine,
	});

	assert.equal(result.verdict, OUTCOME.INVALID);
	assert.equal(result.status, "quarantined");
	assert.equal(result.quarantined, true);
	assert.equal(result.requeue, true);
	assert.equal(quarantineCalls.length, 1);
	assert.equal(quarantineCalls[0].filePath, "/export/ch3/video/file_7.mp4");
	assert.ok(dbCalls.some((c) => c.method === "setFileDownloaded"));
	assert.ok(dbCalls.some((c) => c.method === "setValidationState"));
});

test("applyValidationOutcome does not quarantine in dryRun mode", async () => {
	const quarantineCalls = [];
	const mockQuarantine = async (filePath, reason) => {
		quarantineCalls.push({ filePath, reason });
		return { ok: true };
	};

	const result = await applyValidationOutcome({
		result: { valid: false, error: "truncated" },
		channelId: "ch",
		outputFolder: "/out",
		messageId: 1,
		filePath: "/out/file.mp4",
		dryRun: true,
		db: null,
		quarantineFn: mockQuarantine,
	});

	assert.equal(result.verdict, OUTCOME.INVALID);
	assert.equal(result.quarantined, false);
	assert.equal(quarantineCalls.length, 0);
});

test("applyValidationOutcome works without db/quarantineFn", async () => {
	const result = await applyValidationOutcome({
		result: { valid: true, profile: "fast" },
		channelId: "ch",
		outputFolder: "/out",
		messageId: 1,
		filePath: "/out/file.mp4",
		db: null,
		quarantineFn: null,
	});

	assert.equal(result.verdict, OUTCOME.VERIFIED);
	assert.equal(result.status, "verified");
});

test("applyValidationOutcome skips DB when channelId/outputFolder/messageId missing", async () => {
	const calls = [];
	const mockDb = {
		setValidationState: (...args) => calls.push(args),
	};

	const result = await applyValidationOutcome({
		result: { valid: true, profile: "fast" },
		channelId: null,
		outputFolder: "/out",
		messageId: 1,
		filePath: "/out/file.mp4",
		db: mockDb,
		quarantineFn: null,
	});

	assert.equal(result.verdict, OUTCOME.VERIFIED);
	assert.equal(calls.length, 0);
});
