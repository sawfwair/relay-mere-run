import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { ZodType } from 'zod';
import { formatBytes } from './format';
import { readResponseJson } from './json';
import {
  errorResponseSchema,
  fleetModelPlanSchema,
  fleetNodeSchema,
  fleetRefreshResponseSchema,
  fleetSettingsSchema,
  fleetSnapshotSchema,
  sessionResponseSchema,
} from './contracts';
import type {
  FleetModelPlan,
  FleetNodePolicy,
  FleetNodeRecord,
  FleetSnapshot,
  SchedulerMode,
  SessionUser,
} from './types';

type AuthState = 'loading' | 'guest' | 'authenticated';

const SCHEDULER_MODES: Array<{ id: SchedulerMode; label: string; description: string }> = [
  { id: 'balanced', label: 'Balanced', description: 'Priority, preference, and available memory.' },
  { id: 'fastest', label: 'Fastest', description: 'Favors measured model throughput.' },
  { id: 'efficient', label: 'Efficient', description: 'Avoids battery and thermally constrained nodes.' },
];

async function refreshSession(): Promise<boolean> {
  const response = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  return response.ok;
}

async function apiRequest<T>(
  path: string,
  parser: ZodType<T>,
  init?: RequestInit,
  retry = true
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401 && retry && await refreshSession()) {
    return apiRequest(path, parser, init, false);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await readResponseJson(response, errorResponseSchema);
      if (payload.error) message = payload.error;
    } catch {
      // The status remains the useful fallback.
    }
    throw new Error(message);
  }
  return readResponseJson(response, parser);
}

