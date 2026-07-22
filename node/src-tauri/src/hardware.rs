use chrono::Utc;
use std::fs;
use std::path::Path;
use tokio::process::Command;

use crate::protocol::{AgentAcceleratorInfo, AgentSystemInfo, AgentTelemetry};

async fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn parse_meminfo_value(contents: &str, key: &str) -> Option<u64> {
    let line = contents.lines().find(|line| line.starts_with(key))?;
    let kib = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(kib * 1024)
}

fn linux_memory(key: &str) -> Option<u64> {
    parse_meminfo_value(&fs::read_to_string("/proc/meminfo").ok()?, key)
}

async fn cpu_model() -> Option<String> {
    if cfg!(target_os = "macos") {
        return command_output("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"]).await;
    }
    if cfg!(target_os = "linux") {
        let cpuinfo = fs::read_to_string("/proc/cpuinfo").ok()?;
        return cpuinfo.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            matches!(key.trim(), "model name" | "Hardware" | "Processor")
                .then(|| value.trim().to_string())
        });
    }
    if cfg!(target_os = "windows") {
        let output = command_output("wmic", &["cpu", "get", "Name", "/value"]).await?;
        return output
            .lines()
            .find_map(|line| line.strip_prefix("Name=").map(str::to_string));
    }
    None
}

async fn os_version() -> Option<String> {
    if cfg!(target_os = "macos") {
        return command_output("/usr/bin/sw_vers", &["-productVersion"]).await;
    }
    if cfg!(target_os = "windows") {
        return command_output("cmd", &["/C", "ver"]).await;
    }
    command_output("uname", &["-r"]).await
}

async fn total_memory_bytes() -> Option<u64> {
    if cfg!(target_os = "macos") {
        return command_output("/usr/sbin/sysctl", &["-n", "hw.memsize"])
            .await?
            .parse()
            .ok();
    }
    if cfg!(target_os = "linux") {
        return linux_memory("MemTotal:");
    }
    if cfg!(target_os = "windows") {
        let output = command_output(
            "wmic",
            &["computersystem", "get", "TotalPhysicalMemory", "/value"],
        )
        .await?;
        return output.lines().find_map(|line| {
            line.strip_prefix("TotalPhysicalMemory=")?
                .trim()
                .parse::<u64>()
                .ok()
        });
    }
    None
}

fn parse_nvidia_inventory(output: &str) -> Vec<AgentAcceleratorInfo> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let (name, memory_mib) = line.rsplit_once(',')?;
            Some(AgentAcceleratorInfo {
                backend: "cuda".to_string(),
                name: name.trim().to_string(),
                memory_total_bytes: memory_mib
                    .trim()
                    .parse::<u64>()
                    .ok()
                    .map(|value| value * 1024 * 1024),
                index: Some(index as u32),
            })
        })
        .collect()
}

async fn accelerators(
    cpu: Option<&str>,
    memory_total_bytes: Option<u64>,
) -> Vec<AgentAcceleratorInfo> {
    if let Some(output) = command_output(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
    )
    .await
    {
        let accelerators = parse_nvidia_inventory(&output);
        if !accelerators.is_empty() {
            return accelerators;
        }
    }

    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return vec![AgentAcceleratorInfo {
            backend: "metal".to_string(),
            name: cpu.unwrap_or("Apple Silicon GPU").to_string(),
            memory_total_bytes,
            index: Some(0),
        }];
    }

    if command_output("rocminfo", &[]).await.is_some() {
        return vec![AgentAcceleratorInfo {
            backend: "rocm".to_string(),
            name: "AMD ROCm accelerator".to_string(),
            memory_total_bytes: None,
            index: Some(0),
        }];
    }

    vec![AgentAcceleratorInfo {
        backend: "cpu".to_string(),
        name: cpu.unwrap_or("CPU").to_string(),
        memory_total_bytes,
        index: Some(0),
    }]
}

pub async fn collect_system_info() -> AgentSystemInfo {
    let cpu = cpu_model().await;
    let memory_total_bytes = total_memory_bytes().await;
    AgentSystemInfo {
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        os_version: os_version().await,
        hostname: hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok()),
        cpu_model: cpu.clone(),
        logical_cores: std::thread::available_parallelism()
            .ok()
            .map(|count| count.get() as u32),
        memory_total_bytes,
        accelerators: accelerators(cpu.as_deref(), memory_total_bytes).await,
    }
}

