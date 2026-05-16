"""
Skill Categorizer v12.4
Categorizes all 370 skills with route_to, tier, mode_cap metadata
and rebuilds skill_manifest.json + skill-tree.md
"""
import json
import re
from pathlib import Path
from datetime import datetime

# ─────────────────────────────────────────────────────────────
# CATEGORIZATION TABLE
# Format: skill_name -> (category, route_to, tier, mode_cap, authority)
# ─────────────────────────────────────────────────────────────

SKILL_MAP = {
    # ── META / ORCHESTRATOR (S0/S1) ──────────────────────────
    "ultron":                        ("meta",      "ultron",        "S0", "ULTRA",  "orchestrator"),
    "skill-creator":                 ("meta",      "skill-creator", "S1", "HIGH",   "sub-orchestrator"),
    "consolidate-memory":            ("meta",      "consolidate-memory", "S1", "HIGH", "sub-orchestrator"),
    "repo-evaluator":                ("meta",      "repo-evaluator","S1", "ULTRA",  "sub-orchestrator"),
    "mcp-builder":                   ("meta",      "windows-admin",        "S1", "HIGH",   "executor"),
    "skill-improver":                ("meta",      "skill-creator", "S1", "HIGH",   "utility"),
    "skill-seekers":                 ("meta",      "skill-creator", "S1", "MEDIUM", "utility"),
    "designing-workflow-skills":     ("meta",      "skill-creator", "S1", "MEDIUM", "utility"),

    # ── PERSONAS (S2) ─────────────────────────────────────────
    "windows-admin":                        ("persona",   "windows-admin",        "S2", "MEDIUM", "sub-orchestrator"),
    "senior-engineer":               ("persona",   "senior-engineer",   "S2", "ULTRA",  "sub-orchestrator"),
    "gamedev-engineer":                   ("persona",   "gamedev-engineer",   "S2", "ULTRA",  "sub-orchestrator"),
    "ui-designer":                   ("persona",   "ui-designer",    "S2", "HIGH",   "sub-orchestrator"),
    "business-strategist":           ("persona",   "business-strategist","S2", "HIGH",   "utility"),
    "shannon":                       ("persona",   "shannon",       "S2", "HIGH",   "reviewer"),
    "research-explainer":            ("persona",   "research-explainer",      "S2", "HIGH",   "utility"),

    # ── PROGRAMMING LANGUAGES (S3/S4) ────────────────────────
    "python-pro":                    ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "typescript-pro":                ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "javascript-pro":                ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "rust-engineer":                 ("programming", "senior-engineer", "S4", "HIGH",   "executor"),
    "golang-pro":                    ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "java-architect":                ("programming", "senior-engineer", "S4", "HIGH",   "executor"),
    "cpp-pro":                       ("programming", "senior-engineer", "S4", "HIGH",   "executor"),
    "csharp-developer":              ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "php-pro":                       ("programming", "senior-engineer",        "S3", "MEDIUM", "executor"),
    "kotlin-specialist":             ("programming", "senior-engineer", "S3", "MEDIUM", "utility"),
    "swift-expert":                  ("programming", "ui-designer",  "S4", "HIGH",   "executor"),
    "elixir-expert":                 ("programming", "senior-engineer", "S4", "HIGH",   "executor"),
    "modern-python":                 ("programming", "senior-engineer", "S3", "MEDIUM", "utility"),
    "dotnet-core-expert":            ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "dotnet-framework-4.8-expert":   ("programming", "senior-engineer", "S3", "MEDIUM", "executor"),
    "matlab":                        ("programming", "shannon",     "S3", "MEDIUM", "executor"),

    # ── FRONTEND & UI (S3/S4) ────────────────────────────────
    "react-specialist":              ("frontend",  "ui-designer",    "S4", "HIGH",   "executor"),
    "nextjs-developer":              ("frontend",  "ui-designer",    "S4", "HIGH",   "executor"),
    "vue-expert":                    ("frontend",  "ui-designer",    "S4", "HIGH",   "executor"),
    "angular-architect":             ("frontend",  "ui-designer",    "S4", "HIGH",   "executor"),
    "frontend-developer":            ("frontend",  "ui-designer",    "S3", "MEDIUM", "executor"),
    "frontend-slides":               ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "d3js-skill":                    ("frontend",  "ui-designer",    "S4", "HIGH",   "executor"),
    "canvas-design":                 ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "electron-pro":                  ("frontend",  "ui-designer",    "S3", "MEDIUM", "executor"),
    # NOTE: ui-designer persona is registered above in PERSONAS section
    "ui-ux-tester":                  ("frontend",  "ui-designer",    "S3", "MEDIUM", "executor"),
    "ux-researcher":                 ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "seo-specialist":                ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "algorithmic-art":               ("frontend",  "ui-designer",    "S4", "HIGH",   "executor"),
    "infographics":                  ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "web-artifacts-builder":         ("frontend",  "ui-designer",    "S3", "MEDIUM", "executor"),
    "web-asset-generator":           ("frontend",  "ui-designer",    "S3", "MEDIUM", "executor"),
    "shader-fundamentals":           ("frontend",  "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "generate-image":                ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "parallel-web":                  ("frontend",  "ui-designer",    "S3", "MEDIUM", "executor"),
    "accessibility-tester":          ("frontend",  "ui-designer",    "S3", "MEDIUM", "reviewer"),
    "brand-guidelines":              ("frontend",  "ui-designer",    "S3", "MEDIUM", "utility"),
    "theme-factory":                 ("design",    "ui-designer",    "S3", "MEDIUM", "utility"),
    "frontend-design":               ("design",    "ui-designer",    "S3", "MEDIUM", "utility"),
    "material-3-expert":             ("design",    "ui-designer",    "S3", "MEDIUM", "utility"),
    "ui-ux-pro-max":                 ("design",    "ui-designer",    "S3", "MEDIUM", "utility"),
    "design-bridge":                 ("design",    "ui-designer",    "S3", "MEDIUM", "utility"),

    # ── BACKEND & APIs (S3/S4) ───────────────────────────────
    "fastapi-developer":             ("backend",   "senior-engineer",   "S4", "HIGH",   "executor"),
    "django-developer":              ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "node-specialist":               ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "spring-boot-engineer":          ("backend",   "senior-engineer",   "S4", "HIGH",   "executor"),
    "laravel-specialist":            ("backend",   "senior-engineer",          "S3", "MEDIUM", "executor"),
    "rails-expert":                  ("backend",   "senior-engineer",          "S3", "MEDIUM", "executor"),
    "symfony-specialist":            ("backend",   "senior-engineer",          "S3", "MEDIUM", "executor"),
    "backend-developer":             ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "fullstack-developer":           ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "graphql-architect":             ("backend",   "senior-engineer",   "S4", "HIGH",   "executor"),
    "microservices-architect":       ("backend",   "senior-engineer",   "S4", "HIGH",   "executor"),
    "websocket-engineer":            ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "payment-integration":           ("backend",   "senior-engineer",          "S3", "MEDIUM", "executor"),
    "fintech-engineer":              ("backend",   "business-strategist",        "S4", "HIGH",   "executor"),
    "claude-api":                    ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "mcp-developer":                 ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),
    "api-designer":                  ("backend",   "senior-engineer",   "S3", "MEDIUM", "utility"),
    "api-documenter":                ("backend",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "cli-developer":                 ("backend",   "senior-engineer",   "S3", "MEDIUM", "executor"),

    # ── MOBILE (S3/S4) ───────────────────────────────────────
    "android-kotlin":                ("mobile",    "ui-designer",    "S4", "HIGH",   "executor"),
    "ios-simulator-skill":           ("mobile",    "ui-designer",    "S4", "HIGH",   "executor"),
    "react-native-perf":             ("mobile",    "ui-designer",    "S4", "HIGH",   "executor"),
    "flutter-expert":                ("mobile",    "ui-designer",    "S4", "HIGH",   "executor"),
    "expo-react-native-expert":      ("mobile",    "ui-designer",    "S4", "HIGH",   "executor"),
    "mobile-app-developer":          ("mobile",    "ui-designer",    "S3", "MEDIUM", "executor"),
    "mobile-developer":              ("mobile",    "ui-designer",    "S3", "MEDIUM", "executor"),

    # ── DEVOPS & INFRASTRUCTURE (S3/S4) ──────────────────────
    "docker-expert":                 ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "kubernetes-specialist":         ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "terraform-engineer":            ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "terragrunt-expert":             ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "github-actions":                ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "devops-engineer":               ("devops",    "windows-admin",    "S3", "HIGH",   "executor"),
    "devops-incident-responder":     ("devops",    "windows-admin",    "S3", "HIGH",   "executor"),
    "platform-engineer":             ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "cloud-architect":               ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "azure-infra-engineer":          ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "sre-engineer":                  ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "network-engineer":              ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "incident-responder":            ("devops",    "windows-admin",    "S3", "HIGH",   "executor"),
    "chaos-engineer":                ("devops",    "windows-admin",    "S4", "HIGH",   "executor"),
    "build-engineer":                ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "deployment-engineer":           ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "windows-infra-admin":           ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "m365-admin":                    ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "it-ops-orchestrator":           ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "devcontainer-setup":            ("devops",    "windows-admin",    "S3", "MEDIUM", "utility"),
    "git-workflow-manager":          ("devops",    "windows-admin",    "S3", "MEDIUM", "utility"),
    "git-cleanup":                   ("devops",    "windows-admin",    "S3", "MEDIUM", "utility"),
    "iot-engineer":                  ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),
    "embedded-systems":              ("devops",    "senior-engineer",   "S4", "HIGH",   "executor"),
    "modal":                         ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),

    # ── DATABASE & ORM (S3/S4) ───────────────────────────────
    "postgres-pro":                  ("database",  "senior-engineer",          "S4", "HIGH",   "executor"),
    "database-administrator":        ("database",  "senior-engineer",          "S4", "HIGH",   "executor"),
    "database-optimizer":            ("database",  "senior-engineer",          "S3", "MEDIUM", "executor"),
    "database-schema-designer":      ("database",  "senior-engineer",          "S3", "MEDIUM", "utility"),
    "database-lookup":               ("database",  "senior-engineer",          "S3", "MEDIUM", "utility"),
    "prisma-expert":                 ("database",  "senior-engineer",          "S4", "HIGH",   "executor"),
    "supabase":                      ("database",  "senior-engineer",          "S4", "HIGH",   "executor"),
    "supabase-postgres":             ("database",  "senior-engineer",          "S4", "HIGH",   "executor"),
    "sql-pro":                       ("database",  "senior-engineer",          "S3", "MEDIUM", "executor"),
    "cobrapy":                       ("database",  "research-explainer",      "S4", "HIGH",   "executor"),  # metabolic modeling DB
    "lamindb":                       ("database",  "research-explainer",      "S4", "HIGH",   "executor"),

    # ── SCIENTIFIC COMPUTING & BIOINFORMATICS (S4) ───────────
    "biopython":                     ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "rdkit":                         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "scanpy":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "qiskit":                        ("scientific", "research-explainer",     "S4", "ULTRA",  "executor"),
    "pennylane":                     ("scientific", "research-explainer",     "S4", "ULTRA",  "executor"),
    "qutip":                         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "cirq":                          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "astropy":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "anndata":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "arboreto":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "bioservices":                   ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "cellxgene-census":              ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "dask":                          ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "datamol":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "deepchem":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "deeptools":                     ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "depmap":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "dhdna-profiler":                ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "diffdock":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "esm":                           ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "etetoolkit":                    ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "flowio":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "fluidsim":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "geniml":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "geopandas":                     ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "geomaster":                     ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "gget":                          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "ginkgo-cloud-lab":              ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "glycoengineering":              ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "gtars":                         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "histolab":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "hugging-science":               ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "hypogenic":                     ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "hypothesis-generation":         ("scientific", "research-explainer",     "S3", "HIGH",   "utility"),
    "imaging-data-commons":          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "matchms":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "medchem":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "molfeat":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "molecular-dynamics":            ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "neurokit2":                     ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "neuropixels-analysis":          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "networkx":                      ("scientific", "shannon",      "S3", "MEDIUM", "executor"),
    "omero-integration":             ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "open-notebook":                 ("scientific", "research-explainer",     "S3", "MEDIUM", "utility"),
    "opentrons-integration":         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pathml":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "phylogenetics":                 ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "polars":                        ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "polars-bio":                    ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "primekg":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "protocolsio-integration":       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pufferlib":                     ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pydeseq2":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pydicom":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pyhealth":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pylabrobot":                    ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pymatgen":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pymc":                          ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "pymoo":                         ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "pyopenms":                      ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pysam":                         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pytdc":                         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "pytorch-lightning":             ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "pyzotero":                      ("scientific", "research-explainer",     "S3", "MEDIUM", "utility"),
    "rowan":                         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "scanpy":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "scikit-bio":                    ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "scikit-learn":                  ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "scikit-survival":               ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "scvelo":                        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "scvi-tools":                    ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "dnanexus-integration":          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "labarchive-integration":        ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "latchbio-integration":          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "benchling-integration":         ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "adaptyv":                       ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "aeon":                          ("scientific", "research-explainer",     "S4", "HIGH",   "executor"),
    "bgpt-paper-search":             ("scientific", "research-explainer",     "S3", "MEDIUM", "utility"),

    # ── AI / ML (S3/S4) ──────────────────────────────────────
    "ml-engineer":                   ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "machine-learning-engineer":     ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "llm-architect":                 ("ai-ml",     "senior-engineer",   "S4", "HIGH",   "executor"),
    "nlp-engineer":                  ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "reinforcement-learning-engineer": ("ai-ml",   "shannon",       "S4", "ULTRA",  "executor"),
    "mlops-engineer":                ("ai-ml",     "windows-admin",    "S4", "HIGH",   "executor"),
    "ai-engineer":                   ("ai-ml",     "senior-engineer",   "S3", "MEDIUM", "executor"),
    "optimize-for-gpu":              ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "prompt-engineer":               ("ai-ml",     "windows-admin",        "S3", "MEDIUM", "utility"),
    "multi-agent-coordinator":       ("ai-ml",     "windows-admin",        "S3", "MEDIUM", "executor"),
    "exploratory-data-analysis":     ("ai-ml",     "shannon",       "S3", "MEDIUM", "executor"),

    # ── DATA & VISUALIZATION (S3/S4) ─────────────────────────
    "data-scientist":                ("data",      "shannon",       "S4", "HIGH",   "executor"),
    "data-analyst":                  ("data",      "shannon",       "S3", "MEDIUM", "executor"),
    "data-engineer":                 ("data",      "senior-engineer",          "S4", "HIGH",   "executor"),
    "data-researcher":               ("data",      "research-explainer",   "S3", "MEDIUM", "executor"),
    "matplotlib":                    ("data",      "shannon",       "S3", "MEDIUM", "executor"),
    "scientific-visualization":      ("data",      "shannon",       "S3", "MEDIUM", "executor"),
    "scientific-slides":             ("data",      "shannon",       "S3", "MEDIUM", "utility"),
    "scientific-schematics":         ("data",      "shannon",       "S3", "MEDIUM", "utility"),
    "quant-analyst":                 ("data",      "business-strategist",        "S4", "HIGH",   "executor"),

    # ── SECURITY (S3/S4) ─────────────────────────────────────
    "penetration-tester":            ("security",  "senior-engineer",      "S4", "ULTRA",  "executor"),
    "security-auditor":              ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "security-engineer":             ("security",  "senior-engineer",      "S4", "HIGH",   "executor"),
    "semgrep-rule-creator":          ("security",  "senior-engineer",      "S4", "HIGH",   "executor"),
    "semgrep-rule-variant-creator":  ("security",  "senior-engineer",      "S4", "HIGH",   "executor"),
    "yara-rule-authoring":           ("security",  "senior-engineer",      "S4", "HIGH",   "executor"),
    "burpsuite-project-parser":      ("security",  "senior-engineer",      "S4", "HIGH",   "executor"),
    "ffuf-skill":                    ("security",  "senior-engineer",      "S4", "HIGH",   "executor"),
    "algorand-vulnerability-scanner":("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "cairo-vulnerability-scanner":   ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "cosmos-vulnerability-scanner":  ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "solana-vulnerability-scanner":  ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "substrate-vulnerability-scanner":("security", "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "ton-vulnerability-scanner":     ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "firebase-apk-scanner":          ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "ad-security-reviewer":          ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "constant-time-analysis":        ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "zeroize-audit":                 ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "seatbelt-sandboxer":            ("security",  "senior-engineer",      "S3", "MEDIUM", "utility"),
    "secure-workflow-guide":         ("security",  "senior-engineer",      "S3", "MEDIUM", "utility"),
    "insecure-defaults":             ("security",  "senior-engineer",      "S3", "MEDIUM", "reviewer"),
    "supply-chain-risk-auditor":     ("security",  "senior-engineer",      "S3", "MEDIUM", "reviewer"),
    "variant-analysis":              ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "compliance-auditor":            ("security",  "senior-engineer",      "S3", "MEDIUM", "reviewer"),
    "token-integration-analyzer":    ("security",  "senior-engineer",      "S4", "HIGH",   "reviewer"),
    "fp-check":                      ("security",  "senior-engineer",      "S3", "MEDIUM", "reviewer"),
    "powershell-security-hardening": ("security",  "senior-engineer",      "S3", "MEDIUM", "executor"),
    "iso-13485-certification":       ("security",  "senior-engineer",      "S3", "HIGH",   "utility"),

    # ── BLOCKCHAIN / WEB3 (S4) ───────────────────────────────
    "blockchain-developer":          ("blockchain","senior-engineer",      "S4", "HIGH",   "executor"),

    # ── TESTING & QA (S3/S4) ─────────────────────────────────
    "qa-expert":                     ("testing",   "gamedev-engineer",   "S3", "MEDIUM", "executor"),
    "test-automator":                ("testing",   "gamedev-engineer",   "S3", "MEDIUM", "executor"),
    "mutation-testing":              ("testing",   "gamedev-engineer",   "S4", "HIGH",   "reviewer"),
    "property-based-testing":        ("testing",   "gamedev-engineer",   "S4", "HIGH",   "utility"),
    "spec-to-code-compliance":       ("testing",   "gamedev-engineer",   "S3", "HIGH",   "reviewer"),
    "webapp-testing":                ("testing",   "gamedev-engineer",   "S3", "MEDIUM", "executor"),
    "ask-questions-first":           ("testing",   "windows-admin",        "S3", "MEDIUM", "utility"),
    "ask-questions-if-underspecified":("testing",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "playwright-skill":              ("testing",   "gamedev-engineer",   "S3", "MEDIUM", "executor"),
    "testing-handbook-generator":    ("testing",   "gamedev-engineer",   "S3", "MEDIUM", "utility"),
    "ui-ux-tester":                  ("testing",   "ui-designer",    "S3", "MEDIUM", "executor"),

    # ── POWERSHELL (S3/S4) ───────────────────────────────────
    "powershell-5.1-expert":         ("programming", "windows-admin",  "S3", "MEDIUM", "executor"),
    "powershell-7-expert":           ("programming", "windows-admin",  "S3", "MEDIUM", "executor"),
    "powershell-module-architect":   ("programming", "windows-admin",  "S4", "HIGH",   "executor"),
    "powershell-ui-architect":       ("programming", "windows-admin",  "S3", "MEDIUM", "executor"),

    # ── WRITING & DOCUMENTATION (S3) ─────────────────────────
    "technical-writer":              ("writing",   "senior-engineer",       "S3", "MEDIUM", "executor"),
    "documentation-engineer":        ("writing",   "senior-engineer",       "S3", "MEDIUM", "executor"),
    "readme-generator":              ("writing",   "senior-engineer",       "S3", "MEDIUM", "executor"),
    "doc-coauthoring":               ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "scientific-writing":            ("writing",   "senior-engineer",       "S4", "HIGH",   "executor"),
    "scientific-literature-researcher":("writing", "senior-engineer",       "S4", "HIGH",   "executor"),
    "ai-writing-auditor":            ("writing",   "senior-engineer",       "S3", "MEDIUM", "reviewer"),
    "internal-comms":                ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "markdown-mermaid-writing":      ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "literature-review":             ("writing",   "senior-engineer",       "S4", "HIGH",   "executor"),
    "citation-management":           ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "peer-review":                   ("writing",   "senior-engineer",       "S4", "HIGH",   "reviewer"),
    "research-grants":               ("writing",   "senior-engineer",       "S4", "HIGH",   "executor"),
    "open-notebook":                 ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "latex-posters":                 ("writing",   "senior-engineer",       "S3", "MEDIUM", "executor"),
    "pptx-posters":                  ("writing",   "senior-engineer",       "S3", "MEDIUM", "executor"),
    "scientific-brainstorming":      ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "scientific-critical-thinking":  ("writing",   "senior-engineer",       "S3", "MEDIUM", "utility"),
    "paper-lookup":                  ("writing",   "research-explainer",   "S3", "MEDIUM", "utility"),
    "paperzilla":                    ("writing",   "research-explainer",   "S3", "MEDIUM", "utility"),
    "scholar-evaluation":            ("writing",   "senior-engineer",       "S3", "MEDIUM", "reviewer"),

    # ── BUSINESS & PRODUCT (S3/S4) ───────────────────────────
    "product-manager":               ("business",  "business-strategist","S4", "HIGH",   "executor"),
    "project-manager":               ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "business-analyst":              ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "market-researcher":             ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "market-research-reports":       ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "competitive-analyst":           ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "customer-success-manager":      ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "sales-engineer":                ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "content-marketer":              ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "scrum-master":                  ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "risk-manager":                  ("business",  "business-strategist",        "S4", "HIGH",   "executor"),
    "legal-advisor":                 ("business",  "business-strategist",        "S4", "HIGH",   "executor"),
    "healthcare-admin":              ("business",  "business-strategist","S3", "MEDIUM", "executor"),
    "project-idea-validator":        ("business",  "business-strategist","S3", "MEDIUM", "reviewer"),
    "seo-specialist":                ("business",  "business-strategist","S3", "MEDIUM", "utility"),
    "trend-analyst":                 ("business",  "research-explainer",   "S3", "MEDIUM", "executor"),
    "search-specialist":             ("business",  "research-explainer",   "S3", "MEDIUM", "executor"),
    "research-analyst":              ("business",  "research-explainer",   "S3", "MEDIUM", "executor"),
    "research-lookup":               ("business",  "research-explainer",   "S3", "MEDIUM", "utility"),

    # ── OFFICE & DOCUMENTS (S3) ──────────────────────────────
    "docx":                          ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "pdf":                           ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "pptx":                          ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "xlsx":                          ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "markitdown":                    ("office",    "windows-admin",        "S3", "MEDIUM", "utility"),

    # ── GAME DEVELOPMENT (S3/S4) ─────────────────────────────
    "game-developer":                ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "unreal-engine":                 ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "dwarf-expert":                  ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "pufferlib":                     ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),

    # ── ENGINEERING (CROSS-CUTTING) (S3/S4) ──────────────────
    "api-design-reviewer":           ("engineering","senior-engineer",  "S3", "MEDIUM", "reviewer"),
    "code-review-excellence":        ("engineering","gamedev-engineer",  "S3", "MEDIUM", "reviewer"),
    "differential-review":           ("engineering","senior-engineer",  "S3", "HIGH",   "reviewer"),
    "dimensional-analysis":          ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "focused-fix":                   ("engineering","senior-engineer",  "S3", "MEDIUM", "executor"),
    "modern-python":                 ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "performance-profiler":          ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "second-opinion":                ("engineering","windows-admin",       "S3", "HIGH",   "reviewer"),
    "sharp-edges":                   ("engineering","senior-engineer",  "S3", "MEDIUM", "reviewer"),
    "tech-debt-tracker":             ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "refactoring-specialist":        ("engineering","senior-engineer",  "S3", "MEDIUM", "executor"),
    "legacy-modernizer":             ("engineering","senior-engineer",  "S3", "HIGH",   "executor"),
    "performance-engineer":          ("engineering","senior-engineer",  "S4", "HIGH",   "executor"),
    "performance-monitor":           ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "dependency-manager":            ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "license-engineer":              ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),
    "code-maturity-assessor":        ("engineering","senior-engineer",  "S3", "MEDIUM", "reviewer"),
    "code-reviewer":                 ("engineering","senior-engineer",  "S3", "MEDIUM", "reviewer"),
    "architect-reviewer":            ("engineering","senior-engineer",  "S4", "HIGH",   "reviewer"),
    "debug-buttercup":               ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "debugger":                      ("engineering","senior-engineer",  "S3", "MEDIUM", "executor"),
    "error-coordinator":             ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "error-detective":               ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "entry-point-analyzer":          ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "codebase-orchestrator":         ("engineering","senior-engineer",  "S3", "HIGH",   "executor"),
    "tooling-engineer":              ("engineering","senior-engineer",  "S3", "MEDIUM", "executor"),
    "dx-optimizer":                  ("engineering","senior-engineer",  "S3", "MEDIUM", "utility"),
    "claude-skills":                 ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),
    "claude-in-chrome-troubleshooting":("engineering","windows-admin",     "S3", "MEDIUM", "utility"),
    "context-manager":               ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),
    "get-available-resources":       ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),

    # ── WORKFLOW & UTILITIES (S3) ─────────────────────────────
    "antivibe":                      ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "developer-first":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "everything-claude-code":        ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "hyperframes":                   ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "superpowers":                   ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "loki-mode":                     ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "let-fate-decide":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "knowledge-synthesizer":         ("workflow",  "research-explainer",   "S3", "MEDIUM", "utility"),
    "agentic-actions-auditor":       ("workflow",  "windows-admin",        "S3", "MEDIUM", "reviewer"),
    "agent-installer":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "agent-organizer":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "guidelines-advisor":            ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "audit-context-building":        ("memory",   "windows-admin",        "S3", "HIGH",   "reviewer"),
    "trailmark":                     ("memory",   "windows-admin",        "S3", "MEDIUM", "utility"),
    "context-manager":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "task-distributor":              ("workflow",  "windows-admin",        "S3", "MEDIUM", "executor"),
    "workflow-orchestrator":         ("workflow",  "windows-admin",        "S3", "MEDIUM", "executor"),
    "it-ops-orchestrator":           ("devops",    "windows-admin",    "S3", "MEDIUM", "executor"),

    # ── RESEARCH (S3/S4) ─────────────────────────────────────
    "consciousness-council":         ("research",  "research-explainer",      "S4", "ULTRA",  "executor"),
    "scientific-brainstorming":      ("research",  "research-explainer",      "S3", "HIGH",   "utility"),
    "scientific-critical-thinking":  ("research",  "research-explainer",      "S3", "HIGH",   "utility"),
    "knowledge-synthesizer":         ("research",  "research-explainer",   "S3", "MEDIUM", "utility"),
    "guidelines-advisor":            ("research",  "research-explainer",   "S3", "MEDIUM", "utility"),
    "interpreting-culture-index":    ("research",  "research-explainer",   "S3", "MEDIUM", "utility"),

    # ── HEALTHCARE (S3/S4) ───────────────────────────────────
    "clinical-decision-support":     ("healthcare","research-explainer",      "S4", "HIGH",   "executor"),
    "clinical-reports":              ("healthcare","senior-engineer",       "S3", "MEDIUM", "executor"),
    "iso-13485-certification":       ("healthcare","senior-engineer",      "S3", "HIGH",   "utility"),

    # ── FINANCE (S3/S4) ──────────────────────────────────────
    "quant-analyst":                 ("finance",   "business-strategist",        "S4", "HIGH",   "executor"),
    "risk-manager":                  ("finance",   "business-strategist",        "S4", "HIGH",   "executor"),
    "fintech-engineer":              ("finance",   "business-strategist",        "S4", "HIGH",   "executor"),

    # ── SLACK & COMMS (S3) ───────────────────────────────────
    "slack-expert":                  ("workflow",  "windows-admin",        "S3", "MEDIUM", "executor"),
    "slack-gif-creator":             ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),

    # ── WORDPRESS (S3) ───────────────────────────────────────
    "wordpress-master":              ("backend",   "senior-engineer",          "S3", "MEDIUM", "executor"),

    # ── MISC UTILITIES ───────────────────────────────────────
    "audit-prep-assistant":          ("security",  "senior-engineer",      "S4", "HIGH",   "utility"),
}

