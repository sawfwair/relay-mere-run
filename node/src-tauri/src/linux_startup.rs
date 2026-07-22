//! Linux desktop preflight that runs before WebKitGTK is initialized.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const NVIDIA_VENDOR_ID: &str = "0x10de";
const DMABUF_FALLBACK_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const GIO_MODULE_DIR_ENV: &str = "GIO_MODULE_DIR";
const GIO_EXTRA_MODULES_ENV: &str = "GIO_EXTRA_MODULES";
const NODE_PROCESS_NAME: &str = "mere.run-node";
const LEGACY_NODE_PROCESS_NAME: &str = "mere-run-node";

#[derive(Debug, PartialEq, Eq)]
struct ExistingNodeProcess {
    pid: u32,
    command: String,
}

pub fn prepare() {
    isolate_appimage_gio_modules();

    let effective_uid =
        effective_uid_from_status(&fs::read_to_string("/proc/self/status").unwrap_or_default());

    if effective_uid == Some(0) {
        fatal(
            "mere.run node must not be run with sudo.\n\nLaunch `mere.run-node` as your signed-in desktop user.",
        );
    }

    if let Some(process) = effective_uid
        .and_then(|uid| existing_node_process(Path::new("/proc"), std::process::id(), uid))
    {
        warn(&existing_instance_message(&process));
    }

    if nvidia_drm_present(Path::new("/sys/class/drm"))
        && !nvidia_egl_gbm_available()
        && std::env::var_os(DMABUF_FALLBACK_ENV).is_none()
    {
        // WebKitGTK otherwise opens a window whose webview stays blank while
        // logging DRM_IOCTL_MODE_CREATE_DUMB/GBM permission errors. The node UI
        // is lightweight, so its non-DMABUF renderer is a safe compatibility
        // fallback until the distro's NVIDIA EGL/GBM bridge is installed.
        std::env::set_var(DMABUF_FALLBACK_ENV, "1");
        eprintln!(
            "mere.run node: NVIDIA EGL/GBM bridge not found; using the compatible WebKit renderer.\n\
             For accelerated rendering on Ubuntu, install: sudo apt install libnvidia-egl-gbm1"
        );
    }
}

fn isolate_appimage_gio_modules() {
    let Some(app_dir) = std::env::var_os("APPDIR") else {
        return;
    };
    let Some(module_dir) = bundled_gio_module_dir(Path::new(&app_dir)) else {
        return;
    };

    // AppImages bundle GLib, but GLib's compiled default module path still
    // points at the host. A newer host GVFS module cannot safely load into the
    // bundled GLib, so keep both default and extra discovery inside APPDIR.
    std::env::set_var(GIO_MODULE_DIR_ENV, &module_dir);
    std::env::set_var(GIO_EXTRA_MODULES_ENV, &module_dir);
}

fn bundled_gio_module_dir(app_dir: &Path) -> Option<PathBuf> {
    let library_root = app_dir.join("usr/lib");
    let preferred_triple = if cfg!(target_arch = "aarch64") {
        "aarch64-linux-gnu"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64-linux-gnu"
    } else {
        ""
    };

    let mut candidates = Vec::new();
    if !preferred_triple.is_empty() {
        candidates.push(library_root.join(preferred_triple).join("gio/modules"));
    }
    candidates.push(library_root.join("gio/modules"));

    if let Ok(entries) = fs::read_dir(&library_root) {
        let mut discovered = entries
            .flatten()
            .map(|entry| entry.path().join("gio/modules"))
            .collect::<Vec<_>>();
        discovered.sort();
        candidates.extend(discovered);
    }

    candidates.into_iter().find(|candidate| candidate.is_dir())
}

fn effective_uid_from_status(status: &str) -> Option<u32> {
    let uid_line = status.lines().find(|line| line.starts_with("Uid:"))?;
    uid_line.split_whitespace().nth(2)?.parse().ok()
}

fn process_name_from_status(status: &str) -> Option<&str> {
    status
        .lines()
        .find(|line| line.starts_with("Name:"))?
        .split_whitespace()
        .nth(1)
}

fn is_node_process_name(name: &str) -> bool {
    matches!(name, NODE_PROCESS_NAME | LEGACY_NODE_PROCESS_NAME)
}

fn existing_node_process(
    proc_root: &Path,
    current_pid: u32,
    current_uid: u32,
) -> Option<ExistingNodeProcess> {
    let mut pids = fs::read_dir(proc_root)
        .ok()?
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
        .filter(|pid| *pid != current_pid)
        .collect::<Vec<_>>();
    pids.sort_unstable();

    pids.into_iter().find_map(|pid| {
        let process_root = proc_root.join(pid.to_string());
        let status = fs::read_to_string(process_root.join("status")).ok()?;
        if !process_name_from_status(&status).is_some_and(is_node_process_name)
            || effective_uid_from_status(&status) != Some(current_uid)
        {
            return None;
        }

        let command = fs::read(process_root.join("cmdline"))
            .ok()
            .and_then(|bytes| {
                bytes
                    .split(|byte| *byte == 0)
                    .find(|argument| !argument.is_empty())
                    .map(|argument| String::from_utf8_lossy(argument).into_owned())
            })
            .filter(|command| !command.trim().is_empty())
            .unwrap_or_else(|| NODE_PROCESS_NAME.to_string());

        Some(ExistingNodeProcess { pid, command })
    })
}

