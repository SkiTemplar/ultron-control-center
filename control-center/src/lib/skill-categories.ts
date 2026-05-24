// Domain classification for global/project skills and agents.
//
// The path-based deriveSubGroup in Skills/Agents.tsx only knows about
// on-disk folder structure, so personal global skills (alfred, terry-davis,
// cpp-pro, …) all collapse into "uncategorized" in the Blocks view. This
// module gives them real sub-categories by looking up the name in an
// explicit map and falling back to keyword heuristics.
//
// Keep the mapping conservative — when in doubt, return null and let the
// caller use the path-based fallback. False categorisations are worse than
// landing in "Uncategorized".

export type Domain =
  | "Personas"
  | "C++ & Systems"
  | "Rust"
  | "Python"
  | "Go"
  | "TypeScript / JS"
  | "Java / JVM"
  | "C# / .NET"
  | "Mobile (Swift / Kotlin)"
  | "Game Dev"
  | "Graphics"
  | "AI Engineering"
  | "Agent Frameworks"
  | "Architecture"
  | "Frontend / UI"
  | "Backend / APIs"
  | "DevOps & Cloud"
  | "Database"
  | "Security"
  | "Quality & Review"
  | "Testing"
  | "Performance"
  | "Documentation"
  | "Research & Writing"
  | "Workflow & Productivity"
  | "Memory & Knowledge"
  | "MCP & Tools"
  | "Healthcare"
  | "Network & Homelab"
  | "Finance & Business";

