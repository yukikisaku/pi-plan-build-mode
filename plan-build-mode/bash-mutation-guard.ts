type ShellToken =
	| { kind: "word"; value: string }
	| { kind: "control"; value: string }
	| { kind: "redirect"; value: string }
	| { kind: "heredoc"; value: string };

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
}

const ALWAYS_MUTATING_COMMANDS = new Set([
	"chmod",
	"chgrp",
	"chown",
	"cp",
	"install",
	"ln",
	"mkdir",
	"mkfifo",
	"mknod",
	"mv",
	"patch",
	"rm",
	"rmdir",
	"shred",
	"touch",
	"truncate",
	"unlink",
]);

const GIT_MUTATING_SUBCOMMANDS = new Set([
	"add",
	"am",
	"apply",
	"checkout",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"fetch",
	"gc",
	"init",
	"merge",
	"mv",
	"prune",
	"pull",
	"push",
	"rebase",
	"repack",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"switch",
]);

const CONTROL_OPERATORS = [";;&", "&&", "||", ";;", ";&", "|&", ";", "|", "&", "(", ")"];
const REDIRECT_PATTERN = /^(?:(?:\d+)?(?:<>|<<<|<<-?|<&|>&|<)|(?:\d+|&)?(?:>>|>\||>))/;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function lexShell(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	const pendingHeredocs: PendingHeredoc[] = [];
	let awaitingHeredocDelimiter: Pick<PendingHeredoc, "stripTabs"> | undefined;
	let word = "";
	let index = 0;

	const flushWord = () => {
		if (!word) return;
		tokens.push({ kind: "word", value: word });
		if (awaitingHeredocDelimiter) {
			pendingHeredocs.push({ delimiter: word, ...awaitingHeredocDelimiter });
			awaitingHeredocDelimiter = undefined;
		}
		word = "";
	};

	const consumeHeredocBodies = () => {
		for (const heredoc of pendingHeredocs) {
			let body = "";
			while (index < command.length) {
				const lineEnd = command.indexOf("\n", index);
				const hasNewline = lineEnd >= 0;
				const rawLine = command.slice(index, hasNewline ? lineEnd : command.length);
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				const comparableLine = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;

				if (comparableLine === heredoc.delimiter) {
					index = hasNewline ? lineEnd + 1 : command.length;
					break;
				}

				body += rawLine + (hasNewline ? "\n" : "");
				index = hasNewline ? lineEnd + 1 : command.length;
			}
			tokens.push({ kind: "heredoc", value: body });
		}
		pendingHeredocs.length = 0;
	};

	while (index < command.length) {
		const char = command[index];

		if (char === "'" || char === '"') {
			const quote = char;
			index += 1;
			while (index < command.length && command[index] !== quote) {
				if (quote === '"' && command[index] === "\\" && index + 1 < command.length) {
					word += command[index + 1];
					index += 2;
					continue;
				}
				word += command[index];
				index += 1;
			}
			if (command[index] === quote) index += 1;
			continue;
		}

		if (char === "\\" && index + 1 < command.length) {
			word += command[index + 1];
			index += 2;
			continue;
		}

		if (char === "\n") {
			flushWord();
			index += 1;
			if (pendingHeredocs.length > 0) consumeHeredocBodies();
			tokens.push({ kind: "control", value: ";" });
			continue;
		}

		if (/\s/.test(char)) {
			flushWord();
			index += 1;
			continue;
		}

		if (char === "#" && word.length === 0) {
			while (index < command.length && command[index] !== "\n") index += 1;
			continue;
		}

		if (command.startsWith("((", index)) {
			const arithmeticEnd = command.indexOf("))", index + 2);
			const end = arithmeticEnd >= 0 ? arithmeticEnd + 2 : command.length;
			word += command.slice(index, end);
			index = end;
			continue;
		}

		const redirectMatch = command.slice(index).match(REDIRECT_PATTERN);
		if (redirectMatch) {
			flushWord();
			const redirect = redirectMatch[0];
			tokens.push({ kind: "redirect", value: redirect });
			if (redirect === "<<" || redirect === "<<-") {
				awaitingHeredocDelimiter = { stripTabs: redirect === "<<-" };
			}
			index += redirect.length;
			continue;
		}

		const control = CONTROL_OPERATORS.find((operator) => command.startsWith(operator, index));
		if (control) {
			flushWord();
			tokens.push({ kind: "control", value: control });
			index += control.length;
			continue;
		}

		word += char;
		index += 1;
	}

	flushWord();
	return tokens;
}

