#!/usr/bin/env -S deno run --allow-read --allow-run
// extract_coords.ts
//
// Usage:
//   deno run --allow-run --allow-read extract_coords.ts <glob_or_path> [more_paths...] [--csv]
//
// Examples:
//   deno run --allow-run --allow-read extract_coords.ts ./videos/**/*.MOV
//   deno run --allow-run --allow-read extract_coords.ts ./myvideo.MOV --csv
//   deno run --allow-run --allow-read extract_coords.ts ./folder1 ./folder2/**/*.MOV --csv

import { expandGlob } from "https://deno.land/std@0.224.0/fs/mod.ts";

function printHelp() {
	console.log(`
Extract GPS coordinates & creation date from .MOV videos (using exiftool).

Usage:
  extract_coords.ts <glob_or_path> [more_paths...] [--csv]

Options:
  --csv     Output results as CSV instead of JSON
  --help    Show this help message

Examples:
  extract_coords.ts ./video.MOV
  extract_coords.ts ./videos/**/*.MOV --csv
  extract_coords.ts ./folder1 ./folder2/**/*.MOV
`);
}

const args = Deno.args;
if (args.length === 0 || args.includes("--help")) {
	printHelp();
	Deno.exit(0);
}

const targetPaths = args.filter((a) => !a.startsWith("--"));
const outputCSV = args.includes("--csv");

async function extractWithExiftool(filePaths: string[]) {
	const cmd = new Deno.Command("exiftool", {
		args: [
			"-json",
			"-n",
			"-GPSLatitude",
			"-GPSLongitude",
			"-CreateDate",
			...filePaths,
		],
	});
	const { stdout } = await cmd.output();
	const text = new TextDecoder().decode(stdout);
	return JSON.parse(text).map((parsed: any) => ({
		file: parsed.SourceFile,
		latitude: parsed.GPSLatitude ?? null,
		longitude: parsed.GPSLongitude ?? null,
		creationDate: parsed.CreateDate ?? null,
	}));
}

async function collectFiles(pathOrGlob: string): Promise<string[]> {
	const files: string[] = [];

	// Try as direct path first
	try {
		const info = await Deno.stat(pathOrGlob);
		if (info.isFile && pathOrGlob.toLowerCase().endsWith(".mov")) {
			return [pathOrGlob];
		}
		if (info.isDirectory) {
			for await (const entry of expandGlob(`${pathOrGlob}/**/*.MOV`, {
				caseInsensitive: true,
			})) {
				if (entry.isFile) files.push(entry.path);
			}
			return files;
		}
	} catch {
		// Not a direct path — treat as glob
	}

	// Treat as glob pattern
	for await (const entry of expandGlob(pathOrGlob, { caseInsensitive: true })) {
		if (entry.isFile && entry.path.toLowerCase().endsWith(".mov")) {
			files.push(entry.path);
		}
	}

	return files;
}

// Gather files from *all* provided arguments
let files: string[] = [];
for (const p of targetPaths) {
	files = files.concat(await collectFiles(p));
}

if (files.length === 0) {
	console.error("No matching .MOV files found.");
	Deno.exit(1);
}

const results = await extractWithExiftool(files);

if (outputCSV) {
	console.log("file,latitude,longitude,creationDate");
	for (const r of results) {
		console.log(
			`${r.file},${r.latitude ?? ""},${r.longitude ?? ""},${r.creationDate ?? ""}`,
		);
	}
} else {
	console.log(JSON.stringify(results, null, 2));
}
