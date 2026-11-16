/**
 * notices: delivers each new line of a watched file into the conversation as a message
 * of its own, never through the text box.
 *
 * `PI_NOTICES_FILE` names the file to watch. When it is unset the extension watches
 * nothing. It is read once, when the extension loads, and then removed from the
 * environment, so a process the session starts is not handed the same inbox
 * (pi-notices-qqd). The file it read is kept for the process, so the loads after a
 * runtime rebuild (`/new`, `/resume`, `/fork`, `/reload`) find it with the variable
 * already gone (pi-notices-49k). For each new line it calls `pi.sendMessage` with a
 * visible message, `triggerTurn: true` and `deliverAs: "followUp"`: an idle session
 * starts a turn on the line, and a busy one gets it when its turn ends. Nothing writes
 * to the editor, so a half-typed draft survives.
 *
 * Only lines written after the session started are delivered: the file's length at
 * `session_start` is the starting point, so earlier lines are not replayed to whoever
 * already acted on them.
 */
import * as fs from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The key the first load leaves the Notice file under, on the process rather than this load,
 * so the load after a runtime rebuild finds it (pi-notices-49k). `Symbol.for` reaches the
 * process-wide registry, which a second copy of this file would share.
 */
const noticeFileKey = Symbol.for("pi-notices.file");

/**
 * The file named by `PI_NOTICES_FILE`, or the one an earlier load in this process kept.
 *
 * The variable is removed once read. It names this session's inbox, and as an inherited
 * environment variable it would otherwise hand the same inbox to every process the
 * session starts, so a child pi would answer this session's Notices too (pi-notices-qqd).
 * Because of that removal, a load whose variable is gone takes the file an earlier load
 * kept on `globalThis` (pi-notices-49k).
 */
const takeNoticeFile = (): string | undefined => {
	// Every load in this process reaches the same slot, so the file outlives a rebuild.
	const processWide = globalThis as typeof globalThis & { [noticeFileKey]?: string };
	const inherited = process.env.PI_NOTICES_FILE || undefined;
	delete process.env.PI_NOTICES_FILE;
	if (inherited) processWide[noticeFileKey] = inherited;
	return processWide[noticeFileKey];
};

type Watch = { stop: () => void };

export default function notices(pi: ExtensionAPI): void {
	const noticeFile = takeNoticeFile();
	let active: Watch | undefined;

	const watchFile = (file: string): Watch => {
		const dir = dirname(file);
		const name = basename(file);
		fs.mkdirSync(dir, { recursive: true });

		// Everything already in the file belongs to an earlier session.
		let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
		let timer: NodeJS.Timeout | undefined;

		const deliver = () => {
			timer = undefined;
			let contents: Buffer;
			try {
				contents = fs.readFileSync(file);
			} catch {
				return;
			}
			// A replaced or emptied file is a new one: read it from the start.
			if (contents.length < offset) offset = 0;
			const lastNewline = contents.lastIndexOf(0x0a);
			if (lastNewline < offset) return;
			const lines = contents
				.subarray(offset, lastNewline + 1)
				.toString("utf8")
				.split("\n")
				.map((line) => line.replace(/\r$/, ""))
				.filter((line) => line.trim() !== "");
			offset = lastNewline + 1;
			for (const line of lines) {
				pi.sendMessage(
					{ customType: "notice", content: `Notice: ${line}`, display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
		};

		// One line arrives as one write; the short wait covers a write still in progress.
		const schedule = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(deliver, 50);
		};

		const watcher = fs.watch(dir, (_event, changed) => {
			if (changed && changed.toString() !== name) return;
			schedule();
		});
		return {
			stop: () => {
				if (timer) clearTimeout(timer);
				watcher.close();
			},
		};
	};

	pi.on("session_start", async () => {
		active?.stop();
		active = noticeFile ? watchFile(noticeFile) : undefined;
	});
	pi.on("session_shutdown", async () => {
		active?.stop();
		active = undefined;
	});
}