function splitCommands(tokens: ShellToken[]): ShellToken[][] {
	const commands: ShellToken[][] = [];
	let current: ShellToken[] = [];

	for (const token of tokens) {
		if (token.kind !== "control") {
			current.push(token);
			continue;
		}
		if (current.length > 0) commands.push(current);
		current = [];
	}
	if (current.length > 0) commands.push(current);
	return commands;
}

function normalizeCommandName(value: string): string {
	const basename = value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? value.toLowerCase();
	return basename.replace(/\.(?:exe|cmd|bat)$/i, "");
}

function isInformationalInvocation(args: string[]): boolean {
	return args.some((arg) => arg === "--help" || arg === "--version");
}

function isSafeRedirectTarget(target: string | undefined): boolean {
	if (!target) return true;
	const normalized = target.toLowerCase();
	return (
		/^&(?:\d+|-)$/.test(normalized) ||
		["/dev/console", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "con", "nul"].includes(normalized) ||
		/^\/(?:dev\/fd|proc\/self\/fd)\/[012]$/.test(normalized)
	);
}

function outputRedirectReason(tokens: ShellToken[], commandName: string | undefined): string | undefined {
	if (commandName === "[[") return undefined;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind !== "redirect") continue;
		const opensForWriting = token.value.includes(">") && !token.value.startsWith("<");
		const opensReadWrite = token.value.includes("<>");
		if (!opensForWriting && !opensReadWrite) continue;

		const target = tokens[index + 1]?.kind === "word" ? tokens[index + 1].value : undefined;
		const duplicatesFileDescriptor = token.value.endsWith(">&") && /^\d+$/.test(target ?? "");
		if (!duplicatesFileDescriptor && !isSafeRedirectTarget(target)) {
			return `実ファイルへの出力リダイレクト (${token.value})`;
		}
	}
	return undefined;
}

function commandWords(tokens: ShellToken[]): string[] {
	const words: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind === "redirect") {
			if (tokens[index + 1]?.kind === "word") index += 1;
			continue;
		}
		if (token.kind === "word") words.push(token.value);
	}
	return words;
}

function stripCommandPrefixes(words: string[]): string[] {
	let index = 0;
	while (
		index < words.length &&
		(ASSIGNMENT_PATTERN.test(words[index]) || ["!", "{", "}", "do", "else", "elif", "if", "then", "time", "until", "while"].includes(words[index]))
	) {
		index += 1;
	}
	return words.slice(index);
}

function unwrapCommand(words: string[]): string[] {
	let current = stripCommandPrefixes(words);
	while (current.length > 1) {
		const command = normalizeCommandName(current[0]);
		if (command === "command" || command === "builtin" || command === "nohup") {
			let index = 1;
			while (current[index]?.startsWith("-")) index += 1;
			current = current.slice(index);
			continue;
		}
		if (command === "env") {
			let index = 1;
			while (current[index]?.startsWith("-") || ASSIGNMENT_PATTERN.test(current[index] ?? "")) index += 1;
			current = current.slice(index);
			continue;
		}
		if (command === "sudo") {
			const optionsWithValues = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u", "--chdir", "--chroot", "--close-from", "--command-timeout", "--group", "--host", "--prompt", "--user"]);
			let index = 1;
			while (index < current.length && current[index].startsWith("-")) {
				if (current[index] === "--") {
					index += 1;
					break;
				}
				index += optionsWithValues.has(current[index]) ? 2 : 1;
			}
			current = current.slice(index);
			continue;
		}
		break;
	}
	return current;
}

