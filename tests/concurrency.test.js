const test = require("node:test");
const assert = require("node:assert/strict");

const { runPool, defaultConcurrency, DEFAULT_CONCURRENCY } = require("../utils/concurrency");

test("runPool returns empty array for empty input", async () => {
	const result = await runPool([], () => Promise.resolve("x"));
	assert.deepEqual(result, []);
});

test("runPool returns results in original item order", async () => {
	const items = [10, 20, 30, 40, 50];
	const result = await runPool(items, async (item, index) => {
		await new Promise((r) => setTimeout(r, Math.random() * 10));
		return item * 2;
	});

	assert.equal(result.length, 5);
	assert.equal(result[0].value, 20);
	assert.equal(result[1].value, 40);
	assert.equal(result[2].value, 60);
	assert.equal(result[3].value, 80);
	assert.equal(result[4].value, 100);
	for (let i = 0; i < result.length; i++) {
		assert.equal(result[i].ok, true);
		assert.equal(result[i].index, i);
		assert.equal(result[i].item, items[i]);
	}
});

test("runPool captures worker rejections per-item without aborting the pool", async () => {
	const items = ["a", "b", "c"];
	const result = await runPool(items, async (item) => {
		if (item === "b") throw new Error("boom");
		return item.toUpperCase();
	});

	assert.equal(result[0].ok, true);
	assert.equal(result[0].value, "A");
	assert.equal(result[1].ok, false);
	assert.equal(result[1].error.message, "boom");
	assert.equal(result[2].ok, true);
	assert.equal(result[2].value, "C");
});

test("runPool wraps non-Error rejections in Error", async () => {
	const result = await runPool([1], () => Promise.reject("string error"));
	assert.equal(result[0].ok, false);
	assert.ok(result[0].error instanceof Error);
	assert.ok(result[0].error.message.includes("string error"));
});

test("runPool respects concurrency option", async () => {
	let maxConcurrent = 0;
	let current = 0;

	await runPool(
		Array.from({ length: 20 }, (_, i) => i),
		async () => {
			current++;
			if (current > maxConcurrent) maxConcurrent = current;
			await new Promise((r) => setTimeout(r, 10));
			current--;
			return "ok";
		},
		{ concurrency: 3 },
	);

	assert.ok(maxConcurrent <= 3, `maxConcurrent=${maxConcurrent} exceeds concurrency=3`);
});

test("runPool clamps concurrency to item count", async () => {
	const items = [1, 2];
	let maxConcurrent = 0;
	let current = 0;

	await runPool(
		items,
		async () => {
			current++;
			if (current > maxConcurrent) maxConcurrent = current;
			await new Promise((r) => setTimeout(r, 5));
			current--;
			return "ok";
		},
		{ concurrency: 100 },
	);

	assert.ok(maxConcurrent <= 2, `maxConcurrent=${maxConcurrent} exceeds items.length=2`);
});

test("runPool clamps concurrency to at least 1", async () => {
	const result = await runPool([1], async (item) => item + 1, { concurrency: 0 });
	assert.equal(result[0].ok, true);
	assert.equal(result[0].value, 2);
});

test("runPool handles non-array input gracefully", async () => {
	const result = await runPool(null, async (item) => item);
	assert.deepEqual(result, []);
});

test("defaultConcurrency returns a number between 1 and cap", () => {
	const value = defaultConcurrency(4);
	assert.ok(Number.isFinite(value));
	assert.ok(value >= 1);
	assert.ok(value <= 4);
});

test("defaultConcurrency defaults cap to 8", () => {
	const value = defaultConcurrency();
	assert.ok(Number.isFinite(value));
	assert.ok(value >= 1);
	assert.ok(value <= 8);
});

test("DEFAULT_CONCURRENCY is 10", () => {
	assert.equal(DEFAULT_CONCURRENCY, 10);
});
