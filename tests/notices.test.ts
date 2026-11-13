/**
 * A Notice is one line of the watched file, delivered into the conversation as a message
 * of its own, never through the text box. These tests drive the extension's seam: pi in
 * RPC mode with the Notices extension, `PI_NOTICES_FILE` naming a temporary file the test
 * writes to, and a test provider at the edge that records the conversation each request
 * carried.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noticesExtension = path.join(repoRoot, "extensions", "notices.ts");
const testProvider = path.join(repoRoot, "tests", "fixtures", "notices-test-provider.ts");

/** One model request the test provider answered: when it started, and what it was sent. */
type Request = { at: number; messages: string[] };
type ProtocolRecord = { type: string; [key: string]: unknown };

type Workspace = {
	dir: string;
	home: string;
	agentDir: string;
	noticeFile: string;
	log: string;
	delayMs: number;
};

/** One temporary machine, whose Notice file lives at a path of the test's own choosing. */
function makeWorkspace(delayMs = 0): Workspace {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notices-"));
	const home = path.join(dir, "home");
	const agentDir = path.join(dir, "pi-agent");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	return {
		dir,
		home,
		agentDir,
		noticeFile: path.join(dir, "notices", "notices.md"),
		log: path.join(dir, "requests.jsonl"),
		delayMs,
	};
}

const readRequests = (log: string): Request[] =>
	fs.existsSync(log)
		? fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Request)
		: [];

const appendNotice = (workspace: Workspace, line: string): void => {
	fs.mkdirSync(path.dirname(workspace.noticeFile), { recursive: true });
	fs.appendFileSync(workspace.noticeFile, `${line}\n`);
};

/** A pi session in RPC mode: commands out, protocol records back. */
function startPi(workspace: Workspace, { watch = true }: { watch?: boolean } = {}) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: workspace.home,
		PI_CODING_AGENT_DIR: workspace.agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		NOTICES_TEST_LOG: workspace.log,
		NOTICES_TEST_DELAY_MS: String(workspace.delayMs),
	};
	if (watch) env.PI_NOTICES_FILE = workspace.noticeFile;
	else delete env.PI_NOTICES_FILE;
	const child: ChildProcess = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"-ns",
			"-ne",
			"-e",
			noticesExtension,
			"-e",
			testProvider,
			"--model",
			"notices-test/reply",
		],
		{
			cwd: workspace.dir,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		},
	);

	const events: ProtocolRecord[] = [];
	const waiters = new Set<() => void>();
	const pending = new Map<string, (response: ProtocolRecord) => void>();
	let buffer = "";
	let stderr = "";
	let nextId = 0;

	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			const record = JSON.parse(line) as ProtocolRecord;
			const id = typeof record.id === "string" ? record.id : undefined;
			if (record.type === "response" && id && pending.has(id)) {
				const resolve = pending.get(id)!;
				pending.delete(id);
				resolve(record);
				continue;
			}
			events.push(record);
			for (const wake of [...waiters]) wake();
		}
	});
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const request = (command: Record<string, unknown>): Promise<ProtocolRecord> => {
		const id = `req-${++nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`pi did not answer ${String(command.type)}\n${stderr}\n${JSON.stringify(events)}`));
			}, 15000);
			pending.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	};

	/** Wait for a protocol record matching `pick`, looking only at records after `after`. */
	const waitFor = <T>(pick: () => T | undefined, what: string, after = 0): Promise<T> => {
		const found = pick();
		if (found !== undefined) return Promise.resolve(found);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`timed out waiting for ${what}\n${stderr}\n${JSON.stringify(events.slice(after))}`));
			}, 15000);
			const check = () => {
				const value = pick();
				if (value === undefined) return;
				cleanup();
				resolve(value);
			};
			const cleanup = () => {
				clearTimeout(timer);
				waiters.delete(check);
			};
			waiters.add(check);
		});
	};

	const stop = async (): Promise<void> => {
		child.stdin!.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 5000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	};

	/** Wait for the turn that begins after record `after` to end. */
	const waitForSettled = (after: number): Promise<ProtocolRecord> =>
		waitFor(
			() => events.slice(after).find((event) => event.type === "agent_settled"),
			"the turn the Notice started",
			after,
		);

	/** The Notice messages the conversation holds: the custom messages the extension added. */
	const notices = async (): Promise<Array<Record<string, unknown>>> => {
		const { data } = await request({ type: "get_messages" });
		return noticeMessages((data as { messages: Array<Record<string, unknown>> }).messages);
	};

	return { child, events, request, waitForSettled, notices, stop, stderr: () => stderr };
}

/** Wait until the test provider has written `count` requests to its log. */
async function waitForRequests(log: string, count: number, timeoutMs = 10000): Promise<Request[]> {
	const start = Date.now();
	while (readRequests(log).length < count) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`the test provider saw ${readRequests(log).length} requests, not ${count}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return readRequests(log);
}

