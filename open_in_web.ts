#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read
// open_in_web.ts
// Version: 1.1.0

interface CommandOutput {
	stdout: string;
	stderr: string;
	code: number;
	success: boolean;
}

// --- Logger Utility ---
enum LogLevel {
	INFO = "INFO",
	WARN = "WARN",
	ERROR = "ERROR",
	SUCCESS = "SUCCESS",
	DEBUG = "DEBUG", // For general logging like "Opening URL"
	LOG = "LOG", // For direct console output like help text
}

const LOG_PREFIXES: { [key in LogLevel]: string } = {
	[LogLevel.INFO]: "ℹ️",
	[LogLevel.WARN]: "⚠️",
	[LogLevel.ERROR]: "❌",
	[LogLevel.SUCCESS]: "✅",
	[LogLevel.DEBUG]: "🌐",
	[LogLevel.LOG]: "", // No prefix for direct logs
};

export class Logger {
	/**
	 * Core private static logging function.
	 * @param level - The level of the log.
	 * @param messages - Messages to log.
	 */
	private static _log(level: LogLevel, ...messages: unknown[]): void {
		const prefix = LOG_PREFIXES[level]; // Handle different types for messages more robustly
		const messageStr = messages
			.map((msg) => {
				if (typeof msg === "string") return msg;
				if (msg instanceof Error) return msg.message; // Get message from Error objects
				try {
					// Attempt to stringify; handle potential circular references or other errors
					return JSON.stringify(
						msg,
						(_, value) =>
							typeof value === "bigint" ? value.toString() + "n" : value, // Example: handle BigInt
					);
				} catch {
					// Fallback for unstringifiable objects (e.g., complex objects, functions)
					return String(msg);
				}
			})
			.join(" ");

		const fullMessage = prefix ? `${prefix} ${messageStr}` : messageStr;

		switch (level) {
			case LogLevel.ERROR:
				console.error(fullMessage);
				break;
			case LogLevel.WARN:
				console.warn(fullMessage);
				break;
			case LogLevel.INFO:
			case LogLevel.SUCCESS:
			case LogLevel.DEBUG:
				console.info(fullMessage); // console.debug is often an alias for console.info or console.log
				break;
			case LogLevel.LOG:
				console.log(fullMessage); // For help text, no prefix, direct log
				break;
			default: // Fallback for any unknown levels, though LogLevel enum should prevent this.
				console.log(`[${level}] ${fullMessage}`);
		}
	} /** Logs an informational message. */

	public static info(...messages: unknown[]): void {
		this._log(LogLevel.INFO, ...messages);
	} /** Logs a warning message. */

	public static warn(...messages: unknown[]): void {
		this._log(LogLevel.WARN, ...messages);
	} /** Logs an error message. */

	public static error(...messages: unknown[]): void {
		this._log(LogLevel.ERROR, ...messages);
	} /** Logs a success message. */

	public static success(...messages: unknown[]): void {
		this._log(LogLevel.SUCCESS, ...messages);
	} /** Logs a debug message. */

	public static debug(...messages: unknown[]): void {
		this._log(LogLevel.DEBUG, ...messages);
	} /** Logs a general message directly to the console (typically without prefix). */

	public static log(...messages: unknown[]): void {
		// For direct output
		this._log(LogLevel.LOG, ...messages);
	}
}
// --- End Logger Utility ---

/**
 * Finds the start and end line/column of a given text selection within a file.
 * @param filePath Path to the file.
 * @param selection The text selection to find.
 * @param hintLine An optional 1-based line number to start searching near.
 * @returns An object with 1-based startLine, startColumn, endLine, endColumn, or null if not found.
 */
