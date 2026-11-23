import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { ChatError } from "./errors.js";

const TOOLS = [
	"/usr/bin/bwrap",
	"/usr/bin/prlimit",
	"/usr/bin/pdfinfo",
	"/usr/bin/pdftotext",
	"/usr/bin/pdftoppm",
];
const MAX_PAGES = 200;
let active = 0;

export function pdfAvailable(): boolean {
	return TOOLS.every((path) => existsSync(path));
}

function runPdf(
	command: string,
	args: string[],
	bytes: Buffer,
): Promise<Buffer> {
	if (active >= 2)
		throw new ChatError(429, "PDF processing is busy. Try again shortly.");
	active++;
	return new Promise((resolve, reject) => {
		const child = execFile(
			"/usr/bin/prlimit",
			[
				"--as=805306368",
				"--cpu=12",
				"--",
				"/usr/bin/bwrap",
				"--unshare-all",
				"--die-with-parent",
				"--new-session",
				"--clearenv",
				"--setenv",
				"LC_ALL",
				"C",
				"--setenv",
				"HOME",
				"/tmp",
				"--ro-bind",
				"/usr",
				"/usr",
				"--symlink",
				"usr/lib",
				"/lib",
				"--symlink",
				"usr/lib64",
				"/lib64",
				"--tmpfs",
				"/tmp",
				"--dev",
				"/dev",
				"--ro-bind-try",
				"/etc/fonts",
				"/etc/fonts",
				"--",
				`/usr/bin/${command}`,
				...args,
			],
			{ encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
			(error, result) => {
				active--;
				if (error)
					reject(
						new ChatError(
							422,
							"The PDF could not be processed. Check that it opens without a password.",
						),
					);
				else resolve(result);
			},
		);
		child.stdin?.on("error", () => {
			/* A rejected PDF may close stdin early. */
		});
		child.stdin?.end(bytes);
	});
}

export async function extractPdf(bytes: Buffer): Promise<string[]> {
	if (bytes.subarray(0, 5).toString() !== "%PDF-")
		throw new ChatError(415, "Choose a valid PDF.");
	const info = await runPdf("pdfinfo", ["-"], bytes);
	const count = Number(/^Pages:\s+(\d+)/m.exec(info.toString())?.[1]);
	if (!Number.isInteger(count) || count < 1 || count > MAX_PAGES)
		throw new ChatError(422, "Choose a PDF with 1 to 200 pages.");
	const text = await runPdf("pdftotext", ["-enc", "UTF-8", "-", "-"], bytes);
	const pages = text.toString("utf8").split("\f");
	const pageLimit = Math.min(16_000, Math.floor(480_000 / count));
	return Array.from({ length: count }, (_, i) =>
		(pages[i] ?? "").trim().slice(0, pageLimit),
	);
}

export function renderPdfPage(bytes: Buffer, page: number): Promise<Buffer> {
	return runPdf(
		"pdftoppm",
		[
			"-png",
			"-singlefile",
			"-scale-to",
			"1500",
			"-f",
			String(page),
			"-l",
			String(page),
			"-",
		],
		bytes,
	);
}
