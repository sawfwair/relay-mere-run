import { describe, expect, it } from "vitest";
import { nodePhase, runtimeNotice } from "./App";

describe("unified node status", () => {
	it("uses the relay connection as the only online signal", () => {
		expect(nodePhase(
			{ connected: false, running: true, message: "authenticating with Relay" },
			{ running: true, phase: "idle", message: "Waiting for Relay work", accepting: true },
		)).toBe("connecting");
		expect(nodePhase(
			{ connected: true, running: true, message: "online" },
			{ running: true, phase: "idle", message: "Waiting for Relay work", accepting: true },
		)).toBe("online");
	});

	it("keeps draining distinct from disconnected", () => {
		expect(nodePhase(
			{ connected: true, running: true, message: "online" },
			{ running: true, phase: "draining", message: "Finishing active work", accepting: false },
		)).toBe("draining");
	});
});

describe("runtime conflict notice", () => {
	it("explains automatic compatibility selection", () => {
		expect(runtimeNotice({
			selectedPath: "/app/mere.run", selectedVersion: "0.33.0", pinned: false, conflict: true,
			selectionReason: "newest compatible", candidates: [
				{ path: "/old/mere.run", source: "system install", version: null, contract: "legacy", features: [], selected: false },
				{ path: "/app/mere.run", source: "MereRun app", version: "0.33.0", contract: "status_json", features: ["status-json"], selected: true },
			],
		})?.message).toContain("older or incompatible installation was skipped");
	});

	it("makes an explicit pin clear without overriding it", () => {
		const notice = runtimeNotice({
			selectedPath: "/pinned/mere.run", selectedVersion: "0.23.0", pinned: true, conflict: true,
			selectionReason: "pinned", candidates: [
				{ path: "/pinned/mere.run", source: "MERERUN_BIN pin", version: "0.23.0", contract: "legacy", features: [], selected: true },
				{ path: "/app/mere.run", source: "MereRun app", version: "0.33.0", contract: "status_json", features: ["status-json"], selected: false },
			],
		});
		expect(notice?.message).toContain("pinned mere.run 0.23.0");
		expect(notice?.message).toContain("not selected");
	});

	it("reports an unusable pin as an error", () => {
		const notice = runtimeNotice({
			selectedPath: "/missing/mere.run", selectedVersion: null, pinned: true, conflict: true,
			selectionReason: "pinned", candidates: [
				{ path: "/missing/mere.run", source: "MERERUN_BIN pin", version: null, contract: "unavailable", features: [], selected: true },
				{ path: "/app/mere.run", source: "MereRun app", version: "0.33.0", contract: "status_json", features: ["status-json"], selected: false },
			],
		});
		expect(notice?.tone).toBe("error");
		expect(notice?.message).toContain("could not satisfy");
	});
});