export async function getSelectionPosition(
	filePath: string,
	selection: string,
	hintLine?: number, // 1-based
): Promise<{
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
} | null> {
	const decoder = new TextDecoder("utf-8");
	const content = decoder
		.decode(await Deno.readFile(filePath))
		.replace(/\r\n/g, "\n");
	const fileLines = content.split("\n");
	const selectionLines = selection.replace(/\r\n/g, "\n").split("\n");
	const selLen = selectionLines.length;

	const matchesAt = (lineIdx: number): boolean => {
		if (lineIdx < 0 || lineIdx + selLen > fileLines.length) return false;
		for (let i = 0; i < selLen; i++) {
			// Check if the file line *includes* the corresponding selection line.
			// This allows selection lines to be substrings of file lines if the selection is not perfectly aligned.
			if (!fileLines[lineIdx + i].includes(selectionLines[i])) return false;
		}
		return true;
	};

	const findColumn = (line: string, target: string): number => {
		const col = line.indexOf(target);
		return col === -1 ? -1 : col + 1; // 1-based column
	}; // Core search logic

	let matchStartLine: number | null = null; // 1-based

	const scan = (startLineIndex: number, direction: "up" | "down") => {
		const step = direction === "up" ? -1 : 1; // Adjust loop bounds for multi-line selections
		for (
			let currentLineIndex = startLineIndex;
			direction === "up"
				? currentLineIndex >= 0
				: currentLineIndex <= fileLines.length - selLen;
			currentLineIndex += step
		) {
			if (matchesAt(currentLineIndex)) {
				matchStartLine = currentLineIndex + 1; // Convert 0-based index to 1-based line number
				break;
			}
		}
	};

	if (hintLine != null && hintLine > 0 && hintLine <= fileLines.length) {
		const zeroBasedHintLine = hintLine - 1; // Scan down from hint (inclusive of hint line itself for the start of a multi-line match)
		scan(zeroBasedHintLine, "down"); // If not found, scan up from just before the hint line
		if (matchStartLine === null) {
			scan(zeroBasedHintLine - 1, "up");
		}
	} // Fallback: full scan if no match found around hint or no hint provided

	if (matchStartLine === null) {
		scan(0, "down"); // Scan from the beginning of the file
	}

	if (matchStartLine === null) return null; // Selection not found

	const actualStartLineIndex = matchStartLine - 1; // Convert back to 0-based for array access
	const actualEndLineIndex = actualStartLineIndex + selLen - 1;

	const startColumn = findColumn(
		fileLines[actualStartLineIndex],
		selectionLines[0],
	); // For endColumn, find the column of the last line of selection within the corresponding file line
	const endColumnOfLastSelectionLineStart = findColumn(
		fileLines[actualEndLineIndex],
		selectionLines[selectionLines.length - 1],
	);

	if (startColumn === -1 || endColumnOfLastSelectionLineStart === -1) {
		// This case should ideally not be hit if matchesAt returned true,
		// but as a safeguard if selectionLines[i] was empty or logic changes.
		Logger.warn(
			"Could not determine column for selection, though lines matched.",
		);
		return null;
	} // Calculate the end column based on the start of the last selection line and its length

	const endColumn =
		endColumnOfLastSelectionLineStart +
		selectionLines[selectionLines.length - 1].length -
		1;

	return {
		startLine: matchStartLine, // 1-based
		startColumn, // 1-based
		endLine: actualEndLineIndex + 1, // 1-based
		endColumn, // 1-based
	};
}

/**
 * Utility to run shell commands and get stdout, stderr, and exit code.
 */
export async function runCommand(
	cmd: string[],
	options?: { ignoreExitCode?: boolean },
): Promise<CommandOutput> {
	// Deno.Command is the modern API for running subprocesses
	const command = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdout: "piped",
		stderr: "piped",
	});
	const { code, stdout, stderr } = await command.output();
	const stdoutStr = new TextDecoder().decode(stdout).trim();
	const stderrStr = new TextDecoder().decode(stderr).trim();

	if (!options?.ignoreExitCode && code !== 0) {
		let errorMessage = `Command "${cmd.join(" ")}" failed with code ${code}.`;
		if (stderrStr) {
			errorMessage += `\nStderr: ${stderrStr}`;
		}
		Logger.error(errorMessage);
		Deno.exit(code); // Exit if command fails and not ignored
	}
	return {
		stdout: stdoutStr,
		stderr: stderrStr,
		code,
		success: code === 0,
	};
}

/**
 * Determines the command to open a URL based on the OS.
 */
export function getOpenCommandName(os = Deno.build.os): string {
	switch (os) {
		case "darwin":
			return "open"; // macOS
		case "linux":
			return "xdg-open"; // Linux
		case "windows":
			return "start"; // Windows
		default:
			Logger.error("Unsupported OS for opening URL automatically.");
			return ""; // Return empty string if OS not supported
	}
}

/**
 * Normalizes a Git remote URL to a base HTTPS URL.
 * Handles common formats like git@, ssh://, and http://.
 */