function duration(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta < 30_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function BrandMark(): ReactElement {
  return (
    <span className="brand-mark" aria-label="mere.run relay">
      mere<span>.run</span><b>relay</b>
    </span>
  );
}

function StatusDot({ status }: { status: string }): ReactElement {
  return <span className={`status-dot status-${status}`} aria-hidden />;
}

function Landing({ authError }: { authError: string | null }): ReactElement {
  return (
    <main className="landing-shell">
      <header className="landing-nav">
        <BrandMark />
        <a className="quiet-link" href="#downloads">Get a node</a>
      </header>

      <section className="landing-hero">
        <i className="board-cross board-cross-top" aria-hidden />
        <i className="board-cross board-cross-side" aria-hidden />
        <div className="landing-copy">
          <p className="eyebrow hero-eyebrow"><i aria-hidden />Control plane · account scoped</p>
          <h1>
            <span>Every machine.</span>
            <em>One compute pool.</em>
          </h1>
          <p className="lede">
            Route local AI work across every Mac, CUDA box, and edge machine you own—without opening your network or giving up the keys.
          </p>
          {authError && <p className="auth-error" role="alert">{authError}</p>}
          <div className="hero-actions">
            <a className="primary-action" href="/auth/start?return_to=/">
              Sign in with mere.world
              <span aria-hidden>→</span>
            </a>
            <a className="secondary-action" href="#downloads">Get a node <span aria-hidden>↓</span></a>
          </div>
          <p className="trust-note">Private to your mere.world account. Your nodes dial out; your network stays closed.</p>
          <dl className="hero-specs" aria-label="Relay at a glance">
            <div><dt>node lanes</dt><dd>03</dd></div>
            <div><dt>inbound ports</dt><dd>00</dd></div>
            <div><dt>private pool</dt><dd>01</dd></div>
          </dl>
        </div>

        <div
          className="control-map"
          role="img"
          aria-label="Illustrative relay routing map: one incoming AI job is scored by the private scheduler and assigned across Mac, CUDA, and edge nodes."
        >
          <div className="map-heading" aria-hidden>
            <span>Routing map / live</span>
            <span>X 0472 · Y 0218</span>
          </div>

          <div className="job-card" aria-hidden>
            <span>Job ingress</span>
            <strong>video-ltx23</strong>
            <small>job_8f2 · priority 02</small>
          </div>

          <div className="map-route route-ingress" aria-hidden><i /></div>
          <div className="map-route route-mac" aria-hidden><i /></div>
          <div className="map-route route-gpu" aria-hidden><i /></div>
          <div className="map-route route-edge" aria-hidden><i /></div>

          <div className="relay-core" aria-hidden>
            <span className="relay-sigil"><i /><i /><i /></span>
            <strong>relay.mere.run</strong>
            <small>balanced scheduler</small>
            <div><span>queue</span><b>01</b><span>models</span><b>07</b></div>
          </div>

          <div className="map-node node-mac" aria-hidden>
            <span><StatusDot status="online" />Mac Studio</span>
            <strong>Metal · 96 GB</strong>
            <small>image · audio · train</small>
          </div>
          <div className="map-node node-gpu" aria-hidden>
            <span><StatusDot status="busy" />GPU 02 <b>assigned</b></span>
            <strong>CUDA · 80 GB</strong>
            <small>video · 3D · world</small>
          </div>
          <div className="map-node node-edge" aria-hidden>
            <span><StatusDot status="offline" />Edge 01</span>
            <strong>CPU · standby</strong>
            <small>speech · embeddings</small>
          </div>

          <div className="scheduler-readout" aria-hidden>
            <p><span>Candidate score</span><b>Balanced</b></p>
            <ol>
              <li><span>gpu-02</span><i style={{ '--score': '97%' } as React.CSSProperties} /><b>0.97</b></li>
              <li><span>mac-studio</span><i style={{ '--score': '82%' } as React.CSSProperties} /><b>0.82</b></li>
              <li><span>edge-01</span><i style={{ '--score': '31%' } as React.CSSProperties} /><b>0.31</b></li>
            </ol>
          </div>

          <div className="route-log" aria-hidden>
            <span className="live-pip" />job_8f2 → gpu-02 <b>18 ms</b>
          </div>
        </div>

        <div className="hero-status" aria-hidden>
          <span className="status-ready"><i />Control plane ready</span>
          <span>Balanced routing</span>
          <span>Outbound-only nodes</span>
          <span className="status-sheet">Sheet 01 · relay rev 1.0</span>
        </div>
      </section>

      <section className="landing-facts" aria-label="Control plane capabilities">
        <div><span>01</span><h2>Know the fleet</h2><p>Hardware, models, availability, thermals, and power state.</p></div>
        <div><span>02</span><h2>Route with intent</h2><p>Balanced, fastest, or power-efficient scheduling.</p></div>
        <div><span>03</span><h2>See the work</h2><p>Queue, active jobs, failures, timing, and model coverage.</p></div>
      </section>

      <section className="download-strip" id="downloads">
        <div>
          <p className="eyebrow">Add compute</p>
          <h2>Turn a machine into a node.</h2>
          <p>Install mere.run, start the node, and approve it with the same account.</p>
        </div>
        <nav aria-label="Node downloads">
          <a href="/downloads/mere-run-node/macos/latest">macOS <span>↓</span></a>
          <a href="/downloads/mere-run-node/linux/x86_64/latest">Linux x86_64 <span>↓</span></a>
          <a href="/downloads/mere-run-node/linux/arm64/latest">Linux arm64 <span>↓</span></a>
        </nav>
      </section>
    </main>
  );
}

function Skeleton(): ReactElement {
  return (
    <div className="dashboard-shell" aria-busy="true" aria-label="Loading compute fleet">
      <div className="skeleton skeleton-header" />
      <div className="skeleton skeleton-strip" />
      <div className="skeleton-grid">
        <div className="skeleton skeleton-main" />
        <div className="skeleton skeleton-side" />
      </div>
    </div>
  );
}

function EmptyFleet(): ReactElement {
  return (
    <section className="empty-fleet">
      <div className="empty-orbit" aria-hidden><i /><i /><i /></div>
      <p className="eyebrow">No nodes yet</p>
      <h2>Your compute pool starts with one machine.</h2>
      <ol>
        <li><span>1</span>Install mere.run on the machine.</li>
        <li><span>2</span>Download and start mere.run node.</li>
        <li><span>3</span>Approve it with this mere.world account.</li>
      </ol>
      <div className="empty-downloads">
        <a href="/downloads/mere-run-node/macos/latest">Download for macOS</a>
        <a href="/downloads/mere-run-node/linux/x86_64/latest">Linux x86_64</a>
        <a href="/downloads/mere-run-node/linux/arm64/latest">Linux arm64</a>
      </div>
    </section>
  );
}

function NodeSettings({
  node,
  busy,
  refreshing,
  onUpdate,
  onRefresh,
}: {
  node: FleetNodeRecord;
  busy: boolean;
  refreshing: boolean;
  onUpdate: (patch: Partial<FleetNodePolicy>) => Promise<void>;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const [name, setName] = useState(node.policy.display_name ?? node.reported_name);
  const [priority, setPriority] = useState(node.policy.priority);
  const [preferred, setPreferred] = useState(node.policy.preferred_models.join(', '));
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    setName(node.policy.display_name ?? node.reported_name);
    setPriority(node.policy.priority);
    setPreferred(node.policy.preferred_models.join(', '));
  }, [node]);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await onUpdate({
      display_name: name.trim() || null,
      priority,
      preferred_models: preferred.split(',').map((model) => model.trim()).filter(Boolean),
    });
  }

  return (
    <div className="node-settings">
      <form onSubmit={(event) => void save(event)}>
        <label>
          <span>Display name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
        </label>
        <label>
          <span>Routing priority <b>{priority}</b></span>
          <input
            type="range"
            min="0"
            max="100"
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
          />
          <small className="field-help">100 is the highest placement preference among eligible nodes. It does not reserve capacity.</small>
        </label>
        <label className="wide-field">
          <span>Preferred model routing <small>comma separated</small></span>
          <input
            value={preferred}
            onChange={(event) => setPreferred(event.target.value)}
            placeholder="image-klein-9b, video-ltx23-av-mlx"
          />
          <small className="field-help">Routing hint only. This does not install models.</small>
        </label>
        <button className="compact-button" disabled={busy}>Save settings</button>
      </form>

      <div className="node-actions">
        <button
          className="compact-button"
          disabled={busy || refreshing || node.connected_at === null || node.policy.revoked}
          onClick={() => void onRefresh()}
        >
          <span aria-hidden>↻</span> {refreshing ? 'Refreshing inventory' : 'Refresh inventory'}
        </button>
        <button
          className={`toggle-control ${node.policy.draining ? 'active' : ''}`}
          aria-pressed={node.policy.draining}
          disabled={busy || node.policy.revoked}
          onClick={() => void onUpdate({ draining: !node.policy.draining })}
        >
          <i aria-hidden />
          {node.policy.draining ? 'Draining' : 'Accept work'}
        </button>
        <button
          className={`toggle-control ${node.policy.enabled ? 'active' : ''}`}
          aria-pressed={node.policy.enabled}
          disabled={busy || node.policy.revoked}
          onClick={() => void onUpdate({ enabled: !node.policy.enabled })}
        >
          <i aria-hidden />
          {node.policy.enabled ? 'Enabled' : 'Disabled'}
        </button>
        {confirmRevoke ? (
          <span className="revoke-confirm">
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void onUpdate({ revoked: true })}
            >
              Confirm revoke
            </button>
            <button className="text-button" onClick={() => setConfirmRevoke(false)}>Cancel</button>
          </span>
        ) : node.policy.revoked ? (
          <button className="compact-button" disabled={busy} onClick={() => void onUpdate({ revoked: false })}>
            Restore access
          </button>
        ) : (
          <button className="danger-button" onClick={() => setConfirmRevoke(true)}>
            Revoke access
          </button>
        )}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  expanded,
  busy,
  refreshing,
  onToggle,
  onUpdate,
  onRefresh,
}: {
  node: FleetNodeRecord;
  expanded: boolean;
  busy: boolean;
  refreshing: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<FleetNodePolicy>) => Promise<void>;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const accelerator = node.system?.accelerators[0];
  const hardware = [
    accelerator?.backend?.toUpperCase(),
    accelerator?.name,
    accelerator?.memory_total_bytes ? formatBytes(accelerator.memory_total_bytes) : null,
  ].filter(Boolean).join(' · ');
  const load = node.telemetry?.accelerator_utilization_percent ?? node.telemetry?.cpu_load_percent;
  const installedModels = node.runtime?.installed_models ?? [];
  const inventoryKnown = node.runtime?.inventory_status === 'reported'
    || node.runtime?.inventory_status === 'empty'
    || installedModels.length > 0;
  const inventoryMessage = ((): string => {
    switch (node.runtime?.inventory_status) {
      case 'unavailable': return 'mere.run was not found by the node agent.';
      case 'failed': return 'The installed model scan failed.';
      case 'empty': return 'No installed models were reported.';
      default:
        return node.runtime ? 'Inventory status was not reported. Update the node agent and refresh.' : 'Runtime inventory was not reported by this node.';
    }
  })();

  return (
    <article className={`node-row ${expanded ? 'expanded' : ''}`}>
      <button className="node-row-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className="node-presence"><StatusDot status={node.status} /></span>
        <span className="node-identity">
          <strong>{node.device_name}</strong>
          <small>{hardware || `${node.system?.platform ?? 'Unknown platform'} · ${node.system?.architecture ?? 'unknown arch'}`}</small>
        </span>
        <span className="node-fact">
          <b>{inventoryKnown ? installedModels.length : '—'}</b>
          <small>{inventoryKnown ? 'models' : 'scan'}</small>
        </span>
        <span className="node-fact">
          <b>{load === undefined ? '—' : `${Math.round(load)}%`}</b>
          <small>load</small>
        </span>
        <span className="node-fact power-fact">
          <b>{node.telemetry?.power_source ? titleCase(node.telemetry.power_source) : '—'}</b>
          <small>power</small>
        </span>
        <span className={`state-label state-${node.status}`}>{titleCase(node.status)}</span>
        <span className="disclosure" aria-hidden>⌄</span>
      </button>

      {expanded && (
        <div className="node-detail">
          <div className="node-machine-facts">
            <dl>
              <div><dt>Platform</dt><dd>{node.system ? `${node.system.platform} ${node.system.os_version ?? ''}` : 'Legacy node'}</dd></div>
              <div><dt>Architecture</dt><dd>{node.system?.architecture ?? 'Not reported'}</dd></div>
              <div><dt>CPU</dt><dd>{node.system?.cpu_model ?? 'Not reported'}</dd></div>
              <div><dt>System RAM</dt><dd>{formatBytes(node.system?.memory_total_bytes)}</dd></div>
              <div><dt>Available RAM</dt><dd>{formatBytes(node.telemetry?.memory_available_bytes)}</dd></div>
              <div><dt>Thermal state</dt><dd>{titleCase(node.telemetry?.thermal_state ?? 'unknown')}</dd></div>
              <div><dt>mere.run</dt><dd>{node.runtime?.mere_run_version ?? 'Version not reported'}</dd></div>
              <div><dt>Node agent</dt><dd>{node.version || 'Version not reported'}</dd></div>
              <div><dt>Last seen</dt><dd>{relativeTime(node.last_seen)}</dd></div>
            </dl>
            {node.current_job_id && (
              <p className="active-job"><span>Active job</span><code>{node.current_job_id}</code></p>
            )}
          </div>

          <div className="node-models">
            <p className="section-label">Installed models</p>
            {installedModels.length > 0 ? (
              <div>{installedModels.map((model) => <code key={model}>{model}</code>)}</div>
            ) : (
              <p className={`inventory-message inventory-${node.runtime?.inventory_status ?? 'unknown'}`}>
                {inventoryMessage}
                {node.runtime?.diagnostic && <code>{node.runtime.diagnostic}</code>}
              </p>
            )}
          </div>

          <NodeSettings
            node={node}
            busy={busy}
            refreshing={refreshing}
            onUpdate={onUpdate}
            onRefresh={onRefresh}
          />
        </div>
      )}
    </article>
  );
}