def apply_categorization():
    manifest_path = Path.home() / ".ultron" / "skill_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    skills = manifest["skills"]

    updated = 0
    unchanged = 0
    not_in_map = []

    for skill_name, skill_data in skills.items():
        if skill_name in SKILL_MAP:
            cat, route_to, tier, mode_cap, authority = SKILL_MAP[skill_name]
            old_cat = skill_data.get("category", "misc")

            skill_data["category"] = cat
            skill_data["tier"] = tier
            skill_data["mode_cap"] = mode_cap
            skill_data["authority"] = authority

            # Set persona_routes and route_edges
            if route_to and route_to != skill_name:
                skill_data["persona_routes"] = [route_to]
                skill_data["route_edges"] = [{"to": route_to, "strength": "primary"}]
            elif cat in ("persona", "meta"):
                skill_data["persona_routes"] = []
                skill_data["route_edges"] = []

            updated += 1
        else:
            not_in_map.append(skill_name)
            unchanged += 1

    # Save
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Updated: {updated}")
    print(f"Not in map (kept as-is): {unchanged}")
    if not_in_map:
        print(f"Skills not in map: {not_in_map}")

    # Print distribution
    from collections import Counter
    cats = Counter(s.get("category","misc") for s in skills.values())
    print("\n=== Category Distribution ===")
    for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")

    routes = Counter()
    for s in skills.values():
        for r in s.get("persona_routes", []):
            routes[r] += 1
    print("\n=== Route Distribution ===")
    for r, count in sorted(routes.items(), key=lambda x: -x[1]):
        print(f"  {r}: {count}")

    return manifest

if __name__ == "__main__":
    apply_categorization()