fn parse_vm_stat(contents: &str) -> Option<u64> {
    let page_size = contents
        .lines()
        .next()?
        .split_whitespace()
        .find_map(|part| part.trim_end_matches('.').parse::<u64>().ok())?;
    let pages = contents.lines().skip(1).filter_map(|line| {
        let (label, value) = line.split_once(':')?;
        matches!(
            label.trim(),
            "Pages free" | "Pages inactive" | "Pages speculative" | "Pages purgeable"
        )
        .then(|| value.trim().trim_end_matches('.').parse::<u64>().ok())?
    });
    Some(pages.sum::<u64>() * page_size)
}

async fn available_memory_bytes() -> Option<u64> {
    if cfg!(target_os = "macos") {
        return parse_vm_stat(&command_output("/usr/bin/vm_stat", &[]).await?);
    }
    if cfg!(target_os = "linux") {
        return linux_memory("MemAvailable:");
    }
    None
}

fn normalized_load_average(load: f64) -> Option<f64> {
    let cores = std::thread::available_parallelism().ok()?.get() as f64;
    Some(((load / cores) * 100.0).clamp(0.0, 100.0))
}

async fn cpu_load_percent() -> Option<f64> {
    if cfg!(target_os = "linux") {
        let load = fs::read_to_string("/proc/loadavg")
            .ok()?
            .split_whitespace()
            .next()?
            .parse::<f64>()
            .ok()?;
        return normalized_load_average(load);
    }
    if cfg!(target_os = "macos") {
        let output = command_output("/usr/sbin/sysctl", &["-n", "vm.loadavg"]).await?;
        let load = output
            .trim_matches(|character| character == '{' || character == '}')
            .split_whitespace()
            .next()?
            .parse::<f64>()
            .ok()?;
        return normalized_load_average(load);
    }
    None
}

fn parse_nvidia_telemetry(output: &str) -> (Option<f64>, Option<u64>, Option<u64>) {
    let first = output.lines().next().unwrap_or_default();
    let values = first.split(',').map(str::trim).collect::<Vec<_>>();
    (
        values.first().and_then(|value| value.parse::<f64>().ok()),
        values
            .get(1)
            .and_then(|value| value.parse::<u64>().ok())
            .map(|value| value * 1024 * 1024),
        values
            .get(2)
            .and_then(|value| value.parse::<u64>().ok())
            .map(|value| value * 1024 * 1024),
    )
}

fn parse_battery_percent(output: &str) -> Option<f64> {
    output.split_whitespace().find_map(|token| {
        token
            .trim_end_matches(';')
            .strip_suffix('%')?
            .parse::<f64>()
            .ok()
    })
}

fn parse_low_power_mode(output: &str) -> Option<bool> {
    output.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        (fields.next()? == "lowpowermode").then(|| fields.next().map(|value| value == "1"))?
    })
}

fn is_external_power_supply(kind: &str) -> bool {
    matches!(
        kind,
        "Mains" | "USB" | "USB_C" | "USB_PD" | "USB_PD_DRP" | "Wireless"
    )
}

fn linux_power_state(root: &Path) -> (Option<String>, Option<f64>, Option<bool>) {
    let Ok(entries) = fs::read_dir(root) else {
        // Desktop Linux machines commonly expose no power_supply entries at
        // all. With no battery, the machine is necessarily externally powered.
        return (Some("external".to_string()), None, None);
    };

    let mut saw_supply = false;
    let mut saw_external = false;
    let mut external_online = false;
    let mut has_battery = false;
    let mut battery = None;

    for entry in entries.flatten() {
        let path = entry.path();
        let kind = fs::read_to_string(path.join("type")).unwrap_or_default();
        let kind = kind.trim();
        if kind.is_empty() {
            continue;
        }
        saw_supply = true;

        if kind == "Battery" {
            has_battery = true;
            battery = fs::read_to_string(path.join("capacity"))
                .ok()
                .and_then(|value| value.trim().parse::<f64>().ok());
        } else if is_external_power_supply(kind) {
            saw_external = true;
            external_online |= fs::read_to_string(path.join("online"))
                .ok()
                .is_some_and(|value| value.trim() == "1");
        }
    }

    let source = if external_online || (!has_battery && (!saw_supply || saw_external)) {
        "external"
    } else if has_battery {
        "battery"
    } else {
        "unknown"
    };
    (Some(source.to_string()), battery, None)
}

