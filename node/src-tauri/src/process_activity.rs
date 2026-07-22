//! Process-lifetime power assertions for the active Node supervisor.

#[cfg(target_os = "macos")]
mod platform {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use std::sync::mpsc::{self, Sender};
    use std::thread::{self, JoinHandle};

    const REASON: &str = "Keep the mere.run Node responsive to Relay work";

    /// Owns the Foundation activity for exactly as long as the Relay supervisor
    /// runs. Foundation's opaque activity token is not `Send`, so it stays on a
    /// dedicated native thread while this Send-safe guard crosses async awaits.
    pub struct NodeRuntimeActivity {
        stop: Option<Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    impl NodeRuntimeActivity {
        fn begin() -> Self {
            let (stop, stop_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(0);
            let thread = thread::Builder::new()
                .name("mere-run-node-activity".to_string())
                .spawn(move || {
                    let process_info = NSProcessInfo::processInfo();
                    let reason = NSString::from_str(REASON);
                    let activity = process_info
                        .beginActivityWithOptions_reason(node_runtime_options(), &reason);
                    ready_tx
                        .send(())
                        .expect("Node activity owner disappeared during startup");
                    let _ = stop_rx.recv();
                    // SAFETY: `activity` came from this same NSProcessInfo
                    // instance, never left this thread, and is ended once.
                    unsafe { process_info.endActivity(&activity) };
                })
                .expect("Could not start the native Node activity owner");
            ready_rx
                .recv()
                .expect("Native Node activity owner stopped during startup");
            Self {
                stop: Some(stop),
                thread: Some(thread),
            }
        }
    }

    impl Drop for NodeRuntimeActivity {
        fn drop(&mut self) {
            drop(self.stop.take());
            if let Some(thread) = self.thread.take() {
                thread
                    .join()
                    .expect("Native Node activity owner did not stop cleanly");
            }
        }
    }

    fn node_runtime_options() -> NSActivityOptions {
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
    }

    pub fn begin_node_runtime_activity() -> NodeRuntimeActivity {
        NodeRuntimeActivity::begin()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn runtime_activity_prevents_app_nap_without_forcing_system_awake() {
            let options = node_runtime_options();
            assert_eq!(
                options,
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
            );
            assert!(!options.contains(NSActivityOptions::IdleSystemSleepDisabled));
        }

        #[test]
        fn native_activity_token_can_be_acquired_and_released() {
            drop(begin_node_runtime_activity());
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub struct NodeRuntimeActivity;

    pub fn begin_node_runtime_activity() -> NodeRuntimeActivity {
        NodeRuntimeActivity
    }
}

pub use platform::begin_node_runtime_activity;
