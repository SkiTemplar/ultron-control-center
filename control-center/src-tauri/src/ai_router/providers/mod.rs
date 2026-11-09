// ai_router/providers — Per-provider HTTP wrappers and routing logic.
//
// Groups:
//   call_wrappers — truncate, clamp_max_tokens, call_anthropic, call_openai_compat,
//                   call_gemini, call_ollama, try_assignment_call
//   metrics       — MetricSample, bump_metrics, apply_metric_sample,
//                   record_route_outcome, apply_route_outcome
//   routing       — primary_model_for_zone, route, attempt_assignment

pub(crate) mod call_wrappers;
pub(crate) mod metrics;
pub(crate) mod routing;

// Public API consumed by other crate modules (memory, hooks_admin, sessions_tags, etc.)
pub use routing::{primary_model_for_zone, route};

// Used by exec.rs at runtime via `super::providers::truncate`.
pub(crate) use call_wrappers::truncate;

// Re-exports needed only by the test suite — wrapped in cfg(test) to avoid
// unused-import warnings in non-test builds.
#[cfg(test)]
pub(crate) use call_wrappers::clamp_max_tokens;
#[cfg(test)]
pub(crate) use metrics::{apply_metric_sample, apply_route_outcome, MetricSample};
