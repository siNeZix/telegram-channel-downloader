import esbuild from "esbuild";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));

esbuild
	.build({
		entryPoints: [resolve(projectRoot, "index.js")],
		bundle: true,
		platform: "node",
		target: "node22",
		format: "cjs",
		outfile: resolve(projectRoot, "dist", "bundle.js"),
		external: ["better-sqlite3"],
		define: {
			__PKG_VERSION__: JSON.stringify(pkg.version),
		},
		logLevel: "info",
	})
	.catch(() => process.exit(1));