export function normalizeRemoteUrl(remoteUrlStr: string): string {
	let tempUrl = remoteUrlStr.replace(/(\.git\/?)$/, ""); // Convert git@host:path/repo to https://host/path/repo

	if (tempUrl.startsWith("git@")) {
		tempUrl = `https://${tempUrl.substring(4).replace(":", "/")}`;
	} else if (tempUrl.startsWith("ssh://")) {
		// Attempt to parse ssh:// URLs, including those with ports or different user info
		try {
			const parsed = new URL(tempUrl); // Standard URL parsing
			if (parsed.protocol === "ssh:") {
				parsed.protocol = "https:";
				parsed.username = ""; // Clear username/password/port
				parsed.password = "";
				parsed.port = "";
				tempUrl = parsed.toString();
			}
		} catch (_e) {
			// Fallback for complex SSH URLs not parsed by new URL()
			// e.g., ssh://git@gitlab.com:2222/group/project
			const sshRegex = /ssh:\/\/(?:[^@]+@)?([^:/]+)(?::\d+)?[:/](.+)/;
			const match = tempUrl.match(sshRegex);
			if (match && match[1] && match[2]) {
				tempUrl = `https://${match[1]}/${match[2]}`; // Construct HTTPS URL
				Logger.warn(
					`Used regex fallback for SSH URL normalization: ${tempUrl}`,
				);
			} else {
				throw new Error(`Failed to parse SSH URL '${tempUrl}'.`);
			}
		}
	} // Convert http:// to https://

	if (tempUrl.startsWith("http://")) {
		tempUrl = `https://${tempUrl.substring(7)}`;
	} // Final validation and cleanup

	try {
		const finalParsedUrl = new URL(tempUrl);
		if (finalParsedUrl.protocol !== "https:") {
			throw new Error(
				`URL scheme is '${finalParsedUrl.protocol}' not 'https:'.`,
			);
		} // Remove trailing slash from pathname if it's not the root itself
		if (
			finalParsedUrl.pathname !== "/" &&
			finalParsedUrl.pathname.endsWith("/")
		) {
			finalParsedUrl.pathname = finalParsedUrl.pathname.slice(0, -1);
		}
		return finalParsedUrl.toString();
	} catch (e) {
		const originalError = e instanceof Error ? e.message : String(e);
		throw new Error(
			`Failed to parse normalized URL '${tempUrl}' (from '${remoteUrlStr}'). Error: ${originalError}`,
		);
	}
}

/**
 * Gets the default branch name from the 'origin' remote.
 * Tries 'origin/HEAD' first, then 'symbolic-ref', then falls back to 'main'.
 */
