const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	checkSignature,
	startsWith,
	endsWith,
	bytesAt,
	HEADER_BYTES,
	TRAILER_BYTES,
} = require("../validators/signatures");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgdl-sig-test-"));

test.after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemp(name, data) {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, data);
	return p;
}

test("startsWith matches exact prefix", () => {
	assert.equal(startsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47]), [0x89, 0x50]), true);
});

test("startsWith rejects wrong prefix", () => {
	assert.equal(startsWith(Buffer.from([0x00, 0x01]), [0xff]), false);
});

test("startsWith returns false for short buffer", () => {
	assert.equal(startsWith(Buffer.from([0x89]), [0x89, 0x50]), false);
});

test("endsWith matches exact suffix", () => {
	assert.equal(endsWith(Buffer.from([0xff, 0xd9]), [0xff, 0xd9]), true);
});

test("endsWith rejects wrong suffix", () => {
	assert.equal(endsWith(Buffer.from([0x00, 0x01]), [0xff, 0xd9]), false);
});

test("endsWith returns false for short buffer", () => {
	assert.equal(endsWith(Buffer.from([0xff]), [0xff, 0xd9]), false);
});

test("bytesAt matches at offset", () => {
	const buf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70]);
	assert.equal(bytesAt(buf, 4, [0x66, 0x74, 0x79, 0x70]), true);
});

test("bytesAt rejects wrong bytes at offset", () => {
	const buf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70]);
	assert.equal(bytesAt(buf, 4, [0x00, 0x00]), false);
});

test("bytesAt returns false for short buffer", () => {
	const buf = Buffer.from([0x00]);
	assert.equal(bytesAt(buf, 0, [0x00, 0x01]), false);
});

test("checkSignature returns invalid for empty file", () => {
	const p = writeTemp("empty.jpg", Buffer.alloc(0));
	const result = checkSignature(p);
	assert.equal(result.valid, false);
	assert.equal(result.status, "invalid");
});

test("checkSignature returns invalid for non-existent file", () => {
	const result = checkSignature(path.join(tmpDir, "nope.jpg"));
	assert.equal(result.valid, false);
	assert.equal(result.status, "invalid");
});

test("checkSignature returns inconclusive for unknown extension", () => {
	const p = writeTemp("file.xyz", Buffer.alloc(64, 0x00));
	const result = checkSignature(p);
	assert.equal(result.valid, null);
	assert.equal(result.status, "inconclusive");
});

test("checkSignature validates JPEG header + trailer", () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0xff;
	buf[1] = 0xd8;
	buf[2] = 0xff;
	buf[62] = 0xff;
	buf[63] = 0xd9;
	const p = writeTemp("photo.jpg", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.status, "valid");
	assert.equal(result.detectedType, "image/jpeg");
});

test("checkSignature detects bad JPEG header", () => {
	const buf = Buffer.alloc(64, 0x00);
	const p = writeTemp("bad.jpg", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, false);
	assert.equal(result.status, "invalid");
});

test("checkSignature validates PNG header + IEND", () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
	for (let i = 0; i < iend.length; i++) buf[56 + i] = iend[i];
	const p = writeTemp("image.png", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "image/png");
});

test("checkSignature detects truncated PNG (no IEND)", () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	const p = writeTemp("trunc.png", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, false);
	assert.equal(result.status, "invalid");
});

test("checkSignature validates GIF87a", () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0x47;
	buf[1] = 0x49;
	buf[2] = 0x46;
	buf[3] = 0x38;
	buf[4] = 0x37;
	buf[5] = 0x61;
	const p = writeTemp("anim.gif", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "image/gif");
});

test("checkSignature validates GIF89a", () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0x47;
	buf[1] = 0x49;
	buf[2] = 0x46;
	buf[3] = 0x38;
	buf[4] = 0x39;
	buf[5] = 0x61;
	const p = writeTemp("anim89.gif", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "image/gif");
});

test("checkSignature validates WebP", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[0] = 0x52;
	buf[1] = 0x49;
	buf[2] = 0x46;
	buf[3] = 0x46;
	buf[8] = 0x57;
	buf[9] = 0x45;
	buf[10] = 0x42;
	buf[11] = 0x50;
	const p = writeTemp("pic.webp", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "image/webp");
});

test("checkSignature validates MP4 ftyp", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[4] = 0x66;
	buf[5] = 0x74;
	buf[6] = 0x79;
	buf[7] = 0x70;
	const p = writeTemp("video.mp4", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "video/mp4");
});

test("checkSignature validates MKV EBML header", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[0] = 0x1a;
	buf[1] = 0x45;
	buf[2] = 0xdf;
	buf[3] = 0xa3;
	const p = writeTemp("video.mkv", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "video/x-matroska");
});

test("checkSignature validates OGG", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[0] = 0x4f;
	buf[1] = 0x67;
	buf[2] = 0x67;
	buf[3] = 0x53;
	const p = writeTemp("audio.ogg", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "audio/ogg");
});

test("checkSignature validates FLAC", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[0] = 0x66;
	buf[1] = 0x4c;
	buf[2] = 0x61;
	buf[3] = 0x43;
	const p = writeTemp("audio.flac", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "audio/flac");
});

test("checkSignature validates MP3 with ID3 tag", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[0] = 0x49;
	buf[1] = 0x44;
	buf[2] = 0x33;
	const p = writeTemp("audio.mp3", buf);
	const result = checkSignature(p);
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "audio/mpeg");
});

test("checkSignature uses options.size when provided", () => {
	const buf = Buffer.alloc(64, 0x00);
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
	for (let i = 0; i < iend.length; i++) buf[56 + i] = iend[i];
	const p = writeTemp("sized.png", buf);
	const result = checkSignature(p, { size: 64 });
	assert.equal(result.valid, true);
});

test("checkSignature uses options.extension override", () => {
	const buf = Buffer.alloc(32, 0x00);
	buf[4] = 0x66;
	buf[5] = 0x74;
	buf[6] = 0x79;
	buf[7] = 0x70;
	const p = writeTemp("video.dat", buf);
	const result = checkSignature(p, { extension: "mp4" });
	assert.equal(result.valid, true);
	assert.equal(result.detectedType, "video/mp4");
});

test("HEADER_BYTES and TRAILER_BYTES are 32", () => {
	assert.equal(HEADER_BYTES, 32);
	assert.equal(TRAILER_BYTES, 32);
});
