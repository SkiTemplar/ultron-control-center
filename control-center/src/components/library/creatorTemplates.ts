// Creator templates for the in-app Skill / Agent / MCP authoring modals.
//
// Each template seeds the body editor with a battle-tested scaffold so
// the user never starts from a blank textarea. Bodies follow the same
// conventions used across `~/.claude/skills/` and `~/.claude/agents/`:
//   - first line is a `#` H1 with the human name
//   - prose paragraph explaining purpose / trigger conditions
//   - "## Workflow" or "## Process" section with numbered steps
//   - "## Examples" section with at least one realistic invocation
//
// We deliberately do NOT generate the YAML frontmatter here — the backend
// (`library::skill_create_inner`, `library::agent_create_inner`) builds
// frontmatter from the typed form fields so the two stay in sync.

export type SkillTemplateId =
  | "empty"
  | "workflow"
  | "reviewer"
  | "mcp-builder"
  | "domain-expert";

export type AgentTemplateId =
  | "empty"
  | "reviewer"
  | "researcher"
  | "implementer"
  | "debugger"
  | "coordinator";

export type McpTemplateId =
  | "stdio-python"
  | "stdio-node"
  | "http"
  | "sse";

export type SkillTemplate = {
  id: SkillTemplateId;
  label: string;
  hint: string;
  body: string;
};

export type AgentTemplate = {
  id: AgentTemplateId;
  label: string;
  hint: string;
  tools: string[];
  model: "" | "haiku" | "sonnet" | "opus";
  body: string;
};

export type McpTemplateBase = {
  id: McpTemplateId;
  label: string;
  hint: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Array<{ key: string; value: string }>;
  url?: string;
};

// ---------------------------------------------------------------------------
// Skill templates
// ---------------------------------------------------------------------------

const EMPTY_SKILL = `# {NAME}

Describe what this skill does, when to use it, and the workflow.

## When to use

- Trigger phrase 1
- Trigger phrase 2

## Workflow

1. Step one
2. Step two
3. Step three

## Example

Input: ...

Output: ...
`;

const WORKFLOW_SKILL = `# {NAME}

A structured, repeatable workflow. Activate when the user wants to run
this exact pipeline end-to-end.

## When to use

- The user explicitly asks for the workflow by name
- The user describes a problem that matches the workflow trigger

## Workflow

1. **Discover** — gather context, identify constraints
2. **Plan** — decompose into ordered tasks; flag risks
3. **Execute** — run tasks; checkpoint after each
4. **Verify** — confirm acceptance criteria; rerun on failure
5. **Report** — summarise outcomes, list follow-ups

## Outputs

- A short markdown report under \`reports/{NAME}-<date>.md\`
- A list of TODOs added to the active project board

## Example

\`\`\`
User: "run the {NAME} workflow on the auth refactor"
Assistant: <executes 5 phases, returns report>
\`\`\`
`;

const REVIEWER_SKILL = `# {NAME}

Code review skill. Audits a diff or file set against a known checklist,
returns severity-ranked findings with concrete fixes.

## When to use

- The user pastes a diff and asks for review
- The user requests a "second opinion" on uncommitted changes
- Pre-merge gate before opening a PR

## Process

1. List all changed files; identify the dominant language / framework
2. Apply the checklist below for each file
3. Group findings by severity: CRITICAL / HIGH / MEDIUM / LOW
4. For each finding: file, line, problem, suggested fix
5. Block merge on any CRITICAL; warn on HIGH

## Checklist

- Secrets, credentials, hardcoded tokens
- Input validation at trust boundaries
- Error paths handled, no silent swallows
- Tests cover the new behaviour
- No dead code, no commented-out blocks

## Output format

\`\`\`md
### CRITICAL
- path/to/file.ts:42 — <problem> — fix: <suggested change>

### HIGH
...
\`\`\`
`;

