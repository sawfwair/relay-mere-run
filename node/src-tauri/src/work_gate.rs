use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkGateState {
    pub busy: bool,
    pub accepting: bool,
    pub source: String,
    pub work_id: String,
}

impl WorkGateState {
    fn idle() -> Self {
        Self {
            busy: false,
            accepting: true,
            source: String::new(),
            work_id: String::new(),
        }
    }
}

#[derive(Clone)]
pub struct DeviceWorkGate {
    semaphore: Arc<Semaphore>,
    state: watch::Sender<WorkGateState>,
}

impl Default for DeviceWorkGate {
    fn default() -> Self {
        let (state, _) = watch::channel(WorkGateState::idle());
        Self {
            semaphore: Arc::new(Semaphore::new(1)),
            state,
        }
    }
}

impl DeviceWorkGate {
    pub fn subscribe(&self) -> watch::Receiver<WorkGateState> {
        self.state.subscribe()
    }

    pub fn current(&self) -> WorkGateState {
        self.state.borrow().clone()
    }

    pub fn begin_drain(&self) {
        self.state.send_modify(|state| {
            state.accepting = false;
            if !state.busy {
                state.busy = true;
                state.source = "node-control".to_string();
                state.work_id = "draining".to_string();
            }
        });
    }

    pub fn resume(&self) {
        self.state.send_modify(|state| {
            state.accepting = true;
            if state.source == "node-control" {
                *state = WorkGateState::idle();
            }
        });
    }

    pub fn is_accepting(&self) -> bool {
        self.state.borrow().accepting
    }

    pub async fn acquire(&self, source: &str, work_id: &str) -> WorkPermit {
        let permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .expect("device work gate never closes");
        let state = WorkGateState {
            busy: true,
            accepting: self.state.borrow().accepting,
            source: source.to_string(),
            work_id: work_id.to_string(),
        };
        self.state.send_replace(state);
        WorkPermit {
            gate: self.clone(),
            _permit: permit,
        }
    }

    pub fn try_acquire(&self, source: &str, work_id: &str) -> Option<WorkPermit> {
        if !self.is_accepting() {
            return None;
        }
        let permit = self.semaphore.clone().try_acquire_owned().ok()?;
        if !self.is_accepting() {
            return None;
        }
        let state = WorkGateState {
            busy: true,
            accepting: true,
            source: source.to_string(),
            work_id: work_id.to_string(),
        };
        self.state.send_replace(state);
        Some(WorkPermit {
            gate: self.clone(),
            _permit: permit,
        })
    }
}

pub struct WorkPermit {
    gate: DeviceWorkGate,
    _permit: OwnedSemaphorePermit,
}

impl Drop for WorkPermit {
    fn drop(&mut self) {
        self.gate.state.send_modify(|state| {
            if state.accepting {
                *state = WorkGateState::idle();
            } else {
                state.busy = true;
                state.source = "node-control".to_string();
                state.work_id = "draining".to_string();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serializes_relay_work() {
        let gate = DeviceWorkGate::default();
        let first = gate.acquire("relay", "tool-1").await;
        assert_eq!(gate.current().source, "relay");

        let waiting_gate = gate.clone();
        let waiter = tokio::spawn(async move {
            let _permit = waiting_gate.acquire("relay", "graph-1").await;
            waiting_gate.current()
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        drop(first);
        let state = waiter.await.expect("waiter completes");
        assert_eq!(state.source, "relay");
        assert_eq!(state.work_id, "graph-1");
    }

    #[tokio::test]
    async fn drain_stays_busy_after_active_work_finishes() {
        let gate = DeviceWorkGate::default();
        let active = gate.acquire("relay", "tool-1").await;
        gate.begin_drain();
        assert!(!gate.is_accepting());
        assert_eq!(gate.current().source, "relay");
        drop(active);
        assert_eq!(gate.current().source, "node-control");
        assert_eq!(gate.current().work_id, "draining");
        gate.resume();
        assert!(!gate.current().busy);
        assert!(gate.is_accepting());
    }

    #[test]
    fn immediate_acquire_rejects_busy_and_draining_gate() {
        let gate = DeviceWorkGate::default();
        let active = gate
            .try_acquire("relay", "asr-stream-1")
            .expect("idle gate accepts live ASR");
        assert!(gate.try_acquire("relay", "asr-stream-2").is_none());
        drop(active);

        gate.begin_drain();
        assert!(gate.try_acquire("relay", "asr-stream-3").is_none());
    }
}
