const fs = require("fs");
const path = require("path");

const ENV_KEYS = {
	root: "TGDL_RUNTIME_ROOT",
	export: "TGDL_EXPORT_DIR",
	config: "TGDL_CONFIG_FILE",
	logs: "TGDL_LOGS_DIR",
};

const resolvePath = (value) => path.resolve(value);

class PathsManager {
	constructor() {
		this.snapshots = "snapshots";
		this.reset();
	}

	resolveRootPath(...segments) {
		return path.join(this.root, ...segments);
	}

	configure(options = {}) {
		const nextRoot = options.root ? resolvePath(options.root) : this.root;
		this.root = nextRoot;
		this.export = options.exportDir
			? resolvePath(options.exportDir)
			: path.join(this.root, "export");
		this.config = options.configFile
			? resolvePath(options.configFile)
			: path.join(this.root, "config.json");
		this.logs = options.logsDir
			? resolvePath(options.logsDir)
			: path.join(this.root, "logs");
		this.lastSelection = path.join(this.export, "last_selection.json");
		this.dialogList = path.join(this.export, "dialog_list.json");
		this.rawDialogList = path.join(this.export, "raw_dialog_list.json");
		this.dialogListHtml = path.join(this.export, "dialog_list.html");
		return this;
	}

	reset() {
		const scriptRoot = path.resolve(__dirname, "..");
		const envRoot = process.env[ENV_KEYS.root];
		const envExportDir = process.env[ENV_KEYS.export];
		const envConfigFile = process.env[ENV_KEYS.config];
		const envLogsDir = process.env[ENV_KEYS.logs];

		return this.configure({
			root: envRoot || scriptRoot,
			exportDir: envExportDir,
			configFile: envConfigFile,
			logsDir: envLogsDir,
		});
	}

	getChannelExportPath(channelId, exportRoot = this.export) {
		return path.join(exportRoot, String(channelId));
	}

	getMediaPath(channelId, mediaType, exportRoot = this.export) {
		return path.join(this.getChannelExportPath(channelId, exportRoot), mediaType);
	}

	getChannelDbPath(channelId, exportRoot = this.export) {
		return path.join(this.getChannelExportPath(channelId, exportRoot), "messages.db");
	}

	getSnapshotsPath(channelId, exportRoot = this.export) {
		return path.join(this.getChannelExportPath(channelId, exportRoot), this.snapshots);
	}

	getRawMessagesPath(channelId, exportRoot = this.export) {
		return path.join(this.getChannelExportPath(channelId, exportRoot), "raw_message.json");
	}

	getProcessedMessagesPath(channelId, exportRoot = this.export) {
		return path.join(this.getChannelExportPath(channelId, exportRoot), "all_message.json");
	}

	getDialogListPath(exportRoot = this.export) {
		return path.join(exportRoot, "dialog_list.json");
	}

	getRawDialogListPath(exportRoot = this.export) {
		return path.join(exportRoot, "raw_dialog_list.json");
	}

	getDialogListHtmlPath(exportRoot = this.export) {
		return path.join(exportRoot, "dialog_list.html");
	}

	getTemplatePath(...segments) {
		return this.resolveRootPath("templates", ...segments);
	}

	ensureDir(dirPath) {
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}
	}

	getRuntimeConfig() {
		return {
			root: this.root,
			export: this.export,
			config: this.config,
			logs: this.logs,
			lastSelection: this.lastSelection,
			dialogList: this.dialogList,
			rawDialogList: this.rawDialogList,
			dialogListHtml: this.dialogListHtml,
		};
	}
}

module.exports = new PathsManager();