const MCP_BUILDER_SKILL = `# {NAME}

Build a new MCP (Model Context Protocol) server end-to-end. Pairs with
the mcp-builder reference skill.

## When to use

- Need to expose an external API to Claude as tools
- Wrapping a CLI, database, or service for agent use
- Migrating an existing tool into the MCP transport

## Phases

1. **Research** — sitemap the target API, list endpoints, auth model
2. **Scaffold** — TypeScript or Python project, transport choice (stdio
   for local, streamable HTTP for remote)
3. **Implement tools** — input schema (Zod / Pydantic), output schema,
   actionable error messages
4. **Evaluations** — 10 realistic, verifiable, read-only QA pairs
5. **Register** — add to \`~/.claude/settings.json\` mcpServers

## Reference

- Spec: https://modelcontextprotocol.io
- TS SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Python SDK: https://github.com/modelcontextprotocol/python-sdk
`;

const DOMAIN_EXPERT_SKILL = `# {NAME}

Domain expert persona. Answers in the voice and frame of a specialist.
Brings opinions, not just facts.

## Personality

- Direct, no hedging
- Cites first principles before invoking authority
- Disagrees explicitly when the user is wrong, with the reason

## When to activate

- The user asks for an opinion in this domain
- The user pastes work and wants a domain critique
- Decision-quality questions where generic answers waste the user's time

## Reference frame

- Three foundational ideas the expert always leans on
- Three common mistakes the expert always catches

## Example

\`\`\`
User: "is this database design sane?"
Assistant: "<opinion with reasoning, then the fix>"
\`\`\`
`;

export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: "empty",
    label: "Empty",
    hint: "Minimal scaffold. Headings only, fill in yourself.",
    body: EMPTY_SKILL,
  },
  {
    id: "workflow",
    label: "Workflow",
    hint: "Repeatable 5-phase pipeline with report output.",
    body: WORKFLOW_SKILL,
  },
  {
    id: "reviewer",
    label: "Code reviewer",
    hint: "Severity-ranked findings with fixes. Pairs with the code-reviewer skill style.",
    body: REVIEWER_SKILL,
  },
  {
    id: "mcp-builder",
    label: "MCP builder",
    hint: "End-to-end MCP server build. Companion to mcp-builder.",
    body: MCP_BUILDER_SKILL,
  },
  {
    id: "domain-expert",
    label: "Domain expert",
    hint: "Opinionated persona with reference frame and personality.",
    body: DOMAIN_EXPERT_SKILL,
  },
];

// ---------------------------------------------------------------------------
// Agent templates
// ---------------------------------------------------------------------------

const EMPTY_AGENT = `# {NAME}

System prompt for this subagent. Describe the role, what to do, and the
output format.

## Inputs

- ...

## Workflow

1. ...

## Outputs

- ...
`;

const REVIEWER_AGENT = `# Code reviewer subagent

You are an expert code reviewer. The parent agent invoked you to audit a
diff or file set and return findings.

## Workflow

1. Read the changed files. Look at imports, function signatures, error
   paths, and tests in that order.
2. Apply the checklist (security, correctness, style, tests).
3. Group findings by severity (CRITICAL / HIGH / MEDIUM / LOW).
4. For each finding, include: file:line, problem, concrete fix.

## Output

Return ONLY markdown. No prose preamble, no closing summary.
\`\`\`md
### CRITICAL
- path:line — problem — fix
\`\`\`
`;

const RESEARCHER_AGENT = `# Researcher subagent

You investigate a question across the codebase, the web, and the user's
notes. You return citations, not opinions.

## Workflow

1. Decompose the question into 2–4 specific sub-questions.
2. For each sub-question: search the codebase first, then GitHub, then
   the open web. Stop when you have a confident answer.
3. Synthesise: short paragraph per sub-question, with explicit citations.

## Output

- One bulleted section per sub-question
- Citations as \`[source](url-or-path)\`
- A final "Confidence" line: high / medium / low, with reasoning
`;