function shellReadsCommandsFromStdin(args: string[]): boolean {
	let stdinScript = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || /^-[^-]*c/.test(arg)) return false;
		if (arg === "-s" || /^-[^-]*s/.test(arg)) stdinScript = true;

		if (["-O", "-o", "--init-file", "--rcfile"].includes(arg)) {
			index += 1;
			continue;
		}
		if (arg.startsWith("--init-file=") || arg.startsWith("--rcfile=")) continue;
		if (arg === "--") return stdinScript || index === args.length - 1;
		if (!arg.startsWith("-")) return stdinScript;
	}
	return true;
}

function heredocMutationReason(tokens: ShellToken[], words: string[]): string | undefined {
	const bodies = tokens.filter((token) => token.kind === "heredoc").map((token) => token.value);
	if (bodies.length === 0) return undefined;

	const unwrapped = unwrapCommand(words);
	const command = normalizeCommandName(unwrapped[0] ?? "");
	const args = unwrapped.slice(1);
	if (!["bash", "dash", "ksh", "sh", "zsh"].includes(command) || !shellReadsCommandsFromStdin(args)) {
		return undefined;
	}

	for (const body of bodies) {
		const reason = findDefiniteBashMutation(body);
		if (reason) return `${command} heredoc: ${reason}`;
	}
	return undefined;
}

function gitSubcommand(args: string[]): { subcommand?: string; args: string[] } {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
			index += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			index += 1;
			continue;
		}
		return { subcommand: arg.toLowerCase(), args: args.slice(index + 1) };
	}
	return { args: [] };
}

function gitMutationReason(args: string[]): string | undefined {
	const parsed = gitSubcommand(args);
	const subcommand = parsed.subcommand;
	if (!subcommand) return undefined;
	if (GIT_MUTATING_SUBCOMMANDS.has(subcommand)) return `git ${subcommand}`;

	if (subcommand === "branch") {
		const mutationFlags = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy"]);
		if (parsed.args.some((arg) => mutationFlags.has(arg))) return "git branch の変更操作";
		const listMode = parsed.args.some((arg) =>
			[
				"-a",
				"-r",
				"--all",
				"--contains",
				"--format",
				"--list",
				"--merged",
				"--no-contains",
				"--no-merged",
				"--points-at",
				"--remotes",
				"--show-current",
				"--sort",
			].includes(arg),
		);
		if (!listMode && parsed.args.some((arg) => !arg.startsWith("-"))) return "git branch の作成";
	}

	if (subcommand === "tag") {
		const listMode = parsed.args.some((arg) =>
			["-l", "--column", "--contains", "--format", "--list", "--merged", "--no-contains", "--no-merged", "--points-at", "--sort"].includes(arg),
		);
		if (!listMode && parsed.args.some((arg) => !arg.startsWith("-"))) return "git tag の作成・変更";
		if (parsed.args.some((arg) => ["-d", "--delete", "-f", "--force"].includes(arg))) return "git tag の変更操作";
	}

	if (subcommand === "config") {
		if (parsed.args.some((arg) => ["--add", "--edit", "--rename-section", "--remove-section", "--replace-all", "--unset", "--unset-all"].includes(arg))) {
			return "git config の変更操作";
		}
		const readMode = parsed.args.some((arg) => ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "--show-origin", "--show-scope"].includes(arg));
		const values = parsed.args.filter((arg) => !arg.startsWith("-"));
		if (!readMode && values.length >= 2) return "git config の設定変更";
	}

	if (subcommand === "bisect" && ![undefined, "log", "view"].includes(parsed.args[0])) {
		return `git bisect ${parsed.args[0]}`;
	}
	if (subcommand === "notes" && ["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(parsed.args[0])) {
		return `git notes ${parsed.args[0]}`;
	}
	if (subcommand === "reflog" && ["delete", "expire"].includes(parsed.args[0])) {
		return `git reflog ${parsed.args[0]}`;
	}

	if (subcommand === "remote" && ["add", "remove", "rename", "set-branches", "set-head", "set-url", "prune", "update"].includes(parsed.args[0])) {
		return `git remote ${parsed.args[0]}`;
	}
	if (subcommand === "worktree" && ["add", "lock", "move", "prune", "remove", "repair", "unlock"].includes(parsed.args[0])) {
		return `git worktree ${parsed.args[0]}`;
	}
	return undefined;
}

