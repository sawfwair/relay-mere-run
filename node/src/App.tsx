import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import {
	Activity, Blocks, ChevronDown, Cpu, ExternalLink, Link2,
	LoaderCircle, LogOut, Pause, Play, RefreshCw, Search, Server,
	Settings, Square,
} from "lucide-react";
import "./App.css";

type Status = { connected: boolean; running: boolean; agent_id?: string; user_id?: string; message?: string; authRequired?: boolean };
type ControlStatus = { running: boolean; phase: string; message: string; accepting: boolean };
type JobEvent = { job_id: string; kind?: string; state: "started" | "done" | "failed" | "canceled"; prompt?: string; model?: string | null };
type LogEvent = { level: string; message: string };
type DeviceAuthStart = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string | null; interval: number; expires_in: number };
type AuthFlow = { status: "idle" } | { status: "starting" } | { status: "pending"; userCode: string; verifyUrl: string } | { status: "failed"; message: string };
type NodePreferences = { schema: string; relayUrl: string; deviceName: string; models: string[]; installedModels: string[]; launchAtLogin: boolean };
type ModelDiscovery = { installedModels: string[]; capabilityModels: string[] };
type ActivityItem = { id: string; title: string; subtitle: string; status: string; progress?: number; model?: string; error?: string; updatedAt: number };
type CapabilityPack = { id: string; title: string; description: string; version?: string; installed: boolean; ready: boolean; installable: boolean; commands: string[]; missingCommands: string[] };
type Tab = "activity" | "capabilities" | "models" | "settings";

