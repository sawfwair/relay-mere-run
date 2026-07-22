export type FleetNodeStatus = 'online' | 'busy' | 'offline' | 'disabled' | 'draining' | 'revoked';
export type SchedulerMode = 'balanced' | 'fastest' | 'efficient';
export type ModelInventoryStatus = 'reported' | 'empty' | 'unavailable' | 'failed';
export type RuntimeDiagnostic =
  | 'mere_run_not_found'
  | 'version_command_unavailable'
  | 'version_command_failed'
  | 'version_output_empty'
  | 'inventory_commands_failed';

export interface FleetNodePolicy {
  enabled: boolean;
  draining: boolean;
  revoked: boolean;
  priority: number;
  preferred_models: string[];
  display_name: string | null;
}

export interface FleetNodeRecord {
  agent_id: string;
  device_id: string;
  device_name: string;
  reported_name: string;
  version: string;
  status: FleetNodeStatus;
  current_job_id: string | null;
  first_seen: string;
  last_seen: string;
  connected_at: string | null;
  capabilities: {
    models: string[];
    max_resolution: number;
    controlnet: boolean;
    lora: boolean;
    img2img: boolean;
    plugins?: Array<{ name: string; commands: string[] }>;
  };
  system?: {
    platform: string;
    architecture: string;
    os_version?: string;
    hostname?: string;
    cpu_model?: string;
    logical_cores?: number;
    memory_total_bytes?: number;
    accelerators: Array<{
      backend: string;
      name: string;
      memory_total_bytes?: number;
      index?: number;
    }>;
  };
  runtime?: {
    mere_run_version?: string;
    installed_models: string[];
    inventory_status?: ModelInventoryStatus;
    diagnostic?: RuntimeDiagnostic;
  };
  telemetry?: {
    sampled_at: string;
    cpu_load_percent?: number;
    memory_available_bytes?: number;
    accelerator_utilization_percent?: number;
    accelerator_memory_used_bytes?: number;
    accelerator_memory_total_bytes?: number;
    power_source?: string;
    battery_percent?: number;
    low_power_mode?: boolean;
    thermal_state?: string;
  };
  policy: FleetNodePolicy;
  performance: {
    models: Record<string, {
      successes: number;
      failures: number;
      average_generation_time_ms: number | null;
      last_generation_time_ms: number | null;
      updated_at: string;
    }>;
  };
}

export interface FleetSnapshot {
  generated_at: string;
  settings: {
    scheduler_mode: SchedulerMode;
    retry_limit: number;
    updated_at: string;
  };
  summary: {
    total_nodes: number;
    online_nodes: number;
    busy_nodes: number;
    available_nodes: number;
    queue_depth: number;
    installed_models: number;
    routable_models: number;
  };
  nodes: FleetNodeRecord[];
  models: Array<{
    model: string;
    capable_nodes: number;
    available_nodes: number;
    fastest_average_ms: number | null;
  }>;
  activity: Array<{
    id: string;
    kind: string;
    status: string;
    agent_id: string | null;
    model?: string;
    label: string;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    duration_ms: number | null;
    error: string | null;
  }>;
}

export type FleetModelPlanState = 'planned' | 'applying' | 'finished' | 'failed' | 'cancelled';

export interface FleetModelPlan {
  schema_version: 1;
  kind: 'mere.run/fleet-model-plan';
  plan_id: string;
  source_device_id: string | null;
  model_ids: string[];
  targets: Array<{
    device_id: string;
    device_name: string;
    installed_model_ids: string[];
    missing_model_ids: string[];
    state: 'ready' | 'noop' | 'offline' | 'applying' | 'finished' | 'failed' | 'cancelled';
    results: Array<{
      model_id: string;
      state: 'installed' | 'already_installed' | 'failed' | 'cancelled';
      error?: string;
    }>;
    error: string | null;
    started_at: string | null;
    completed_at: string | null;
  }>;
  events: Array<{
    sequence: number;
    created_at: string;
    device_id: string;
    model_id?: string;
    phase: string;
    message?: string;
  }>;
  attempt: number;
  state: FleetModelPlanState;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  completed_at: string | null;
}

export interface SessionUser {
  user_id: string;
  email?: string;
  name?: string;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: SessionUser;
}