/** The Notice messages pi holds in the conversation: custom messages the extension added. */
const noticeMessages = (messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
	messages.filter((message) => message.role === "custom" && message.customType === "notice");

const contentOf = (message: Record<string, unknown>): string =>
	typeof message.content === "string" ? message.content : JSON.stringify(message.content);

test("a Notice written while the session is idle arrives once, visible, and starts a turn", async () => {
	const workspace = makeWorkspace();
	const pi = startPi(workspace);
	try {
		await pi.request({ type: "get_state" });
		const after = pi.events.length;
		const notice = "Run 50ae54e5 for Bead pi-notices-ac6 ended failed.";
		appendNotice(workspace, notice);

		await pi.waitForSettled(after);

		const requests = readRequests(workspace.log);
		assert.equal(requests.length, 1, "the Notice started one turn");
		assert.ok(
			requests[0].messages.some((text) => text.includes(notice)),
			`the turn was sent the Notice: ${JSON.stringify(requests[0].messages)}`,
		);

		const notices = await pi.notices();
		assert.equal(notices.length, 1, "the Notice arrives once");
		assert.equal(notices[0].display, true, "the Notice is visible in the conversation");
		assert.match(contentOf(notices[0]), /Run 50ae54e5 .* ended failed\./);
	} finally {
		await pi.stop();
	}
});

test("a Notice written while a turn is running waits for that turn to end", async () => {
	const workspace = makeWorkspace(600);
	const pi = startPi(workspace);
	try {
		await pi.request({ type: "get_state" });
		const after = pi.events.length;
		pi.child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "what is running?" })}\n`);
		await waitForRequests(workspace.log, 1);

		const notice = "Run 61bf65f6 for Bead pi-notices-ac7 ended merged.";
		appendNotice(workspace, notice);

		const requests = await waitForRequests(workspace.log, 2);
		await pi.waitForSettled(after);

		assert.equal(requests.length, 2, "the Notice started one turn of its own");
		assert.ok(
			!requests[0].messages.some((text) => text.includes(notice)),
			"the running turn never saw the Notice",
		);
		assert.ok(
			requests[1].messages.some((text) => text.includes(notice)),
			"the turn after it was sent the Notice",
		);
		assert.ok(
			requests[1].at - requests[0].at >= 500,
			"the Notice's turn began only after the running turn's answer came back",
		);
	} finally {
		await pi.stop();
	}
});

test("lines written before the session started are not delivered", async () => {
	const workspace = makeWorkspace();
	appendNotice(workspace, "2026-11-07 22:00 Run 11111111 for Bead pi-notices-ac5 ended merged.");
	const pi = startPi(workspace);
	try {
		await pi.request({ type: "get_state" });
		const after = pi.events.length;
		const notice = "Run 50ae54e5 for Bead pi-notices-ac6 ended failed.";
		appendNotice(workspace, notice);

		await pi.waitForSettled(after);

		const requests = readRequests(workspace.log);
		assert.equal(requests.length, 1, "only the new line started a turn");
		assert.ok(requests[0].messages.some((text) => text.includes(notice)));
		assert.ok(
			!requests[0].messages.some((text) => text.includes("11111111")),
			"the line written before the session started was not delivered",
		);

		const notices = await pi.notices();
		assert.equal(notices.length, 1, "only the new line became a Notice");
		assert.match(contentOf(notices[0]), /Run 50ae54e5/);
	} finally {
		await pi.stop();
	}
});

// The session's own reception with the setting still passed in is covered by the idle-Notice
// test above, which starts pi the same way; this test checks only what a child process sees.
test("a child process started from the session is not handed PI_NOTICES_FILE", async () => {
	const workspace = makeWorkspace();
	const pi = startPi(workspace);
	try {
		await pi.request({ type: "get_state" });

		const { data } = await pi.request({ type: "bash", command: "printenv PI_NOTICES_FILE || true" });
		assert.equal(
			(data as { output: string }).output,
			"",
			"the child process was not handed the session's inbox",
		);
	} finally {
		await pi.stop();
	}
});

test("the extension does nothing when PI_NOTICES_FILE is unset", async () => {
	const workspace = makeWorkspace();
	const pi = startPi(workspace, { watch: false });
	try {
		await pi.request({ type: "get_state" });
		appendNotice(workspace, "Run 72c07607 for Bead pi-notices-ac6 ended merged.");
		await new Promise((resolve) => setTimeout(resolve, 700));

		assert.deepEqual(readRequests(workspace.log), [], "no turn was started");
		assert.equal(
			pi.events.filter((event) => event.type === "agent_settled").length,
			0,
			"no turn ran",
		);
		assert.deepEqual(await pi.notices(), [], "no Notice reached the conversation");
	} finally {
		await pi.stop();
	}
});
