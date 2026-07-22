import { describe, expect, it } from "vitest";
import { nodePhase } from "./App";

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