export async function getDefaultBranchName(): Promise<string> {
	try {
		// Attempt 1: Get default branch from 'origin/HEAD' directly
		const { stdout, success } = await runCommand(
			["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
			{ ignoreExitCode: true }, // Ignore exit code as this might fail
		); // If successful and not 'origin/HEAD' (which means it's not set or ambiguous)
		if (success && stdout && stdout !== "origin/HEAD") {
			return stdout.replace(/^origin\//, ""); // Remove 'origin/' prefix
		} else {
			// Attempt 2: Try 'git symbolic-ref refs/remotes/origin/HEAD'
			Logger.warn(
				"Could not determine default branch directly from origin/HEAD. Trying 'symbolic-ref'.",
			);
			const symbolicRefResult = await runCommand(
				["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
				{
					ignoreExitCode: true,
				},
			);
			if (symbolicRefResult.success && symbolicRefResult.stdout) {
				const refParts = symbolicRefResult.stdout.split("/"); // e.g., refs/remotes/origin/main
				const branchName = refParts[refParts.length - 1];
				if (branchName) return branchName;
			} // Fallback: If both attempts fail, log a warning and default to 'main'.
			Logger.warn(
				"Still could not determine default branch. Falling back to 'main'. This might be incorrect.",
			);
			return "main";
		}
	} catch (error) {
		// Catch any errors during the process and fallback.
		Logger.warn(
			`Error trying to determine default branch: ${error instanceof Error ? error.message : String(error)}. Falling back to 'main'.`,
		);
		return "main";
	}
}

function displayHelp() {
	Logger.log(`Deno Script: Open Repository File in Web UI
Version: 1.1.0
Author: AI

Opens a file from a Git repository in the provider's web UI (GitHub, GitLab, Bitbucket).
If no arguments are provided, opens the repository root.

Usage:
  open_in_web.ts [OPTIONS] [FILE_PATH]

Options:
  -h, --help                 Show this help message.
  -b, --branch <branch_name> Specify a branch name to use.
  -d, --default-branch       Use the repository's default branch (from origin). Overrides -b.
  -L, --line-start <number>  Specify the starting line number (1-indexed).
  -E, --line-end <number>    Specify the ending line number (1-indexed).
  -s, --selection <text>     Specify a text selection within FILE_PATH to determine line range.
                             If FILE_PATH is provided, this will attempt to find the selection.
                             The --line-start option can be used as a hint for the search.
                             This overrides --line-start/--line-end if selection is found.

Arguments:
  FILE_PATH     Optional path to the file within the repository (e.g., src/main.ts)

Examples:
  # Open repository root of the current branch
  open_in_web.ts

  # Open repository root of the default branch
  open_in_web.ts --default-branch

  # Open repository root of a specific branch 'develop'
  open_in_web.ts --branch develop

  # Open a file on the default branch
  open_in_web.ts -d README.md

  # Open a file on a specific branch 'feature/foo' with line numbers
  open_in_web.ts -b feature/foo src/main.ts --line-start 42 --line-end 50

  # Open a file with a specific text selection (searches from the start of the file)
  open_in_web.ts src/utils.ts -s "class MyClass"

  # Open a file with a specific text selection, hinting to search around line 10
  open_in_web.ts src/utils.ts --line-start 10 -s "const myVar"
`);
	Deno.exit(0); // Exit after displaying help
}

/**
 * Main application logic.
 */
export async function main() {
	const rawArgs = [...Deno.args]; // Get command line arguments
	let branchFromArg: string | undefined;
	let useDefaultBranch = false;
	let selectionTextFromArg: string | undefined;
	let parsedLineStart: number | undefined;
	let parsedLineEnd: number | undefined;
	const positionalArgs: string[] = []; // For FILE_PATH
	// Early check for help flag

	if (rawArgs.includes("-h") || rawArgs.includes("--help")) {
		displayHelp();
	} // Parse named arguments

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--branch" || arg === "-b") {
			if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
				branchFromArg = rawArgs[i + 1];
				i++;
			} else {
				Logger.error(`Branch name missing after ${arg} flag.`);
				displayHelp();
			}
		} else if (arg === "--default-branch" || arg === "-d") {
			useDefaultBranch = true;
		} else if (arg === "--selection" || arg === "-s") {
			if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
				selectionTextFromArg = rawArgs[i + 1];
				if (selectionTextFromArg.trim().length === 0) {
					Logger.error(`Selection text missing after ${arg} flag.`);
					selectionTextFromArg = undefined;
				}
				i++;
			} else {
				Logger.error(`Selection text missing after ${arg} flag.`);
				displayHelp();
			}
		} else if (arg === "--line-start" || arg === "-L") {
			if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
				parsedLineStart = parseInt(rawArgs[i + 1], 10);
				if (isNaN(parsedLineStart) || parsedLineStart <= 0) {
					Logger.error(`Value for ${arg} must be a positive number.`);
					Deno.exit(1);
				}
				i++;
			} else {
				Logger.error(`Line number missing after ${arg} flag.`);
				displayHelp();
			}
		} else if (arg === "--line-end" || arg === "-E") {
			if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
				parsedLineEnd = parseInt(rawArgs[i + 1], 10);
				if (isNaN(parsedLineEnd) || parsedLineEnd <= 0) {
					Logger.error(`Value for ${arg} must be a positive number.`);
					Deno.exit(1);
				}
				i++;
			} else {
				Logger.error(`Line number missing after ${arg} flag.`);
				displayHelp();
			}
		} else {
			positionalArgs.push(arg);
		}
	} // Assign positional argument

	const filePath: string | undefined = positionalArgs[0];
	if (positionalArgs.length > 1) {
		Logger.error("Too many file path arguments provided. Only one is allowed.");
		displayHelp();
	} // Validate line number arguments

	if (parsedLineEnd != null && parsedLineStart == null) {
		Logger.error(
			"--line-end can only be used if --line-start is also provided.",
		);
		Deno.exit(1);
	}
	if (
		parsedLineStart != null &&
		parsedLineEnd != null &&
		parsedLineEnd < parsedLineStart
	) {
		Logger.error(
			`--line-end (${parsedLineEnd}) must be >= --line-start (${parsedLineStart}).`,
		);
		Deno.exit(1);
	} // These will be the final line numbers used for URL construction

	let finalLineStart: number | undefined = parsedLineStart;
	let finalLineEnd: number | undefined = parsedLineEnd; // If selection argument is provided, try to find it and override line numbers

	if (selectionTextFromArg != null) {
		if (!filePath) {
			Logger.error("--selection flag requires a FILE_PATH to be specified.");
			Deno.exit(1);
		}
		Logger.info(`Attempting to find selection in file: ${filePath}`);
		try {
			// Use parsedLineStart (from --line-start option) as a hint if available
			const selectionRange = await getSelectionPosition(
				filePath,
				selectionTextFromArg,
				parsedLineStart,
			);

			if (selectionRange) {
				Logger.success(
					`Selection found: lines ${selectionRange.startLine}-${selectionRange.endLine}, cols ${selectionRange.startColumn}-${selectionRange.endColumn}`,
				);
				finalLineStart = selectionRange.startLine;
				finalLineEnd = selectionRange.endLine;
			} else {
				Logger.error(`Selection text not found in file: ${filePath}`);
				Deno.exit(1); // Exit if selection is specified but not found
			}
		} catch (e) {
			Logger.error(
				`Error reading or processing file for selection: ${filePath}`,
			);
			Logger.error(e instanceof Error ? e.message : String(e));
			Deno.exit(1);
		}
	} else {
		// If no selection, validate that line numbers (if provided) require filePath
		if (finalLineStart != null && filePath === undefined) {
			Logger.error(
				"--line-start can only be used if a <file_path> is also provided.",
			);
			Deno.exit(1);
		}
	} // Determine Git remote URL

	let remoteUrlRaw: string;
	try {
		const originResult = await runCommand(
			["git", "remote", "get-url", "origin"],
			{ ignoreExitCode: true },
		);
		if (originResult.success && originResult.stdout) {
			remoteUrlRaw = originResult.stdout;
		} else {
			Logger.warn(
				"Remote 'origin' not found. Trying first available remote...",
			);
			const remotesResult = await runCommand(["git", "remote"], {
				ignoreExitCode: true,
			});
			if (!remotesResult.success || !remotesResult.stdout) {
				Logger.error("Not a Git repository or no remotes found.");
				Deno.exit(1);
			}
			const firstRemoteName = remotesResult.stdout.split("\n")[0]?.trim();
			if (!firstRemoteName) {
				Logger.error("No git remotes configured.");
				Deno.exit(1);
			}
			Logger.info(`Using remote: '${firstRemoteName}'.`);
			const firstRemoteUrlResult = await runCommand([
				"git",
				"remote",
				"get-url",
				firstRemoteName,
			]);
			remoteUrlRaw = firstRemoteUrlResult.stdout;
		}
	} catch (error) {
		Logger.error(
			"Failed to get remote URL:",
			error instanceof Error ? error.message : String(error),
		);
		Deno.exit(1);
	} // Normalize the remote URL to a base HTTPS URL

	const baseRepoUrlStr = normalizeRemoteUrl(remoteUrlRaw); // Determine the branch or commit to use

	let branchOrCommit: string;
	if (useDefaultBranch) {
		branchOrCommit = await getDefaultBranchName();
		Logger.info(`Using default remote branch: '${branchOrCommit}'`);
	} else if (branchFromArg) {
		branchOrCommit = branchFromArg;
		Logger.info(`Using specified branch: '${branchOrCommit}'`);
	} else {
		// Get current branch or commit SHA if in detached HEAD
		let { stdout: detectedBranch, success: branchSuccess } = await runCommand([
			"git",
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		if (!branchSuccess) {
			Logger.error("Failed to detect current branch or commit.");
			Deno.exit(1);
		}
		if (detectedBranch === "HEAD") {
			// Detached HEAD state
			Logger.info("Detached HEAD state. Using full commit SHA.");
			({ stdout: detectedBranch } = await runCommand([
				"git",
				"rev-parse",
				"HEAD",
			])); // Get full SHA
		}
		branchOrCommit = detectedBranch;
		Logger.info(`Using current branch/commit: '${branchOrCommit}'`);
	} // Construct the final URL

	const baseRepoUrlParsed = new URL(baseRepoUrlStr);
	const providerHostname = baseRepoUrlParsed.hostname;
	let finalUrlToOpen = baseRepoUrlStr; // Default to repo root

	if (filePath) {
		// Encode each segment of the file path
		const filePathEncoded = filePath
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		let pathSegment = "";
		let fragment = ""; // For line numbers (e.g., #L10-L20)
		// Construct line number fragment based on provider, using finalLineStart and finalLineEnd

		if (finalLineStart != null) {
			const lineStartStr = finalLineStart.toString();
			if (
				providerHostname.includes("github.com") ||
				providerHostname.includes("gitlab.com")
			) {
				fragment =
					finalLineEnd != null
						? `#L${lineStartStr}-L${finalLineEnd}`
						: `#L${lineStartStr}`;
			} else if (providerHostname.includes("bitbucket.org")) {
				fragment =
					finalLineEnd != null
						? `#lines-${lineStartStr}:${finalLineEnd}`
						: `#lines-${lineStartStr}`;
			}
		} // Construct path segment based on provider

		if (providerHostname.includes("github.com")) {
			pathSegment = `/blob/${branchOrCommit}/${filePathEncoded}`;
		} else if (providerHostname.includes("gitlab.com")) {
			pathSegment = `/-/blob/${branchOrCommit}/${filePathEncoded}`;
		} else if (providerHostname.includes("bitbucket.org")) {
			pathSegment = `/src/${branchOrCommit}/${filePathEncoded}`;
		} else {
			Logger.error(
				`Unsupported provider at host '${providerHostname}'. Cannot construct file URL.`,
			);
			Deno.exit(1);
		}
		finalUrlToOpen = `${baseRepoUrlStr}${pathSegment}${fragment}`;
	} else if (useDefaultBranch || branchFromArg) {
		// If a specific branch is requested (default or via -b) but no file, open the tree for that branch
		let branchRootPath = `/tree/${branchOrCommit}`; // GitHub default
		if (providerHostname.includes("gitlab.com")) {
			branchRootPath = `/-/tree/${branchOrCommit}`;
		} else if (providerHostname.includes("bitbucket.org")) {
			branchRootPath = `/src/${branchOrCommit}`; // Bitbucket uses /src/ for branch root
		}
		finalUrlToOpen = `${baseRepoUrlStr}${branchRootPath}`;
	} // If no file and no specific branch request, finalUrlToOpen remains baseRepoUrlStr (repo root of current branch).
	Logger.debug(`Opening: ${finalUrlToOpen}`);
	const openCmdName = getOpenCommandName();

	if (openCmdName) {
		// Adjust arguments for 'start' command on Windows
		const argsForOpen =
			Deno.build.os === "windows" && openCmdName === "start"
				? ["", finalUrlToOpen] // "start" needs an empty title argument for URLs
				: [finalUrlToOpen];

		const openCmd = new Deno.Command(openCmdName, {
			args: argsForOpen,
			stdout: "piped",
			stderr: "piped",
		});
		const { code, stderr: openErrorBytes } = await openCmd.output();

		if (code !== 0) {
			const errorMsg = new TextDecoder().decode(openErrorBytes).trim();
			Logger.error(
				`Error opening URL via ${openCmdName}: ${errorMsg || `(code: ${code})`}`,
			); // Retry for Windows "start" command with 'cmd /c start "" "URL"'

			if (
				Deno.build.os === "windows" &&
				openCmdName === "start" &&
				argsForOpen.length === 2
			) {
				Logger.info('Retrying with \'cmd /c start "" "URL"\' for Windows...');
				const escapedUrl = finalUrlToOpen
					.replace(/&/g, "^&")
					.replace(/%/g, "%%"); // Escape special cmd characters
				const cmdStart = new Deno.Command("cmd", {
					args: ["/c", "start", '""', `"${escapedUrl}"`], // Quotes for safety
					stdout: "piped",
					stderr: "piped",
				});
				const { code: cmdCode, stderr: cmdStderrBytes } =
					await cmdStart.output();
				if (cmdCode !== 0) {
					Logger.error(
						`'cmd /c start' also failed: ${new TextDecoder().decode(cmdStderrBytes).trim() || `(code: ${cmdCode})`}`,
					);
					Logger.log("💡 Please open the URL manually.");
				} else {
					Logger.success("URL should be opening via cmd /c start.");
				}
			} else {
				Logger.log("💡 Please open the URL manually.");
			}
		} else {
			Logger.success("URL should be opening.");
		}
	} else {
		// This case is handled by getOpenCommandName logging an error already.
		Logger.log("💡 Please open the URL manually.");
	}
}

// Script entry point
if (import.meta.main) {
	main().catch((err) => {
		// Catch unhandled errors from main()
		Logger.error(
			"Unhandled error in main execution:",
			err instanceof Error ? err.message : String(err),
		);
		if (err instanceof Error && err.stack) {
			// Optionally log stack trace for debugging (might be too verbose for users)
			console.error("Stack trace:", err.stack);
		}
		Deno.exit(1); // Exit with error code
	});
}