const IMPLEMENTER_AGENT = `# Implementer subagent

You execute a single, well-defined implementation task handed off by the
planner. You stop when the task is done or genuinely blocked.

## Rules

- Write the smallest change that satisfies the task.
- Add or update tests for the new behaviour.
- Never refactor unrelated code.
- If blocked, return a short note describing the blocker; do not guess.

## Output

- Diff summary (files changed, lines added/removed)
- Test status (pass / fail counts)
- Any new TODOs you noticed but did not address
`;

const DEBUGGER_AGENT = `# Debugger subagent

You localise a bug from a failure report and propose a minimal fix.

## Workflow

1. Reproduce the failure locally (or describe what would be needed).
2. Bisect: narrow to a file, then a function, then a line.
3. Explain the root cause in one paragraph.
4. Propose the smallest fix that addresses the cause, not just the symptom.

## Output

- Root cause (1 paragraph)
- Fix (diff or pseudo-diff)
- Regression test that would catch this in the future
`;

const COORDINATOR_AGENT = `# Coordinator subagent

You orchestrate other subagents. You never do the work yourself.

## Workflow

1. Restate the user's goal in one sentence.
2. Decompose into ordered tasks. For each: identify the right subagent.
3. Dispatch tasks in parallel when independent, sequentially when chained.
4. Collect results. If a subagent failed, retry with a corrected prompt.
5. Synthesise the final answer from the subagent outputs.

## Output

- Goal restatement
- Task plan (with subagent assignments)
- Final synthesised answer
`;

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "empty",
    label: "Empty",
    hint: "Minimal subagent scaffold.",
    tools: ["Read", "Grep", "Glob"],
    model: "",
    body: EMPTY_AGENT,
  },
  {
    id: "reviewer",
    label: "Reviewer",
    hint: "Severity-ranked code review with fixes.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    body: REVIEWER_AGENT,
  },
  {
    id: "researcher",
    label: "Researcher",
    hint: "Decomposes questions, returns cited answers.",
    tools: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
    model: "sonnet",
    body: RESEARCHER_AGENT,
  },
  {
    id: "implementer",
    label: "Implementer",
    hint: "Executes one well-scoped task with tests.",
    tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    model: "sonnet",
    body: IMPLEMENTER_AGENT,
  },
  {
    id: "debugger",
    label: "Debugger",
    hint: "Bisects failures, proposes minimal fixes.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    body: DEBUGGER_AGENT,
  },
  {
    id: "coordinator",
    label: "Coordinator",
    hint: "Orchestrates other subagents.",
    tools: ["Read", "Grep", "Glob"],
    model: "opus",
    body: COORDINATOR_AGENT,
  },
];

// ---------------------------------------------------------------------------
// MCP templates
// ---------------------------------------------------------------------------

export const MCP_TEMPLATES: McpTemplateBase[] = [
  {
    id: "stdio-python",
    label: "stdio · Python (uvx)",
    hint: "Local Python MCP server invoked via uvx.",
    transport: "stdio",
    command: "uvx",
    args: ["<package-name>"],
    env: [],
  },
  {
    id: "stdio-node",
    label: "stdio · Node (npx)",
    hint: "Local Node MCP server invoked via npx.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-<name>"],
    env: [],
  },
  {
    id: "http",
    label: "HTTP (streamable)",
    hint: "Remote MCP server over streamable HTTP. Auth via env header.",
    transport: "http",
    url: "https://api.example.com/mcp",
    env: [{ key: "AUTH_TOKEN", value: "${MY_AUTH_TOKEN}" }],
  },
  {
    id: "sse",
    label: "SSE (legacy)",
    hint: "Server-Sent Events transport — legacy, only when the server requires it.",
    transport: "sse",
    url: "https://api.example.com/sse",
    env: [],
  },
];

// ---------------------------------------------------------------------------
// Frontmatter validation helpers (shared by Skill + Agent creators)
// ---------------------------------------------------------------------------

export const COMMON_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
] as const;

export const MIN_BODY_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 240;

/** Inject the human-readable name into a template body. */
export function applyName(template: string, name: string): string {
  const display = name || "skill";
  return template.split("{NAME}").join(display);
}
