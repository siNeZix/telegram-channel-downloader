const fs = require("fs");
const path = require("path");
const { logMessage } = require("./helper");
const paths = require("./paths");

const getConfigFile = () => paths.config;
const getLastSelectionFile = () => paths.lastSelection;

const ensureParentDir = (filePath) => {
	const dirPath = path.dirname(filePath);
	paths.ensureDir(dirPath);
};

const updateCredentials = (obj) => {
	try {
		const configFile = getConfigFile();
		ensureParentDir(configFile);
		let credentials = {};
		try {
			const data = fs.readFileSync(configFile, "utf8");
			const trimmed = data.trim();
			credentials = trimmed === "" ? {} : JSON.parse(trimmed);
		} catch (readErr) {
			if (readErr.code !== "ENOENT") {
				throw readErr;
			}
		}
		credentials = { ...credentials, ...obj };
		// Atomic write (temp + rename) so a crash mid-write cannot corrupt config.
		const tempFile = `${configFile}.tmp`;
		fs.writeFileSync(tempFile, JSON.stringify(credentials, null, 4), "utf8");
		fs.renameSync(tempFile, configFile);
		logMessage.info("Credentials updated successfully");
	} catch (err) {
		logMessage.error(err?.message || String(err));
	}
};

const getCredentials = () => {
	try {
		const configFile = getConfigFile();
		const data = fs.readFileSync(configFile, "utf8");
		const credentials = JSON.parse(data);
		return credentials;
	} catch (err) {
		throw new Error(
			"Please add your credentials in config.json file, follow https://github.com/siNeZix/telegram-channel-downloader#setup for more info",
		);
	}
};

const getLastSelection = () => {
	try {
		const lastSelectionFile = getLastSelectionFile();
		const data = fs.readFileSync(lastSelectionFile, "utf8");
		const last = JSON.parse(data);
		return last;
	} catch (err) {
		return {};
	}
};

const updateLastSelection = (object) => {
	try {
		const lastSelectionFile = getLastSelectionFile();
		ensureParentDir(lastSelectionFile);
		let last = getLastSelection();
		last = {
			...last,
			...object,
		};

		const tempFile = `${lastSelectionFile}.tmp`;
		fs.writeFileSync(tempFile, JSON.stringify(last, null, 2), "utf8");
		fs.renameSync(tempFile, lastSelectionFile);
		logMessage.debug("Last selection updated");
	} catch (err) {
		logMessage.error(err?.message || String(err));
	}
};

module.exports = {
	updateCredentials,
	getLastSelection,
	updateLastSelection,
	getCredentials,
};