function packageMutationReason(command: string, args: string[]): string | undefined {
	const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
	if (!subcommand) return undefined;

	const blocked: Record<string, Set<string>> = {
		apt: new Set(["autoremove", "full-upgrade", "install", "purge", "remove", "update", "upgrade"]),
		"apt-get": new Set(["autoremove", "dist-upgrade", "install", "purge", "remove", "update", "upgrade"]),
		dnf: new Set(["autoremove", "downgrade", "install", "reinstall", "remove", "update", "upgrade"]),
		npm: new Set(["ci", "install", "link", "publish", "uninstall", "unlink", "update"]),
		pnpm: new Set(["add", "deploy", "import", "install", "link", "publish", "remove", "uninstall", "unlink", "update"]),
		yarn: new Set(["add", "install", "link", "publish", "remove", "set", "unlink", "upgrade"]),
		yum: new Set(["autoremove", "downgrade", "install", "reinstall", "remove", "update", "upgrade"]),
		pip: new Set(["install", "uninstall"]),
		pip3: new Set(["install", "uninstall"]),
		brew: new Set(["install", "link", "reinstall", "tap", "uninstall", "unlink", "untap", "update", "upgrade"]),
	};
	return blocked[command]?.has(subcommand) ? `${command} ${subcommand}` : undefined;
}

function isZeroSignalInvocation(args: string[]): boolean {
	const isZeroSignal = (value: string | undefined) => value?.toUpperCase() === "0" || value?.toUpperCase() === "SIG0";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-0" || arg.toUpperCase() === "-SIG0") return true;
		if (["-s", "-n", "--signal"].includes(arg) && isZeroSignal(args[index + 1])) return true;
		if (arg.startsWith("--signal=") && isZeroSignal(arg.slice("--signal=".length))) return true;
	}
	return false;
}

