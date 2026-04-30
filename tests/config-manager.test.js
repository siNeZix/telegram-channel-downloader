const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ConfigManager, DEFAULTS } = require("../utils/config");

const createTempConfigPath = () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgdl-config-test-"));
	return {
		tempDir,
		configPath: path.join(tempDir, "config.json"),
	};
};

test("ConfigManager merges defaults into sparse config files and persists missing fields", () => {
	const { tempDir, configPath } = createTempConfigPath();
	fs.writeFileSync(configPath, JSON.stringify({ download: { maxParallel: 7 } }, null, 2));

	try {
		const manager = new ConfigManager({ configPath, watch: false });

		assert.equal(manager.get("download.maxParallel"), 7);
		assert.equal(manager.get("download.minParallel"), DEFAULTS.download.minParallel);
		assert.equal(manager.get("logging.progressLogIntervalSeconds"), DEFAULTS.logging.progressLogIntervalSeconds);

		const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
		assert.equal(persisted.download.maxParallel, 7);
		assert.equal(persisted.download.minParallel, DEFAULTS.download.minParallel);
		assert.equal(persisted.logging.progressLogIntervalSeconds, DEFAULTS.logging.progressLogIntervalSeconds);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("ConfigManager handles empty config files as defaults and writes a valid config back", () => {
	const { tempDir, configPath } = createTempConfigPath();
	fs.writeFileSync(configPath, "   ");

	try {
		const manager = new ConfigManager({ configPath, watch: false });
		const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));

		assert.equal(manager.get("download.maxParallel"), DEFAULTS.download.maxParallel);
		assert.equal(persisted.download.maxParallel, DEFAULTS.download.maxParallel);
		assert.equal(persisted.logging.progressLogIntervalSeconds, DEFAULTS.logging.progressLogIntervalSeconds);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("ConfigManager._reload reports only changed keys to listeners", () => {
	const { tempDir, configPath } = createTempConfigPath();
	fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2));

	try {
		const manager = new ConfigManager({ configPath, watch: false });
		const notifications = [];
		manager.addListener((changedKeys) => notifications.push(changedKeys));
		const originalConsoleLog = console.log;
		console.log = () => {};

		try {
			fs.writeFileSync(
				configPath,
				JSON.stringify(
					{
						...DEFAULTS,
						apiId: 123,
						download: {
							...DEFAULTS.download,
							maxParallel: 9,
						},
					},
					null,
					2,
				),
			);

			manager._reload();

			assert.deepEqual(notifications, [["apiId", "download.maxParallel"]]);
		} finally {
			console.log = originalConsoleLog;
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("ConfigManager.set updates nested keys without saving when save=false", () => {
	const { tempDir, configPath } = createTempConfigPath();
	fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2));

	try {
		const manager = new ConfigManager({ configPath, watch: false });
		const originalOnDisk = fs.readFileSync(configPath, "utf8");

		manager.set("download.maxParallel", 11, false);

		assert.equal(manager.get("download.maxParallel"), 11);
		assert.equal(fs.readFileSync(configPath, "utf8"), originalOnDisk);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