async fn power_state() -> (Option<String>, Option<f64>, Option<bool>) {
    if cfg!(target_os = "macos") {
        let Some(output) = command_output("/usr/bin/pmset", &["-g", "batt"]).await else {
            return (None, None, None);
        };
        let source = if output.contains("AC Power") {
            Some("ac".to_string())
        } else if output.contains("Battery Power") {
            Some("battery".to_string())
        } else {
            Some("unknown".to_string())
        };
        let battery = parse_battery_percent(&output);
        let low_power_mode = command_output("/usr/bin/pmset", &["-g"])
            .await
            .as_deref()
            .and_then(parse_low_power_mode);
        return (source, battery, low_power_mode);
    }

    if cfg!(target_os = "linux") {
        return linux_power_state(Path::new("/sys/class/power_supply"));
    }

    (Some("unknown".to_string()), None, None)
}

fn linux_thermal_state() -> Option<String> {
    let root = Path::new("/sys/class/thermal");
    let max_celsius = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| fs::read_to_string(entry.path().join("temp")).ok())
        .filter_map(|value| value.trim().parse::<f64>().ok())
        .map(|value| {
            if value > 1000.0 {
                value / 1000.0
            } else {
                value
            }
        })
        .fold(0.0_f64, f64::max);
    Some(
        if max_celsius >= 90.0 {
            "critical"
        } else if max_celsius >= 80.0 {
            "serious"
        } else if max_celsius >= 70.0 {
            "fair"
        } else {
            "nominal"
        }
        .to_string(),
    )
}

pub async fn collect_telemetry() -> AgentTelemetry {
    let nvidia = command_output(
        "nvidia-smi",
        &[
            "--query-gpu=utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ],
    )
    .await;
    let (
        accelerator_utilization_percent,
        accelerator_memory_used_bytes,
        accelerator_memory_total_bytes,
    ) = nvidia
        .as_deref()
        .map(parse_nvidia_telemetry)
        .unwrap_or((None, None, None));
    let (power_source, battery_percent, low_power_mode) = power_state().await;

    AgentTelemetry {
        sampled_at: Utc::now().to_rfc3339(),
        cpu_load_percent: cpu_load_percent().await,
        memory_available_bytes: available_memory_bytes().await,
        accelerator_utilization_percent,
        accelerator_memory_used_bytes,
        accelerator_memory_total_bytes,
        power_source,
        battery_percent,
        low_power_mode,
        thermal_state: if cfg!(target_os = "linux") {
            linux_thermal_state()
        } else {
            Some("unknown".to_string())
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_inventory() {
        let inventory = parse_nvidia_inventory("NVIDIA GB10, 119815\nNVIDIA RTX 4090, 24564");
        assert_eq!(inventory.len(), 2);
        assert_eq!(inventory[0].backend, "cuda");
        assert_eq!(inventory[0].memory_total_bytes, Some(119815 * 1024 * 1024));
    }

    #[test]
    fn parses_linux_memory() {
        assert_eq!(
            parse_meminfo_value("MemTotal:       16384 kB\nMemFree: 2 kB", "MemTotal:"),
            Some(16_777_216)
        );
    }

    #[test]
    fn parses_nvidia_telemetry_row() {
        assert_eq!(
            parse_nvidia_telemetry("72, 4096, 24564"),
            (
                Some(72.0),
                Some(4096 * 1024 * 1024),
                Some(24564 * 1024 * 1024)
            )
        );
    }

    #[test]
    fn parses_macos_battery_and_low_power_state() {
        assert_eq!(
            parse_battery_percent("Now drawing from 'Battery Power'\n -InternalBattery-0 73%; discharging; 4:21 remaining"),
            Some(73.0)
        );
        assert_eq!(
            parse_low_power_mode(" lowpowermode         1\n standby              1"),
            Some(true)
        );
    }

    #[test]
    fn reports_external_power_for_linux_desktops_without_a_battery() {
        let root = temporary_test_dir("power-desktop");
        fs::create_dir_all(&root).unwrap();

        assert_eq!(
            linux_power_state(&root),
            (Some("external".to_string()), None, None)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_linux_external_and_battery_power_supplies() {
        let root = temporary_test_dir("power-supplies");
        fs::create_dir_all(root.join("AC")).unwrap();
        fs::write(root.join("AC/type"), "Mains\n").unwrap();
        fs::write(root.join("AC/online"), "1\n").unwrap();
        fs::create_dir_all(root.join("BAT0")).unwrap();
        fs::write(root.join("BAT0/type"), "Battery\n").unwrap();
        fs::write(root.join("BAT0/capacity"), "87\n").unwrap();

        assert_eq!(
            linux_power_state(&root),
            (Some("external".to_string()), Some(87.0), None)
        );

        fs::remove_dir_all(root).unwrap();
    }

    fn temporary_test_dir(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mere-run-node-{label}-{suffix}"))
    }
}