function analyzeWords(words: string[]): string | undefined {
	const prefixed = stripCommandPrefixes(words);
	if (
		normalizeCommandName(prefixed[0] ?? "") === "command" &&
		prefixed.slice(1).some((arg) => arg === "-v" || arg === "-V")
	) {
		return undefined;
	}

	const unwrapped = unwrapCommand(words);
	if (unwrapped.length === 0) return undefined;

	const command = normalizeCommandName(unwrapped[0]);
	const args = unwrapped.slice(1);
	if (isInformationalInvocation(args)) return undefined;

	if (ALWAYS_MUTATING_COMMANDS.has(command)) {
		if (command === "patch" && args.includes("--dry-run")) return undefined;
		if (command !== "patch" && !args.some((arg) => !arg.startsWith("-"))) return undefined;
		return command;
	}
	if (command === "sed" && args.some((arg) => arg === "--in-place" || /^-i(?:.+)?$/.test(arg))) return "sed -i";
	if (
		command === "perl" &&
		args.some((arg) => arg === "-i" || arg.startsWith("-i.") || /^-[pwnlaF0-9]*i[A-Za-z]*$/.test(arg))
	) {
		return "perl -i";
	}
	if (command === "tee") {
		const destinations = args.filter((arg) => !arg.startsWith("-"));
		if (destinations.some((target) => !isSafeRedirectTarget(target))) return "tee によるファイル出力";
	}
	if (command === "dd") {
		const output = args.find((arg) => arg.startsWith("of="))?.slice(3);
		if (output && !isSafeRedirectTarget(output)) return "dd の of= 出力";
	}
	if (command === "find") {
		if (args.includes("-delete")) return "find -delete";
		for (const marker of ["-exec", "-execdir", "-ok", "-okdir"]) {
			const index = args.indexOf(marker);
			if (index >= 0) {
				const nestedReason = analyzeWords(args.slice(index + 1).filter((arg) => arg !== ";" && arg !== "+"));
				if (nestedReason) return `find ${marker}: ${nestedReason}`;
			}
		}
	}
	if (command === "curl") {
		for (let index = 0; index < args.length; index += 1) {
			const arg = args[index];
			if (arg === "-O" || arg === "--remote-name" || /^-[^-]*O/.test(arg)) return "curl のファイル出力";
			if (arg === "-o" || arg === "--output" || /^-[^-]*o$/.test(arg)) {
				const target = args[index + 1];
				if (target !== "-" && !isSafeRedirectTarget(target)) return "curl のファイル出力";
			}
			if (arg.startsWith("--output=")) {
				const target = arg.slice("--output=".length);
				if (target !== "-" && !isSafeRedirectTarget(target)) return "curl のファイル出力";
			}
			if (/^-o.+/.test(arg)) {
				const target = arg.slice(2);
				if (target !== "-" && !isSafeRedirectTarget(target)) return "curl のファイル出力";
			}
		}
	}
	if (["bash", "dash", "ksh", "sh", "zsh"].includes(command)) {
		const scriptIndex = args.findIndex((arg) => arg === "-c" || /^-[^-]*c/.test(arg));
		if (scriptIndex >= 0 && args[scriptIndex + 1]) return findDefiniteBashMutation(args[scriptIndex + 1]);
	}
	if (command === "eval" && args.length > 0) return findDefiniteBashMutation(args.join(" "));
	if (command === "xargs") {
		const optionsWithValues = new Set(["-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--process-slot-var", "--replace"]);
		let index = 0;
		while (index < args.length && args[index].startsWith("-")) {
			if (args[index] === "--") {
				index += 1;
				break;
			}
			index += optionsWithValues.has(args[index]) ? 2 : 1;
		}
		const nestedCommand = args.slice(index);
		return nestedCommand.length > 0 ? analyzeWords([...nestedCommand, "__xargs_input__"]) : undefined;
	}
	if (command === "git") return gitMutationReason(args);
	if (command === "systemctl" && args.some((arg) => ["disable", "enable", "mask", "reload", "restart", "start", "stop", "unmask"].includes(arg))) {
		return "systemctl の変更操作";
	}
	if (["reboot", "shutdown"].includes(command)) return command;
	if (["kill", "killall", "pkill"].includes(command)) {
		if (isZeroSignalInvocation(args)) return undefined;
		if (args.some((arg) => !arg.startsWith("-"))) return command;
	}

	return packageMutationReason(command, args);
}

/**
 * bash のうっかり変更を止めるため、明確に変更を行う操作だけを検出する。
 * 1つでも禁止条件に一致すると複合コマンドを含むツール呼び出し全体が失敗する。
 * 調査用コマンドを不必要に妨げないよう、曖昧な操作や単なる禁止語の出現はブロックしない。
 */
export function findDefiniteBashMutation(command: string): string | undefined {
	for (const tokens of splitCommands(lexShell(command))) {
		const words = commandWords(tokens);
		const commandName = normalizeCommandName(stripCommandPrefixes(words)[0] ?? "");
		const redirectReason = outputRedirectReason(tokens, commandName);
		if (redirectReason) return redirectReason;

		const commandReason = analyzeWords(words);
		if (commandReason) return commandReason;

		const heredocReason = heredocMutationReason(tokens, words);
		if (heredocReason) return heredocReason;
	}
	return undefined;
}