const DEFAULT_CONFIG: NodePreferences = {
	schema: "mere.run.node.config.v1", relayUrl: "wss://relay.mere.run/agent",
	deviceName: "", models: [], installedModels: [], launchAtLogin: false,
};
function formatElapsed(epochSeconds?: number): string {
  if (!epochSeconds) return "now";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function statusTone(status: string): "ok" | "warn" | "error" | "neutral" {
  const value = status.toLowerCase();
  if (["complete", "done", "finished", "succeeded", "online", "ready"].includes(value)) return "ok";
  if (["failed", "error", "canceled", "cancelled"].includes(value)) return "error";
  if (["running", "producing", "assembling", "queued", "started"].includes(value)) return "warn";
  return "neutral";
}

export function nodePhase(status: Status, control: ControlStatus): "online" | "connecting" | "draining" | "offline" {
	if (control.phase === "draining") return "draining";
	if (status.connected) return "online";
	return status.running ? "connecting" : "offline";
}

function App(): ReactElement {
  const [config, setConfig] = useState<NodePreferences>(DEFAULT_CONFIG); const [configLoaded, setConfigLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false); const [auth, setAuth] = useState<AuthFlow>({ status: "idle" });
  const [status, setStatus] = useState<Status>({ connected: false, running: false });
	const [control, setControl] = useState<ControlStatus>({ running: false, phase: "stopped", message: "stopped", accepting: false });
	const [activities, setActivities] = useState<ActivityItem[]>([]);
	const [capabilityPacks, setCapabilityPacks] = useState<CapabilityPack[]>([]);
	const [logs, setLogs] = useState<LogEvent[]>([]); const [diagnostics, setDiagnostics] = useState<string[]>([]);
	const [tab, setTab] = useState<Tab>("activity"); const [busy, setBusy] = useState("");
	const [modelQuery, setModelQuery] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);

  const mergeActivities = useCallback((incoming: ActivityItem[]) => {
    setActivities((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const item of incoming) byId.set(item.id, { ...byId.get(item.id), ...item });
      return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 80);
    });
  }, []);

  useEffect(() => {
    const subscriptions = [
      listen<Status>("node:status", ({ payload }) => {
        setStatus(payload);
        if (payload.authRequired) { setSignedIn(false); setAuth({ status: "failed", message: payload.message || "Sign in again." }); }
      }),
		listen<ControlStatus>("node:control-status", ({ payload }) => setControl(payload)),
		listen<JobEvent>("node:job", ({ payload }) => mergeActivities([{ id: `relay:${payload.job_id}`, title: payload.prompt || payload.kind || "Relay job", subtitle: payload.kind || "relay", status: payload.state, model: payload.model || undefined, updatedAt: Math.floor(Date.now() / 1000) }])),
      listen<LogEvent>("node:log", ({ payload }) => setLogs((current) => [...current, payload].slice(-120))),
    ];
    Promise.all([
      invoke<NodePreferences>("load_node_config").then(async (saved) => {
        const launchAtLogin = await autostartEnabled().catch(() => saved.launchAtLogin);
        setConfig({ ...saved, launchAtLogin }); setConfigLoaded(true);
      }),
      invoke<boolean>("node_running").then((running) => setStatus((current) => ({ ...current, running }))),
      invoke<{ signed_in: boolean }>("auth_status").then((value) => setSignedIn(value.signed_in)),
    ]).catch(() => setConfigLoaded(true));
    return (): void => subscriptions.forEach((subscription) => void subscription.then((unlisten) => unlisten()));
	}, [mergeActivities]);

	const refreshActivity = useCallback(async () => {
		const recent = await invoke<ActivityItem[]>("list_relay_activity");
		mergeActivities(recent);
	}, [mergeActivities]);

	const refreshCapabilities = useCallback(async () => {
		setCapabilityPacks(await invoke<CapabilityPack[]>("list_capability_packs"));
	}, []);

	useEffect(() => {
		if (!signedIn) return;
		void Promise.all([refreshActivity(), refreshCapabilities()]).catch((error) => {
			setLogs((current) => [...current, { level: "warning", message: String(error) }].slice(-120));
		});
		const timer = window.setInterval(() => void refreshActivity().catch(() => undefined), 15_000);
		return (): void => window.clearInterval(timer);
	}, [refreshActivity, refreshCapabilities, signedIn]);

  useEffect(() => {
    if (!configLoaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void invoke<NodePreferences>("save_node_config", { config }).catch((error) => setLogs((current) => [...current, { level: "error", message: String(error) }].slice(-120))), 250);
    return (): void => window.clearTimeout(saveTimer.current);
  }, [config, configLoaded]);

  async function signIn(): Promise<void> {
    setBusy("auth"); setAuth({ status: "starting" });
    try {
      const start = await invoke<DeviceAuthStart>("device_auth_start"); const verifyUrl = start.verification_uri_complete || start.verification_uri;
      setAuth({ status: "pending", userCode: start.user_code, verifyUrl }); await openUrl(verifyUrl).catch(() => undefined);
      await invoke("device_auth_poll", { deviceCode: start.device_code, interval: start.interval, expiresIn: start.expires_in });
      setSignedIn(true); setAuth({ status: "idle" });
      await invoke("start_node", { deviceName: config.deviceName.trim() || "mere.run node", models: config.models, relayUrl: config.relayUrl });
    } catch (error) { setAuth({ status: "failed", message: String(error) }); } finally { setBusy(""); }
  }
	async function signOut(): Promise<void> { setBusy("sign-out"); await invoke("sign_out").finally(() => setBusy("")); setSignedIn(false); }
  async function start(): Promise<void> {
    setBusy("start");
    try { await invoke("start_node", { deviceName: config.deviceName.trim() || "mere.run node", models: config.models, relayUrl: config.relayUrl }); }
    catch (error) { setLogs((current) => [...current, { level: "error", message: String(error) }].slice(-120)); }
    finally { setBusy(""); }
  }
  async function drain(): Promise<void> { setBusy("drain"); await invoke("drain_node").finally(() => setBusy("")); }
  async function resume(): Promise<void> { setBusy("resume"); await invoke("resume_node").finally(() => setBusy("")); }
  async function stop(): Promise<void> { setBusy("stop"); await invoke("stop_node").finally(() => setBusy("")); }
  async function discover(): Promise<void> {
    setBusy("models");
    try { const found = await invoke<ModelDiscovery>("discover_models"); setConfig((current) => ({ ...current, models: found.capabilityModels, installedModels: found.installedModels })); }
    catch (error) { setLogs((current) => [...current, { level: "error", message: String(error) }].slice(-120)); }
    finally { setBusy(""); }
  }
	async function installPack(packId: string): Promise<void> {
		setBusy(`pack:${packId}`);
		try {
			setCapabilityPacks(await invoke<CapabilityPack[]>("install_capability_pack", { packId }));
		} catch (error) {
			setLogs((current) => [...current, { level: "error", message: String(error) }].slice(-120));
		} finally {
			setBusy("");
		}
	}
	function refreshDiagnostics(): void { setDiagnostics(logs.map((entry) => `${entry.level}: ${entry.message}`).slice(-120)); }
  async function setLaunchAtLogin(enabled: boolean): Promise<void> {
    if (enabled) await enableAutostart(); else await disableAutostart();
    setConfig((current) => ({ ...current, launchAtLogin: enabled }));
  }

	const phase = nodePhase(status, control); const online = phase === "online"; const draining = phase === "draining";
  const inventory = useMemo(() => config.installedModels.filter((model) => model.toLowerCase().includes(modelQuery.trim().toLowerCase())), [config.installedModels, modelQuery]);

  return <main className="console-shell">
    <header className="app-header">
      <div className="identity"><span className={`status-mark ${phase}`} aria-hidden /><div><h1>mere.run Node</h1><p>{draining ? "draining" : online ? "online" : status.message || "stopped"}</p></div></div>
      {signedIn && <div className="header-actions">
        {!status.running ? <button className="command primary" onClick={() => void start()} disabled={Boolean(busy)}><Play size={16} fill="currentColor" /> Start Node</button>
          : draining ? <button className="command" onClick={() => void resume()} disabled={Boolean(busy)}><Play size={16} /> Resume</button>
          : <button className="command" onClick={() => void drain()} disabled={Boolean(busy)}><Pause size={16} /> Drain</button>}
        {status.running && <button className="icon-button danger" onClick={() => void stop()} disabled={Boolean(busy)} title="Stop after current job"><Square size={16} fill="currentColor" /></button>}
      </div>}
    </header>

    {auth.status === "pending" ? <section className="device-auth"><p>mere.world/device</p><strong>{auth.userCode}</strong><button className="command" onClick={() => void openUrl(auth.verifyUrl)}><ExternalLink size={16} /> Open mere.world</button></section>
      : !signedIn ? <section className="signed-out"><Server size={32} strokeWidth={1.5} /><h2>Sign in to this Node</h2><button className="command primary" onClick={() => void signIn()} disabled={Boolean(busy)}>{auth.status === "starting" ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />} Sign in with mere.world</button>{auth.status === "failed" && <p className="error-copy">{auth.message}</p>}</section>
      : <>
		<nav className="tabs" aria-label="Node views">{([ ["activity", Activity, "Activity"], ["capabilities", Blocks, "Capabilities"], ["models", Cpu, "Models"], ["settings", Settings, "Settings"] ] as const).map(([id, Icon, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={16} /> {label}</button>)}</nav>

        {tab === "activity" && <section className="view" aria-labelledby="activity-heading">
			<div className="view-heading"><div><h2 id="activity-heading">Relay activity</h2><p>Recent account work survives Node restarts · {control.message}</p></div><button className="command compact" onClick={() => void refreshActivity()} disabled={Boolean(busy)}><RefreshCw size={15} /> Refresh</button></div>
			<div className="activity-list">{activities.length === 0 ? <div className="empty-state"><Activity size={24} /> No recent work</div> : activities.map((item) => <article className="activity-card" key={item.id}>
				<div className="activity-topline"><span className="source-badge relay"><Server size={13} />relay</span><span className={`state-pill ${statusTone(item.status)}`}>{item.status}</span><time>{formatElapsed(item.updatedAt)}</time></div>
				<div className="activity-title"><div><h3>{item.title}</h3><p>{item.subtitle}</p></div></div>
				{item.progress !== undefined && <div className="progress-row"><div className="progress-track"><span style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }} /></div><span>{Math.round(item.progress)}%</span></div>}
				<dl className="activity-details">{item.model && <><dt>Runtime</dt><dd>{item.model}</dd></>}</dl>
				{item.error && <p className="job-error">{item.error}</p>}
			</article>)}</div>
		</section>}

		{tab === "capabilities" && <section className="view" aria-labelledby="capabilities-heading">
			<div className="view-heading"><div><h2 id="capabilities-heading">Production capabilities</h2><p>Every Animatic workflow uses this Node through Relay</p></div><button className="command compact" onClick={() => void refreshCapabilities()} disabled={Boolean(busy)}><RefreshCw size={15} /> Scan</button></div>
			<div className="capability-list">{capabilityPacks.map((pack) => <article className="capability-card" key={pack.id}>
				<div className="capability-copy"><div className="capability-heading"><h3>{pack.title}</h3><span className={`state-pill ${pack.ready ? "ok" : "error"}`}>{pack.ready ? "ready" : pack.installed ? "repair" : "missing"}</span></div><p>{pack.description}</p><small>{pack.ready ? `${pack.commands.length} commands${pack.version ? ` · v${pack.version}` : ""}` : `Missing: ${pack.missingCommands.join(", ") || "plugin executable"}`}</small></div>
				{pack.installable && !pack.ready && <button className="command" onClick={() => void installPack(pack.id)} disabled={Boolean(busy)}>{busy === `pack:${pack.id}` ? <LoaderCircle className="spin" size={15} /> : <Blocks size={15} />} {pack.installed ? "Repair" : "Install"}</button>}
			</article>)}{capabilityPacks.length === 0 && <div className="empty-state"><Blocks size={24} /> Scan to inspect capabilities</div>}</div>
		</section>}

        {tab === "models" && <section className="view" aria-labelledby="models-heading">
          <div className="view-heading"><div><h2 id="models-heading">Local models</h2><p>{config.installedModels.length} installed</p></div><button className="command compact" onClick={() => void discover()} disabled={busy === "models" || status.running}><RefreshCw className={busy === "models" ? "spin" : ""} size={15} /> Scan</button></div>
          <label className="search-field"><Search size={15} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Filter models" /></label>
          <div className="model-list">{inventory.map((model) => <div className="model-row" key={model}><Cpu size={15} /><span>{model}</span><span className={config.models.includes(model) ? "ready" : "local"}>{config.models.includes(model) ? "ready" : "local"}</span></div>)}{inventory.length === 0 && <div className="empty-state"><Cpu size={24} /> No models found</div>}</div>
        </section>}

        {tab === "settings" && <section className="view settings-view" aria-labelledby="settings-heading">
			<div className="view-heading"><div><h2 id="settings-heading">Node settings</h2><p>One Relay connection for all work</p></div></div>
          <label className="field"><span>Device name</span><input value={config.deviceName} disabled={status.running} onChange={(event) => setConfig((current) => ({ ...current, deviceName: event.target.value }))} placeholder="this machine" /></label>
          <label className="field"><span>Relay URL</span><input value={config.relayUrl} disabled={status.running} onChange={(event) => setConfig((current) => ({ ...current, relayUrl: event.target.value }))} spellCheck={false} /></label>
			<label className="check-row"><input type="checkbox" checked={config.launchAtLogin} onChange={(event) => void setLaunchAtLogin(event.target.checked)} /><span>Launch Node at login</span></label>
			<div className="settings-actions"><button className="command" onClick={() => void signOut()} disabled={Boolean(busy)}><LogOut size={15} /> {status.running ? "Cancel work and sign out" : "Sign out"}</button></div>
          <details className="diagnostics" onToggle={(event) => event.currentTarget.open && void refreshDiagnostics()}><summary><span>Diagnostics</span><ChevronDown size={16} /></summary><pre>{diagnostics.length ? diagnostics.join("\n") : "No diagnostics"}</pre></details>
        </section>}
      </>}
  </main>;
}

export default App;