// Exact-name → domain. Slugs taken from the actual skill/agent inventory.
const EXACT_MAP: Record<string, Domain> = {
  // ---- Personas ----------------------------------------------------------
  alfred: "Personas",
  "don-claudio": "Personas",
  "mike-tyson": "Personas",
  tolkien: "Personas",
  "tio-gilito": "Personas",
  warren: "Personas",
  "jordan-belfort": "Personas",
  pana: "Personas",
  novalbos: "Personas",
  einstein: "Personas",
  "terry-davis": "Personas",
  "loki-mode": "Personas",
  ultron: "Personas",
  "repo-evaluator": "Personas",

  // ---- C++ & Systems -----------------------------------------------------
  "cpp-pro": "C++ & Systems",
  "cpp-coding-standards": "C++ & Systems",
  "cpp-testing": "C++ & Systems",

  // ---- Rust --------------------------------------------------------------
  "rust-engineer": "Rust",
  "rust-patterns": "Rust",
  "rust-testing": "Rust",

  // ---- Python ------------------------------------------------------------
  "python-pro": "Python",
  "python-patterns": "Python",
  "python-testing": "Python",

  // ---- Go ----------------------------------------------------------------
  "golang-pro": "Go",
  "golang-patterns": "Go",
  "golang-testing": "Go",

  // ---- TypeScript / JS ---------------------------------------------------
  "typescript-pro": "TypeScript / JS",
  "javascript-pro": "TypeScript / JS",
  "nextjs-developer": "TypeScript / JS",
  "nextjs-turbopack": "TypeScript / JS",
  "vite-patterns": "TypeScript / JS",
  "react-specialist": "TypeScript / JS",
  "vue-expert": "TypeScript / JS",

  // ---- Java / JVM --------------------------------------------------------
  "java-architect": "Java / JVM",

  // ---- C# / .NET ---------------------------------------------------------
  "csharp-developer": "C# / .NET",
  "powershell-5.1-expert": "C# / .NET",
  "powershell-7-expert": "C# / .NET",

  // ---- Mobile ------------------------------------------------------------
  "swift-expert": "Mobile (Swift / Kotlin)",
  "kotlin-specialist": "Mobile (Swift / Kotlin)",
  "mobile-developer": "Mobile (Swift / Kotlin)",

  // ---- Game Dev ----------------------------------------------------------
  "gamedev-engineer": "Game Dev",
  "ue5-dev": "Game Dev",
  "unreal-engine-engineer": "Game Dev",
  "unity-engineer": "Game Dev",

  // ---- Graphics ----------------------------------------------------------
  "graphics-programmer": "Graphics",
  "shader-fundamentals": "Graphics",

  // ---- AI Engineering ----------------------------------------------------
  "ai-engineer": "AI Engineering",
  "llm-architect": "AI Engineering",
  "ml-engineer": "AI Engineering",
  "prompt-engineer": "AI Engineering",
  "prompt-optimizer": "AI Engineering",

  // ---- Agent Frameworks --------------------------------------------------
  "agentic-engineering": "Agent Frameworks",
  "agentic-os": "Agent Frameworks",
  "agent-architecture-audit": "Agent Frameworks",
  "agent-harness-construction": "Agent Frameworks",
  "autonomous-agent-harness": "Agent Frameworks",
  "autonomous-loops": "Agent Frameworks",
  "continuous-agent-loop": "Agent Frameworks",
  "continuous-learning-v2": "Agent Frameworks",
  "ai-first-engineering": "Agent Frameworks",
  "mcp-builder": "Agent Frameworks",
  "mcp-developer": "Agent Frameworks",
  "multi-agent-coordinator": "Agent Frameworks",

  // ---- Architecture ------------------------------------------------------
  "hexagonal-architecture": "Architecture",
  "architecture-decision-records": "Architecture",
  "microservices-architect": "Architecture",
  "api-designer": "Architecture",
  "architect-reviewer": "Architecture",
  "cloud-architect": "Architecture",
  "context-budget": "Architecture",

  // ---- Frontend / UI -----------------------------------------------------
  "frontend-design": "Frontend / UI",
  "frontend-design-direction": "Frontend / UI",
  "ui-designer": "Frontend / UI",
  "ui-ux-pro-max": "Frontend / UI",
  "frontend-developer": "Frontend / UI",

  // ---- Backend / APIs ----------------------------------------------------
  "backend-developer": "Backend / APIs",
  "fullstack-developer": "Backend / APIs",

  // ---- DevOps & Cloud ----------------------------------------------------
  "docker-patterns": "DevOps & Cloud",
  "docker-expert": "DevOps & Cloud",
  "deployment-patterns": "DevOps & Cloud",
  "deployment-engineer": "DevOps & Cloud",
  "devops-engineer": "DevOps & Cloud",
  "kubernetes-specialist": "DevOps & Cloud",
  "terraform-engineer": "DevOps & Cloud",
  "sre-engineer": "DevOps & Cloud",
  "git-workflow": "DevOps & Cloud",
  "git-workflow-manager": "DevOps & Cloud",
  "git-conflict-resolver": "DevOps & Cloud",

  // ---- Database ----------------------------------------------------------
  "postgres-patterns": "Database",
  "postgres-pro": "Database",
  "redis-patterns": "Database",
  "sql-pro": "Database",
  "database-migrations": "Database",
  "database-admin": "Database",
  "database-administrator": "Database",

  // ---- Security ----------------------------------------------------------
  "security-bounty-hunter": "Security",
  "security-scan": "Security",
  "safety-guard": "Security",
  "security-auditor": "Security",
  gateguard: "Security",
  "penetration-tester": "Security",
  "incident-responder": "Security",

  // ---- Quality & Review --------------------------------------------------
  "code-reviewer": "Quality & Review",
  debugger: "Quality & Review",
  "refactoring-specialist": "Quality & Review",
  "error-detective": "Quality & Review",
  "error-handling": "Quality & Review",
  "second-opinion": "Quality & Review",
  council: "Quality & Review",
  "senior-engineer": "Quality & Review",

  // ---- Testing -----------------------------------------------------------
  "tdd-guide": "Testing",
  "qa-expert": "Testing",
  "test-automator": "Testing",

  // ---- Performance -------------------------------------------------------
  "performance-engineer": "Performance",

  // ---- Documentation -----------------------------------------------------
  "documentation-engineer": "Documentation",
  "documentation-lookup": "Documentation",
  "markdown-mermaid-writing": "Documentation",

  // ---- Research & Writing ------------------------------------------------
  "academic-deep-research": "Research & Writing",
  "literature-review": "Research & Writing",
  "scientific-writing": "Research & Writing",
  "research-explainer": "Research & Writing",
  "citation-management": "Research & Writing",
  humanizer: "Research & Writing",

  // ---- Workflow & Productivity -------------------------------------------
  "search-first": "Workflow & Productivity",
  "skill-creator": "Workflow & Productivity",
  "nanoclaw-repl": "Workflow & Productivity",
  "token-budget-advisor": "Workflow & Productivity",
  "ecc-guide": "Workflow & Productivity",
  "business-strategist": "Workflow & Productivity",

  // ---- Memory & Knowledge ------------------------------------------------
  "consolidate-memory": "Memory & Knowledge",

  // ---- Healthcare --------------------------------------------------------
  "healthcare-emr-patterns": "Healthcare",
  "healthcare-cdss-patterns": "Healthcare",
  "healthcare-phi-compliance": "Healthcare",
  "healthcare-eval-harness": "Healthcare",
  "hipaa-compliance": "Healthcare",

  // ---- Network & Homelab -------------------------------------------------
  "homelab-network-setup": "Network & Homelab",
  "homelab-network-readiness": "Network & Homelab",
  "homelab-pihole-dns": "Network & Homelab",
  "homelab-vlan-segmentation": "Network & Homelab",
  "homelab-wireguard-vpn": "Network & Homelab",
  "windows-admin": "Network & Homelab",
};

