//! Runtime-independent observation boundary for the shared Relay agent.
use serde_json::Value;

pub trait NodeEvents: Clone + Send + Sync + 'static {
    fn emit_event(&self, event: &str, payload: Value);
}

#[cfg(test)]
#[derive(Clone)]
pub struct NoopEvents;

#[cfg(test)]
impl NodeEvents for NoopEvents {
    fn emit_event(&self, _event: &str, _payload: Value) {}
}
