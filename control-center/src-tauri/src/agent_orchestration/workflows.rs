// agent_orchestration/workflows.rs — built-in workflow definitions.

use super::types::{WorkflowDefinition, WorkflowStep};

/// Hard-coded snapshot of the canonical seven alignments. We pin them
/// here so the UI works on a fresh install with no skill files present.
/// If the user edits the skill markdown the workflow definitions still
/// remain consistent with the documented semantics.
pub fn list_workflows_inner() -> Vec<WorkflowDefinition> {
    // KIRKARDO 26 CRITICAL fix: the previous version referenced 6 ghost
    // slugs (terry-davis, kirkardo, don-claudio, einstein, novalbos,
    // ue5-dev) that exist as SKILLS in ~/.claude/skills/ but NOT as
    // agents in ~/.claude/agents/. Tauri's delegate_task spawns by
    // subagent_type which must resolve to an actual .md file in agents/.
    // 5 of 7 workflows were silently no-op'ing the persona steps.
    //
    // New mapping uses agents that exist on disk (verified 2026-05-27):
    //   terry-davis        → code-reviewer
    //   kirkardo           → qa-expert
    //   don-claudio        → architect-reviewer
    //   einstein           → ai-engineer
    //   novalbos           → llm-architect
    //   ue5-dev            → unreal-engine-engineer
    //
    // The personas still live as skills and continue to be invokable by
    // name from the user prompt; this list is strictly about subagent
    // delegation that touches ~/.claude/agents/.
    vec![
        WorkflowDefinition {
            id: "quick".to_string(),
            label: "Quick fix".to_string(),
            description: "Obvious bugs, simple fixes, fast technical answers.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Quick surgical fix".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("30s validation".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "feature".to_string(),
            label: "New feature".to_string(),
            description: "New features in any project — design first.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "architect-reviewer".to_string(),
                    note: Some("Architect".to_string()),
                },
                WorkflowStep {
                    agent: "fullstack-developer".to_string(),
                    note: Some("TDD implementation".to_string()),
                },
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Quality PR".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "debug".to_string(),
            label: "Stuck debug".to_string(),
            description: "Bugs that have gone over 20 minutes without resolution.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "debugger".to_string(),
                    note: Some("Systematic debugging".to_string()),
                },
                WorkflowStep {
                    agent: "error-detective".to_string(),
                    note: Some("Cross-service correlation".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("Verify fix".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "security".to_string(),
            label: "Security audit".to_string(),
            description: "Before a release, or on new auth / permissions code.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "security-auditor".to_string(),
                    note: Some("OWASP + blast radius".to_string()),
                },
                WorkflowStep {
                    agent: "penetration-tester".to_string(),
                    note: Some("Dependencies + taint".to_string()),
                },
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Final verdict".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "research".to_string(),
            label: "Research first".to_string(),
            description: "Features that need understanding something new first.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "ai-engineer".to_string(),
                    note: Some("Theory + papers".to_string()),
                },
                WorkflowStep {
                    agent: "llm-architect".to_string(),
                    note: Some("Architecture deep dive".to_string()),
                },
                WorkflowStep {
                    agent: "architect-reviewer".to_string(),
                    note: Some("Translate to design".to_string()),
                },
                WorkflowStep {
                    agent: "fullstack-developer".to_string(),
                    note: Some("Implementation".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "game".to_string(),
            label: "Game dev".to_string(),
            description: "Tortunabo / other game projects — engine-specific stack.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "architect-reviewer".to_string(),
                    note: Some("Multiplayer / engine architect".to_string()),
                },
                WorkflowStep {
                    agent: "unreal-engine-engineer".to_string(),
                    note: Some("UE5 C++ + Blueprints".to_string()),
                },
                WorkflowStep {
                    agent: "cpp-pro".to_string(),
                    note: Some("Modern C++ gameplay".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("Review".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "learning".to_string(),
            label: "Learning".to_string(),
            description: "Learn something new deeply, not just copy it.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "llm-architect".to_string(),
                    note: Some("Deep explanation + notes".to_string()),
                },
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Working example".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("Verify correctness".to_string()),
                },
            ],
        },
    ]
}
