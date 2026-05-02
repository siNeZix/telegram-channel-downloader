const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeFileName } = require("../utils/helper");

test("sanitizeFileName replaces Windows-invalid characters with underscores", () => {
	assert.equal(sanitizeFileName("foo:bar.mp4"), "foo_bar.mp4");
	assert.equal(sanitizeFileName("a<b>"), "a_b_");
	assert.equal(sanitizeFileName('a"b/c\\d|e?f*g'), "a_b_c_d_e_f_g");
	assert.equal(sanitizeFileName("hello\x01world"), "hello_world");
	assert.equal(sanitizeFileName("no change.txt"), "no change.txt");
});

test("sanitizeFileName trims trailing whitespace", () => {
	assert.equal(sanitizeFileName("name   "), "name");
});