// Keyword fallbacks — order matters. First match wins.
const KEYWORD_RULES: { domain: Domain; keywords: string[] }[] = [
  { domain: "C++ & Systems", keywords: ["cpp", "c++"] },
  { domain: "Rust", keywords: ["rust"] },
  { domain: "Python", keywords: ["python", "pytorch", "django", "fastapi"] },
  { domain: "Go", keywords: ["golang", "go-"] },
  { domain: "TypeScript / JS", keywords: ["typescript", "javascript", "nextjs", "react", "vue", "svelte", "node"] },
  { domain: "Java / JVM", keywords: ["java-", "spring", "quarkus", "kotlin-ktor"] },
  { domain: "C# / .NET", keywords: ["csharp", "dotnet", "powershell"] },
  { domain: "Mobile (Swift / Kotlin)", keywords: ["swift", "kotlin", "android", "ios", "flutter", "dart-"] },
  { domain: "Game Dev", keywords: ["unreal", "unity", "ue5", "gamedev", "game-"] },
  { domain: "Graphics", keywords: ["shader", "graphics", "render", "opengl", "vulkan", "metal"] },
  { domain: "AI Engineering", keywords: ["llm", "prompt", "model-", "rag"] },
  { domain: "Agent Frameworks", keywords: ["agent", "autonomous", "mcp", "claude-code", "loop"] },
  { domain: "Architecture", keywords: ["architect", "hexagonal", "microservice", "api-design"] },
  { domain: "Frontend / UI", keywords: ["frontend", "ui-", "ux-", "design-system", "motion-", "tailwind"] },
  { domain: "Backend / APIs", keywords: ["backend", "fastapi", "rest", "graphql"] },
  { domain: "DevOps & Cloud", keywords: ["docker", "kubernetes", "terraform", "deploy", "ci-cd", "devops", "git-"] },
  { domain: "Database", keywords: ["postgres", "mysql", "redis", "sql", "database", "supabase", "prisma"] },
  { domain: "Security", keywords: ["security", "auth", "owasp", "pentest", "vulnerab"] },
  { domain: "Quality & Review", keywords: ["review", "refactor", "debug", "lint"] },
  { domain: "Testing", keywords: ["test-", "tdd", "qa-", "e2e"] },
  { domain: "Performance", keywords: ["performance", "benchmark", "optimiz"] },
  { domain: "Documentation", keywords: ["doc", "readme", "changelog", "markdown"] },
  { domain: "Research & Writing", keywords: ["research", "writing", "article", "literature"] },
  { domain: "Healthcare", keywords: ["healthcare", "medical", "patient", "ehr", "emr", "hipaa"] },
  { domain: "Network & Homelab", keywords: ["network", "homelab", "vpn", "dns", "vlan", "router", "switch"] },
  { domain: "Finance & Business", keywords: ["finance", "billing", "invoice", "trading", "investor"] },
];

/// Classify a global/project skill or agent by its slug + description.
/// Returns null when no confident match exists so the caller can fall back
/// to the path-based grouping.
export function categorize(
  name: string,
  description?: string | null,
): Domain | null {
  const slug = name.toLowerCase();
  const direct = EXACT_MAP[slug];
  if (direct) return direct;

  const haystack = `${slug} ${(description ?? "").toLowerCase()}`;
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) {
      return rule.domain;
    }
  }
  return null;
}