function SchedulerPanel({
  fleet,
  busy,
  onMode,
  onRetry,
}: {
  fleet: FleetSnapshot;
  busy: boolean;
  onMode: (mode: SchedulerMode) => Promise<void>;
  onRetry: (retryLimit: number) => Promise<void>;
}): ReactElement {
  return (
    <aside className="scheduler-panel">
      <div className="section-heading">
        <div><p className="eyebrow">Dispatch policy</p><h2>Scheduler</h2></div>
        <span className="live-tag"><i /> active</span>
      </div>
      <div className="scheduler-options">
        {SCHEDULER_MODES.map((mode) => (
          <button
            key={mode.id}
            className={fleet.settings.scheduler_mode === mode.id ? 'selected' : ''}
            disabled={busy}
            onClick={() => void onMode(mode.id)}
          >
            <span>{mode.label}<i aria-hidden /></span>
            <small>{mode.description}</small>
          </button>
        ))}
      </div>
      <dl className="scheduler-facts">
        <div><dt>Available now</dt><dd>{fleet.summary.available_nodes}</dd></div>
        <div><dt>Queued work</dt><dd>{fleet.summary.queue_depth}</dd></div>
        <div>
          <dt>Retry limit</dt>
          <dd>
            <select
              aria-label="Job retry limit"
              value={fleet.settings.retry_limit}
              disabled={busy}
              onChange={(event) => void onRetry(Number(event.target.value))}
            >
              {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </dd>
        </div>
      </dl>
      <p className="scheduler-note">
        Exact model support is required first. Policy scoring only chooses among eligible, idle nodes.
      </p>
    </aside>
  );
}

function ModelDistribution({
  nodes,
  onReload,
}: {
  nodes: FleetNodeRecord[];
  onReload: () => Promise<void>;
}): ReactElement | null {
  const sources = useMemo(
    () => nodes.filter((node) => (node.runtime?.installed_models.length ?? 0) > 0),
    [nodes]
  );
  const [sourceId, setSourceId] = useState(sources[0]?.device_id ?? '');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [targetIds, setTargetIds] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<FleetModelPlan | null>(null);
  const [acceptLicenses, setAcceptLicenses] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = nodes.find((node) => node.device_id === sourceId);
  const sourceModels = useMemo(
    () => [...(source?.runtime?.installed_models ?? [])].sort(),
    [source]
  );

  useEffect(() => {
    if (!sources.some((candidate) => candidate.device_id === sourceId)) {
      setSourceId(sources[0]?.device_id ?? '');
    }
  }, [sourceId, sources]);

  useEffect(() => {
    setSelectedModels(new Set(sourceModels));
    setTargetIds((current) => new Set([...current].filter((deviceId) => deviceId !== sourceId)));
    setPlan(null);
  }, [sourceId, sourceModels]);

  useEffect(() => {
    if (plan?.state !== 'applying') return;
    const timer = window.setTimeout(() => {
      void apiRequest(`/api/fleet/model-plans/${plan.plan_id}`, fleetModelPlanSchema)
        .then(async (updated) => {
          setPlan(updated);
          if (updated.state !== 'applying') await onReload();
        })
        .catch((cause: unknown) => setError(
          cause instanceof Error ? cause.message : 'Model plan refresh failed'
        ));
    }, 1_000);
    return (): void => window.clearTimeout(timer);
  }, [onReload, plan]);

  function toggleModel(modelId: string): void {
    setSelectedModels((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
    setPlan(null);
  }

  function toggleTarget(deviceId: string): void {
    setTargetIds((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
    setPlan(null);
  }

  async function createPlan(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const created = await apiRequest('/api/fleet/model-plans', fleetModelPlanSchema, {
        method: 'POST',
        body: JSON.stringify({
          source_device_id: sourceId,
          target_device_ids: [...targetIds],
          model_ids: [...selectedModels],
        }),
      });
      setPlan(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Model plan failed');
    } finally {
      setBusy(false);
    }
  }

  async function applyPlan(): Promise<void> {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await apiRequest(
        `/api/fleet/model-plans/${plan.plan_id}/apply`,
        fleetModelPlanSchema,
        {
          method: 'POST',
          body: JSON.stringify({ accept_model_licenses: acceptLicenses }),
        }
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Model install failed');
    } finally {
      setBusy(false);
    }
  }

  if (sources.length === 0 || nodes.length < 2) return null;
  const targets = nodes.filter((node) => node.device_id !== sourceId);
  const missingCount = plan?.targets.reduce(
    (total, target) => total + target.missing_model_ids.length,
    0
  ) ?? 0;

  return (
    <section className="model-distribution">
      <div className="section-heading">
        <div><p className="eyebrow">Inventory distribution</p><h2>Install models across nodes</h2></div>
        {plan && <span className={`state-label state-${plan.state}`}>{titleCase(plan.state)}</span>}
      </div>
      {error && <p className="dashboard-error" role="alert">{error}</p>}
      <div className="distribution-grid">
        <div className="distribution-source">
          <label className="control-label" htmlFor="model-source">Source inventory</label>
          <select id="model-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
            {sources.map((candidate) => (
              <option key={candidate.device_id} value={candidate.device_id}>
                {candidate.device_name} · {candidate.runtime?.installed_models.length ?? 0}
              </option>
            ))}
          </select>
          <div className="distribution-toolbar">
            <span>{selectedModels.size} of {sourceModels.length} selected</span>
            <button type="button" className="text-button" onClick={() => setSelectedModels(new Set(sourceModels))}>
              Select all
            </button>
            <button type="button" className="text-button" onClick={() => setSelectedModels(new Set())}>
              Clear
            </button>
          </div>
          <div className="model-checklist">
            {sourceModels.map((modelId) => (
              <label key={modelId}>
                <input
                  type="checkbox"
                  checked={selectedModels.has(modelId)}
                  onChange={() => toggleModel(modelId)}
                />
                <code>{modelId}</code>
              </label>
            ))}
          </div>
        </div>

        <div className="distribution-targets">
          <p className="control-label">Target nodes</p>
          <div className="target-checklist">
            {targets.map((target) => (
              <label key={target.device_id}>
                <input
                  type="checkbox"
                  checked={targetIds.has(target.device_id)}
                  disabled={target.policy.revoked}
                  onChange={() => toggleTarget(target.device_id)}
                />
                <span><strong>{target.device_name}</strong><small>{titleCase(target.status)}</small></span>
                <b>{target.runtime?.installed_models.length ?? 0}</b>
              </label>
            ))}
          </div>
          <button
            className="compact-button distribution-command"
            disabled={busy || selectedModels.size === 0 || targetIds.size === 0}
            onClick={() => void createPlan()}
          >
            {busy && !plan ? 'Planning' : 'Review install plan'}
          </button>

          {plan && (
            <div className="distribution-plan">
              <dl>
                {plan.targets.map((target) => (
                  <div key={target.device_id}>
                    <dt>{target.device_name}</dt>
                    <dd>
                      <b>{target.missing_model_ids.length}</b> missing
                      <span className={`state-label state-${target.state}`}>{titleCase(target.state)}</span>
                    </dd>
                    {target.error && <small>{target.error}</small>}
                  </div>
                ))}
              </dl>
              {missingCount > 0 && plan.state !== 'applying' && plan.state !== 'finished' && (
                <>
                  <label className="license-control">
                    <input
                      type="checkbox"
                      checked={acceptLicenses}
                      onChange={(event) => setAcceptLicenses(event.target.checked)}
                    />
                    Accept model license terms where required
                  </label>
                  <button className="compact-button" disabled={busy} onClick={() => void applyPlan()}>
                    {busy ? 'Starting installs' : `Install ${missingCount} model${missingCount === 1 ? '' : 's'}`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Dashboard({ user, fleet, onReload }: { user: SessionUser; fleet: FleetSnapshot; onReload: () => Promise<void> }): ReactElement {
  const [expandedNode, setExpandedNode] = useState<string | null>(fleet.nodes[0]?.device_id ?? null);
  const [mutation, setMutation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exactModels = useMemo(
    () => fleet.models.filter(({ model }) => model.includes('-') && !['talk-nano'].includes(model)),
    [fleet.models]
  );
  const hasReportedInventory = fleet.nodes.some((node) =>
    node.runtime?.inventory_status === 'reported'
    || node.runtime?.inventory_status === 'empty'
    || (node.runtime?.installed_models?.length ?? 0) > 0
  );

  async function updateNode(deviceId: string, patch: Partial<FleetNodePolicy>): Promise<void> {
    setMutation(`node:${deviceId}`);
    setError(null);
    try {
      await apiRequest(`/api/fleet/nodes/${encodeURIComponent(deviceId)}`, fleetNodeSchema, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Node update failed');
    } finally {
      setMutation(null);
    }
  }

  async function refreshNode(deviceId: string): Promise<void> {
    setMutation(`refresh:${deviceId}`);
    setError(null);
    try {
      await apiRequest(
        `/api/fleet/nodes/${encodeURIComponent(deviceId)}/refresh`,
        fleetRefreshResponseSchema,
        { method: 'POST' }
      );
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      await onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Inventory refresh failed');
    } finally {
      setMutation(null);
    }
  }

  async function updateMode(mode: SchedulerMode): Promise<void> {
    setMutation('settings');
    setError(null);
    try {
      await apiRequest('/api/fleet/settings', fleetSettingsSchema, {
        method: 'PATCH',
        body: JSON.stringify({ scheduler_mode: mode }),
      });
      await onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Scheduler update failed');
    } finally {
      setMutation(null);
    }
  }

  async function updateRetryLimit(retryLimit: number): Promise<void> {
    setMutation('settings');
    setError(null);
    try {
      await apiRequest('/api/fleet/settings', fleetSettingsSchema, {
        method: 'PATCH',
        body: JSON.stringify({ retry_limit: retryLimit }),
      });
      await onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Retry policy update failed');
    } finally {
      setMutation(null);
    }
  }

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <BrandMark />
          <nav aria-label="Primary"><span className="active">Compute</span></nav>
        </div>
        <div className="account-menu">
          <span><b>{user.name || user.email || 'Mere operator'}</b><small>{user.email || 'mere.world account'}</small></span>
          <a href="/auth/logout" title="Sign out">↗</a>
        </div>
      </header>

      <section className="fleet-health" aria-label="Fleet summary">
        <div className="fleet-health-state">
          <span className="fleet-pulse"><i /></span>
          <p><strong>{fleet.summary.online_nodes} of {fleet.summary.total_nodes}</strong> nodes online</p>
          <small>Updated {relativeTime(fleet.generated_at)}</small>
        </div>
        <dl>
          <div><dt>Available</dt><dd>{fleet.summary.available_nodes}</dd></div>
          <div><dt>Working</dt><dd>{fleet.summary.busy_nodes}</dd></div>
          <div><dt>Queued</dt><dd>{fleet.summary.queue_depth}</dd></div>
          <div><dt>Models</dt><dd>{hasReportedInventory ? fleet.summary.installed_models : '—'}</dd></div>
        </dl>
      </section>

      {error && <p className="dashboard-error" role="alert">{error}</p>}

      {fleet.nodes.length === 0 ? <EmptyFleet /> : (
        <>
          <div className="dashboard-primary">
            <section className="nodes-panel">
              <div className="section-heading">
                <div><p className="eyebrow">Account pool</p><h1>Compute nodes</h1></div>
                <button className="refresh-button" onClick={() => void onReload()} aria-label="Refresh fleet">↻</button>
              </div>
              <div className="node-column-labels" aria-hidden>
                <span>Machine</span><span>Models</span><span>Load</span><span>Power</span><span>Status</span>
              </div>
              <div className="node-list">
                {fleet.nodes.map((node) => (
                  <NodeRow
                    key={node.device_id}
                    node={node}
                    expanded={expandedNode === node.device_id}
                    busy={mutation === `node:${node.device_id}` || mutation === `refresh:${node.device_id}`}
                    refreshing={mutation === `refresh:${node.device_id}`}
                    onToggle={() => setExpandedNode((current) => current === node.device_id ? null : node.device_id)}
                    onUpdate={(patch) => updateNode(node.device_id, patch)}
                    onRefresh={() => refreshNode(node.device_id)}
                  />
                ))}
              </div>
            </section>
            <SchedulerPanel
              fleet={fleet}
              busy={mutation === 'settings'}
              onMode={updateMode}
              onRetry={updateRetryLimit}
            />
          </div>

          <ModelDistribution nodes={fleet.nodes} onReload={onReload} />

          <section className="coverage-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Placement map</p><h2>Model coverage</h2></div>
              <span className="section-meta">{exactModels.length} concrete models</span>
            </div>
            {exactModels.length === 0 ? (
              <p className="section-empty">Connected legacy nodes have not reported concrete model inventory yet.</p>
            ) : (
              <div className="coverage-table" role="table" aria-label="Model coverage">
                <div className="table-header" role="row">
                  <span role="columnheader">Model</span><span role="columnheader">Coverage</span>
                  <span role="columnheader">Available</span><span role="columnheader">Fastest</span>
                </div>
                {exactModels.slice(0, 18).map((model) => (
                  <div className="table-row" role="row" key={model.model}>
                    <code role="cell">{model.model}</code>
                    <span role="cell">{model.capable_nodes} {model.capable_nodes === 1 ? 'node' : 'nodes'}</span>
                    <span role="cell" className={model.available_nodes ? 'available' : 'unavailable'}>
                      <i aria-hidden />{model.available_nodes}
                    </span>
                    <span role="cell">{model.fastest_average_ms === null ? 'Learning' : duration(model.fastest_average_ms)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="activity-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Recent work</p><h2>Fleet activity</h2></div>
              <span className="section-meta">Most recent {fleet.activity.length}</span>
            </div>
            {fleet.activity.length === 0 ? (
              <p className="section-empty">No jobs have run through this compute pool yet.</p>
            ) : (
              <div className="activity-list">
                {fleet.activity.slice(0, 16).map((item) => {
                  const node = fleet.nodes.find((candidate) => candidate.agent_id === item.agent_id);
                  return (
                    <div className="activity-row" key={`${item.kind}:${item.id}`}>
                      <span className={`activity-kind kind-${item.kind}`}>{item.kind}</span>
                      <span className="activity-copy"><strong>{item.label}</strong><small>{item.model || node?.device_name || 'Automatic placement'}</small></span>
                      <code>{item.id.slice(0, 18)}</code>
                      <span className={`activity-state state-${item.status}`}><i />{titleCase(item.status)}</span>
                      <span className="activity-duration">{duration(item.duration_ms)}</span>
                      <time dateTime={item.created_at}>{relativeTime(item.created_at)}</time>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <footer className="dashboard-footer">
        <span>relay.mere.run</span>
        <span>Account-scoped · outbound-only nodes · encrypted transport</span>
      </footer>
    </div>
  );
}

export function App(): ReactElement {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFleet = useCallback(async () => {
    try {
      const snapshot = await apiRequest('/api/fleet', fleetSnapshotSchema);
      setFleet(snapshot);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Fleet status could not be loaded');
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async (): Promise<void> => {
      try {
        let response = await fetch('/auth/session', { credentials: 'same-origin' });
        if (response.status === 401 && await refreshSession()) {
          response = await fetch('/auth/session', { credentials: 'same-origin' });
        }
        if (!active) return;
        if (!response.ok) {
          setAuthState('guest');
          return;
        }
        const session = await readResponseJson(response, sessionResponseSchema);
        if (!session.authenticated || !session.user) {
          setAuthState('guest');
          return;
        }
        setUser(session.user);
        setAuthState('authenticated');
        await loadFleet();
      } catch {
        if (active) setAuthState('guest');
      }
    })();
    return (): void => { active = false; };
  }, [loadFleet]);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    const timer = window.setInterval(() => void loadFleet(), 8_000);
    return (): void => window.clearInterval(timer);
  }, [authState, loadFleet]);

  const authError = new URLSearchParams(window.location.search).get('auth_error');
  if (authState === 'loading') return <Skeleton />;
  if (authState === 'guest') return <Landing authError={authError} />;
  if (!user || !fleet) {
    return (
      <div className="load-failure">
        <BrandMark />
        <h1>Fleet status is unavailable.</h1>
        <p>{loadError || 'The relay session is valid, but fleet data did not arrive.'}</p>
        <button className="primary-action" onClick={() => void loadFleet()}>Try again</button>
      </div>
    );
  }
  return <Dashboard user={user} fleet={fleet} onReload={loadFleet} />;
}
