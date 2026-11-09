//! Políticas y decisiones del protocolo Codex.
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug)]
pub enum PoliticaCodex {
    Default,
    AcceptEdits,
    Plan,
    BypassPermissions,
}
impl PoliticaCodex {
    pub(crate) fn desde_modo(modo: super::super::types::PermissionMode) -> Result<Self, String> {
        use super::super::types::PermissionMode;
        match modo {
            PermissionMode::Default => Ok(Self::Default),
            PermissionMode::AcceptEdits => Ok(Self::AcceptEdits),
            PermissionMode::Plan => Ok(Self::Plan),
            PermissionMode::BypassPermissions => Ok(Self::BypassPermissions),
            _ => Err(format!(
                "codex no tiene equivalente para el modo {}",
                super::super::lanzamiento::modo_cli(modo)
            )),
        }
    }

    pub(super) fn parametros_turno(self, cwd: &str) -> Value {
        let sandbox = match self {
            Self::Plan => json!({"type":"readOnly","networkAccess":false}),
            Self::BypassPermissions => json!({"type":"dangerFullAccess"}),
            _ => {
                json!({"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
            }
        };
        json!({"approvalPolicy":self.parametros(cwd)["approvalPolicy"],"sandboxPolicy":sandbox})
    }

    pub(super) fn parametros(self, cwd: &str) -> Value {
        let (aprobacion, sandbox) = match self {
            Self::Default => ("untrusted", "workspace-write"),
            Self::AcceptEdits => ("on-request", "workspace-write"),
            Self::Plan => ("on-request", "read-only"),
            Self::BypassPermissions => ("never", "danger-full-access"),
        };
        json!({"cwd":cwd,"approvalPolicy":aprobacion,"sandbox":sandbox})
    }
}

/// Decisiones verificadas con generate-ts de la CLI instalada.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "F4 ofrecerá decisiones distintas de aceptar una vez"
)]
pub enum Decision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
    AcceptWithExecpolicyAmendment {
        execpolicy_amendment: Vec<String>,
    },
    ApplyNetworkPolicyAmendment {
        network_policy_amendment: EnmiendaRed,
    },
}

#[derive(Debug, Serialize)]
pub struct EnmiendaRed {
    pub host: String,
    pub action: AccionRed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code, reason = "F4 permitirá enmiendas de red")]
pub enum AccionRed {
    Allow,
    Deny,
}
