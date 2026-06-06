const test = require("node:test");
const assert = require("node:assert/strict");

const { buildInputLocation, MAX_HASH_REQUESTS } = require("../services/HashVerifier");

test("MAX_HASH_REQUESTS is 64", () => {
	assert.equal(MAX_HASH_REQUESTS, 64);
});

test("buildInputLocation returns null for message without media", () => {
	assert.equal(buildInputLocation({}), null);
	assert.equal(buildInputLocation({ media: null }), null);
	assert.equal(buildInputLocation(null), null);
});

test("buildInputLocation builds InputDocumentFileLocation for document media", () => {
	const message = {
		media: {
			document: {
				id: { value: 123n },
				accessHash: { value: 456n },
				fileReference: Buffer.from([1, 2, 3]),
			},
		},
	};

	const location = buildInputLocation(message);
	assert.ok(location);
	assert.equal(location.className, "InputDocumentFileLocation");
});

test("buildInputLocation builds InputPhotoFileLocation for photo media", () => {
	const message = {
		media: {
			photo: {
				id: { value: 789n },
				accessHash: { value: 101n },
				fileReference: Buffer.from([4, 5, 6]),
				sizes: [{ type: "x" }, { type: "y" }],
			},
		},
	};

	const location = buildInputLocation(message);
	assert.ok(location);
	assert.equal(location.className, "InputPhotoFileLocation");
});

test("buildInputLocation returns null for photo with empty sizes", () => {
	const message = {
		media: {
			photo: {
				id: { value: 789n },
				accessHash: { value: 101n },
				fileReference: Buffer.from([4, 5, 6]),
				sizes: [],
			},
		},
	};

	assert.equal(buildInputLocation(message), null);
});

test("buildInputLocation returns null for photo with non-string size types", () => {
	const message = {
		media: {
			photo: {
				id: { value: 789n },
				accessHash: { value: 101n },
				fileReference: Buffer.from([4, 5, 6]),
				sizes: [{ type: 42 }, { type: null }],
			},
		},
	};

	assert.equal(buildInputLocation(message), null);
});
