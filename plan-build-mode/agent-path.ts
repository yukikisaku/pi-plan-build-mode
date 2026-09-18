import { isAbsolute, join, resolve } from "node:path";

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
	const home = env.HOME?.trim();
	if (home) {
		if (!isAbsolute(home)) {
			throw new Error("HOME must be an absolute path.");
		}
		return home;
	}

	const userProfile = env.USERPROFILE?.trim();
	if (userProfile) {
		if (!isAbsolute(userProfile)) {
			throw new Error("USERPROFILE must be an absolute path.");
		}
		return userProfile;
	}

	throw new Error(
		"Pi agent directory could not be resolved. Set PI_CODING_AGENT_DIR, HOME, or USERPROFILE.",
	);
}

/** Piのグローバル設定ディレクトリをOSに依存しない形で解決する。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(resolveHomeDir(env), ".pi", "agent");
	if (configured === "~") return resolveHomeDir(env);
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return join(resolveHomeDir(env), configured.slice(2));
	}
	return isAbsolute(configured) ? configured : resolve(configured);
}
