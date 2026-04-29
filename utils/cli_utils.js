const paths = require("./paths");

const takeOptionValue = (args, optionName) => {
	const optionIndex = args.indexOf(optionName);
	if (optionIndex === -1) {
		return undefined;
	}

	const optionValue = args[optionIndex + 1];
	if (optionValue !== undefined && !optionValue.startsWith("--")) {
		args.splice(optionIndex, 2);
		return optionValue;
	}
	args.splice(optionIndex, 1);
	return undefined;
};

const parseRuntimeOptions = (args) => {
	const result = {
		root: takeOptionValue(args, "--root"),
		exportDir: takeOptionValue(args, "--export-dir"),
		configFile: takeOptionValue(args, "--config-file"),
		logsDir: takeOptionValue(args, "--logs-dir"),
	};
	paths.configure(result);
	return result;
};

module.exports = { takeOptionValue, parseRuntimeOptions };