fn existing_instance_message(process: &ExistingNodeProcess) -> String {
    format!(
        "Another mere.run node is already running (PID {}):\n{}\n\n\
         Its window will be brought forward. If no window appears or the running copy is older, stop it with:\n\n\
         pkill -x mere.run-node\n\
         pkill -x mere-run-node\n\n\
         Then launch `mere.run-node` {} again.",
        process.pid,
        process.command,
        env!("CARGO_PKG_VERSION")
    )
}

fn nvidia_drm_present(drm_root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(drm_root) else {
        return false;
    };

    entries.flatten().any(|entry| {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("card") {
            return false;
        }
        fs::read_to_string(entry.path().join("device/vendor"))
            .map(|vendor| vendor.trim().eq_ignore_ascii_case(NVIDIA_VENDOR_ID))
            .unwrap_or(false)
    })
}

fn nvidia_egl_gbm_available() -> bool {
    const LIBRARY: &str = "libnvidia-egl-gbm.so.1";
    const LDCONFIG_PATHS: &[&str] = &["/sbin/ldconfig", "/usr/sbin/ldconfig", "ldconfig"];

    LDCONFIG_PATHS.iter().any(|program| {
        Command::new(program)
            .arg("-p")
            .output()
            .map(|output| {
                output.status.success() && String::from_utf8_lossy(&output.stdout).contains(LIBRARY)
            })
            .unwrap_or(false)
    })
}

fn fatal(message: &str) -> ! {
    eprintln!("mere.run node: {message}");

    // A terminal is not guaranteed for desktop-menu launches. Ubuntu desktop
    // images normally include zenity, so use it when available while keeping
    // stderr as the universal fallback.
    let _ = Command::new("zenity")
        .env_remove(GIO_MODULE_DIR_ENV)
        .env_remove(GIO_EXTRA_MODULES_ENV)
        .args(["--error", "--title=mere.run node", "--text", message])
        .status();
    std::process::exit(1)
}

fn warn(message: &str) {
    eprintln!("mere.run node: {message}");

    // This warning is emitted by the newly launched process, so it also works
    // when the process holding the single-instance lock is an older build.
    let _ = Command::new("zenity")
        .env_remove(GIO_MODULE_DIR_ENV)
        .env_remove(GIO_EXTRA_MODULES_ENV)
        .args([
            "--warning",
            "--title=mere.run node is already running",
            "--text",
            message,
        ])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reads_effective_uid_from_proc_status() {
        assert_eq!(
            effective_uid_from_status("Name:\tnode\nUid:\t1000\t42\t1000\t42\n"),
            Some(42)
        );
        assert_eq!(effective_uid_from_status("Name:\tnode\n"), None);
    }

    #[test]
    fn recognizes_canonical_and_legacy_node_process_names() {
        assert!(is_node_process_name("mere.run-node"));
        assert!(is_node_process_name("mere-run-node"));
        assert!(!is_node_process_name("mere-vfx-tools"));
    }

    #[test]
    fn finds_an_existing_node_process_for_the_same_user() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mere-run-node-proc-test-{suffix}"));

        let current = root.join("100");
        fs::create_dir_all(&current).unwrap();
        fs::write(
            current.join("status"),
            "Name:\tmere.run-node\nUid:\t42\t42\t42\t42\n",
        )
        .unwrap();

        let existing = root.join("200");
        fs::create_dir_all(&existing).unwrap();
        fs::write(
            existing.join("status"),
            "Name:\tmere-run-node\nUid:\t42\t42\t42\t42\n",
        )
        .unwrap();
        fs::write(
            existing.join("cmdline"),
            b"./mere.run-node-0.1.1-arm64.AppImage\0--legacy\0",
        )
        .unwrap();

        let foreign = root.join("150");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(
            foreign.join("status"),
            "Name:\tmere-run-node\nUid:\t99\t99\t99\t99\n",
        )
        .unwrap();

        assert_eq!(
            existing_node_process(&root, 100, 42),
            Some(ExistingNodeProcess {
                pid: 200,
                command: "./mere.run-node-0.1.1-arm64.AppImage".to_string(),
            })
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_instance_message_names_the_quick_recovery() {
        let message = existing_instance_message(&ExistingNodeProcess {
            pid: 3892811,
            command: "./mere.run-node-0.1.1-arm64.AppImage".to_string(),
        });

        assert!(message.contains("PID 3892811"));
        assert!(message.contains("mere.run-node-0.1.1-arm64.AppImage"));
        assert!(message.contains("pkill -x mere.run-node"));
        assert!(message.contains("pkill -x mere-run-node"));
        assert!(message.contains("launch `mere.run-node`"));
        assert!(message.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn detects_nvidia_drm_vendor() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mere-run-node-drm-test-{suffix}"));
        let vendor_dir = root.join("card1/device");
        fs::create_dir_all(&vendor_dir).unwrap();
        fs::write(vendor_dir.join("vendor"), "0x10de\n").unwrap();

        assert!(nvidia_drm_present(&root));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_bundled_multiarch_gio_modules() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mere-run-node-appdir-test-{suffix}"));
        let expected = root.join("usr/lib/test-linux-gnu/gio/modules");
        fs::create_dir_all(&expected).unwrap();

        assert_eq!(bundled_gio_module_dir(&root), Some(expected));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_non_appimage_library_trees_without_gio_modules() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mere-run-node-empty-appdir-test-{suffix}"));
        fs::create_dir_all(root.join("usr/lib")).unwrap();

        assert_eq!(bundled_gio_module_dir(&root), None);

        fs::remove_dir_all(root).unwrap();
    }
}
