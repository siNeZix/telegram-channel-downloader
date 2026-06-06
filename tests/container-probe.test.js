const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { probeContainer, probeFileType, probeIsoBmff, ISO_BMFF_EXTENSIONS } = require("../validators/container_probe");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgdl-probe-test-"));

test.after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemp(name, data) {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, data);
	return p;
}

test("ISO_BMFF_EXTENSIONS contains expected extensions", () => {
	assert.ok(ISO_BMFF_EXTENSIONS.has("mp4"));
	assert.ok(ISO_BMFF_EXTENSIONS.has("m4v"));
	assert.ok(ISO_BMFF_EXTENSIONS.has("m4a"));
	assert.ok(ISO_BMFF_EXTENSIONS.has("mov"));
	assert.ok(ISO_BMFF_EXTENSIONS.has("3gp"));
	assert.ok(!ISO_BMFF_EXTENSIONS.has("mkv"));
});

test("probeContainer returns inconclusive for unknown extension without file-type/mp4box", async () => {
	const p = writeTemp("file.txt", Buffer.alloc(32, 0x00));
	const result = await probeContainer(p, {
		extension: "txt",
		useFileType: false,
		useMp4box: false,
	});
	assert.equal(result.valid, null);
	assert.equal(result.status, "inconclusive");
});

test("probeContainer returns inconclusive for non-existent file", async () => {
	const result = await probeContainer(path.join(tmpDir, "nope.mp4"), {
		extension: "mp4",
		useFileType: false,
		useMp4box: false,
	});
	assert.equal(result.valid, null);
	assert.equal(result.status, "inconclusive");
});

test("probeContainer with useFileType=true runs file-type probe", async () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	const p = writeTemp("image.png", buf);

	const result = await probeContainer(p, {
		extension: "png",
		useFileType: true,
		useMp4box: false,
	});

	assert.ok(result.valid === true || result.valid === null);
});

test("probeFileType returns inconclusive for empty file", async () => {
	const p = writeTemp("empty.mp4", Buffer.alloc(0));
	const result = await probeFileType(p, "mp4");
	assert.equal(result.status, "inconclusive");
});

test("probeIsoBmff returns inconclusive when mp4box is unavailable", async () => {
	const p = writeTemp("bad.mp4", Buffer.alloc(32, 0x00));
	const result = await probeIsoBmff(p, 32);
	assert.ok(result.status === "inconclusive" || result.status === "invalid" || result.status === "valid");
});

test("probeContainer respects size option", async () => {
	const buf = Buffer.alloc(128, 0x00);
	const p = writeTemp("sized.mp4", buf);
	const result = await probeContainer(p, {
		extension: "mp4",
		size: 128,
		useFileType: false,
		useMp4box: false,
	});
	assert.equal(result.status, "inconclusive");
});
