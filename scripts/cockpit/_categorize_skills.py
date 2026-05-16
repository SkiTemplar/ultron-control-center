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
    "terry-davis":                   ("persona",   "terry-davis",   "S2", "ULTRA",  "sub-orchestrator"),
    "gamedev-engineer":                   ("persona",   "gamedev-engineer",   "S2", "ULTRA",  "sub-orchestrator"),
    "mike-tyson":                    ("persona",   "mike-tyson",    "S2", "HIGH",   "sub-orchestrator"),
    "jordan-belfort":                ("persona",   "jordan-belfort","S2", "HIGH",   "utility"),
    "personal-assistant":                          ("persona",   "personal-assistant",          "S2", "MEDIUM", "sub-orchestrator"),
    "tio-gilito":                    ("persona",   "tio-gilito",    "S2", "MEDIUM", "utility"),
    "manolo-lama":                   ("persona",   "manolo-lama",   "S2", "MEDIUM", "utility"),
    "shannon":                       ("persona",   "shannon",       "S2", "HIGH",   "reviewer"),
    "novalbos":                      ("persona",   "novalbos",      "S2", "ULTRA",  "sub-orchestrator"),
    "warren":                        ("persona",   "warren",        "S2", "HIGH",   "utility"),
    "einstein":                      ("persona",   "einstein",      "S2", "HIGH",   "utility"),
    "tolkien":                       ("persona",   "tolkien",       "S2", "MEDIUM", "utility"),
    "profesor-fisica":               ("persona",   "einstein",      "S2", "MEDIUM", "utility"),

    # ── PROGRAMMING LANGUAGES (S3/S4) ────────────────────────
    "python-pro":                    ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "typescript-pro":                ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "javascript-pro":                ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "rust-engineer":                 ("programming", "terry-davis", "S4", "HIGH",   "executor"),
    "golang-pro":                    ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "java-architect":                ("programming", "terry-davis", "S4", "HIGH",   "executor"),
    "cpp-pro":                       ("programming", "terry-davis", "S4", "HIGH",   "executor"),
    "csharp-developer":              ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "php-pro":                       ("programming", "personal-assistant",        "S3", "MEDIUM", "executor"),
    "kotlin-specialist":             ("programming", "terry-davis", "S3", "MEDIUM", "utility"),
    "swift-expert":                  ("programming", "mike-tyson",  "S4", "HIGH",   "executor"),
    "elixir-expert":                 ("programming", "terry-davis", "S4", "HIGH",   "executor"),
    "modern-python":                 ("programming", "terry-davis", "S3", "MEDIUM", "utility"),
    "dotnet-core-expert":            ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "dotnet-framework-4.8-expert":   ("programming", "terry-davis", "S3", "MEDIUM", "executor"),
    "matlab":                        ("programming", "shannon",     "S3", "MEDIUM", "executor"),

    # ── FRONTEND & UI (S3/S4) ────────────────────────────────
    "react-specialist":              ("frontend",  "mike-tyson",    "S4", "HIGH",   "executor"),
    "nextjs-developer":              ("frontend",  "mike-tyson",    "S4", "HIGH",   "executor"),
    "vue-expert":                    ("frontend",  "mike-tyson",    "S4", "HIGH",   "executor"),
    "angular-architect":             ("frontend",  "mike-tyson",    "S4", "HIGH",   "executor"),
    "frontend-developer":            ("frontend",  "mike-tyson",    "S3", "MEDIUM", "executor"),
    "frontend-slides":               ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "d3js-skill":                    ("frontend",  "mike-tyson",    "S4", "HIGH",   "executor"),
    "canvas-design":                 ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "electron-pro":                  ("frontend",  "mike-tyson",    "S3", "MEDIUM", "executor"),
    "ui-designer":                   ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "ui-ux-tester":                  ("frontend",  "mike-tyson",    "S3", "MEDIUM", "executor"),
    "ux-researcher":                 ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "seo-specialist":                ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "algorithmic-art":               ("frontend",  "mike-tyson",    "S4", "HIGH",   "executor"),
    "infographics":                  ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "web-artifacts-builder":         ("frontend",  "mike-tyson",    "S3", "MEDIUM", "executor"),
    "web-asset-generator":           ("frontend",  "mike-tyson",    "S3", "MEDIUM", "executor"),
    "shader-fundamentals":           ("frontend",  "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "generate-image":                ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "parallel-web":                  ("frontend",  "mike-tyson",    "S3", "MEDIUM", "executor"),
    "accessibility-tester":          ("frontend",  "mike-tyson",    "S3", "MEDIUM", "reviewer"),
    "brand-guidelines":              ("frontend",  "mike-tyson",    "S3", "MEDIUM", "utility"),
    "theme-factory":                 ("design",    "mike-tyson",    "S3", "MEDIUM", "utility"),
    "frontend-design":               ("design",    "mike-tyson",    "S3", "MEDIUM", "utility"),
    "material-3-expert":             ("design",    "mike-tyson",    "S3", "MEDIUM", "utility"),
    "ui-ux-pro-max":                 ("design",    "mike-tyson",    "S3", "MEDIUM", "utility"),
    "design-bridge":                 ("design",    "mike-tyson",    "S3", "MEDIUM", "utility"),

    # ── BACKEND & APIs (S3/S4) ───────────────────────────────
    "fastapi-developer":             ("backend",   "terry-davis",   "S4", "HIGH",   "executor"),
    "django-developer":              ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "node-specialist":               ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "spring-boot-engineer":          ("backend",   "terry-davis",   "S4", "HIGH",   "executor"),
    "laravel-specialist":            ("backend",   "personal-assistant",          "S3", "MEDIUM", "executor"),
    "rails-expert":                  ("backend",   "personal-assistant",          "S3", "MEDIUM", "executor"),
    "symfony-specialist":            ("backend",   "personal-assistant",          "S3", "MEDIUM", "executor"),
    "backend-developer":             ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "fullstack-developer":           ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "graphql-architect":             ("backend",   "terry-davis",   "S4", "HIGH",   "executor"),
    "microservices-architect":       ("backend",   "terry-davis",   "S4", "HIGH",   "executor"),
    "websocket-engineer":            ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "payment-integration":           ("backend",   "personal-assistant",          "S3", "MEDIUM", "executor"),
    "fintech-engineer":              ("backend",   "warren",        "S4", "HIGH",   "executor"),
    "claude-api":                    ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "mcp-developer":                 ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),
    "api-designer":                  ("backend",   "terry-davis",   "S3", "MEDIUM", "utility"),
    "api-documenter":                ("backend",   "tolkien",       "S3", "MEDIUM", "utility"),
    "cli-developer":                 ("backend",   "terry-davis",   "S3", "MEDIUM", "executor"),

    # ── MOBILE (S3/S4) ───────────────────────────────────────
    "android-kotlin":                ("mobile",    "mike-tyson",    "S4", "HIGH",   "executor"),
    "ios-simulator-skill":           ("mobile",    "mike-tyson",    "S4", "HIGH",   "executor"),
    "react-native-perf":             ("mobile",    "mike-tyson",    "S4", "HIGH",   "executor"),
    "flutter-expert":                ("mobile",    "mike-tyson",    "S4", "HIGH",   "executor"),
    "expo-react-native-expert":      ("mobile",    "mike-tyson",    "S4", "HIGH",   "executor"),
    "mobile-app-developer":          ("mobile",    "mike-tyson",    "S3", "MEDIUM", "executor"),
    "mobile-developer":              ("mobile",    "mike-tyson",    "S3", "MEDIUM", "executor"),

    # ── DEVOPS & INFRASTRUCTURE (S3/S4) ──────────────────────
    "docker-expert":                 ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "kubernetes-specialist":         ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "terraform-engineer":            ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "terragrunt-expert":             ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "github-actions":                ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "devops-engineer":               ("devops",    "tio-gilito",    "S3", "HIGH",   "executor"),
    "devops-incident-responder":     ("devops",    "tio-gilito",    "S3", "HIGH",   "executor"),
    "platform-engineer":             ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "cloud-architect":               ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "azure-infra-engineer":          ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "sre-engineer":                  ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "network-engineer":              ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "incident-responder":            ("devops",    "tio-gilito",    "S3", "HIGH",   "executor"),
    "chaos-engineer":                ("devops",    "tio-gilito",    "S4", "HIGH",   "executor"),
    "build-engineer":                ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "deployment-engineer":           ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "windows-infra-admin":           ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "m365-admin":                    ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "it-ops-orchestrator":           ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "devcontainer-setup":            ("devops",    "tio-gilito",    "S3", "MEDIUM", "utility"),
    "git-workflow-manager":          ("devops",    "tio-gilito",    "S3", "MEDIUM", "utility"),
    "git-cleanup":                   ("devops",    "tio-gilito",    "S3", "MEDIUM", "utility"),
    "iot-engineer":                  ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),
    "embedded-systems":              ("devops",    "terry-davis",   "S4", "HIGH",   "executor"),
    "modal":                         ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),

    # ── DATABASE & ORM (S3/S4) ───────────────────────────────
    "postgres-pro":                  ("database",  "personal-assistant",          "S4", "HIGH",   "executor"),
    "database-administrator":        ("database",  "personal-assistant",          "S4", "HIGH",   "executor"),
    "database-optimizer":            ("database",  "personal-assistant",          "S3", "MEDIUM", "executor"),
    "database-schema-designer":      ("database",  "personal-assistant",          "S3", "MEDIUM", "utility"),
    "database-lookup":               ("database",  "personal-assistant",          "S3", "MEDIUM", "utility"),
    "prisma-expert":                 ("database",  "personal-assistant",          "S4", "HIGH",   "executor"),
    "supabase":                      ("database",  "personal-assistant",          "S4", "HIGH",   "executor"),
    "supabase-postgres":             ("database",  "personal-assistant",          "S4", "HIGH",   "executor"),
    "sql-pro":                       ("database",  "personal-assistant",          "S3", "MEDIUM", "executor"),
    "cobrapy":                       ("database",  "einstein",      "S4", "HIGH",   "executor"),  # metabolic modeling DB
    "lamindb":                       ("database",  "einstein",      "S4", "HIGH",   "executor"),

    # ── SCIENTIFIC COMPUTING & BIOINFORMATICS (S4) ───────────
    "biopython":                     ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "rdkit":                         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "scanpy":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "qiskit":                        ("scientific", "einstein",     "S4", "ULTRA",  "executor"),
    "pennylane":                     ("scientific", "einstein",     "S4", "ULTRA",  "executor"),
    "qutip":                         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "cirq":                          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "astropy":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "anndata":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "arboreto":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "bioservices":                   ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "cellxgene-census":              ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "dask":                          ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "datamol":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "deepchem":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "deeptools":                     ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "depmap":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "dhdna-profiler":                ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "diffdock":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "esm":                           ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "etetoolkit":                    ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "flowio":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "fluidsim":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "geniml":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "geopandas":                     ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "geomaster":                     ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "gget":                          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "ginkgo-cloud-lab":              ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "glycoengineering":              ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "gtars":                         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "histolab":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "hugging-science":               ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "hypogenic":                     ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "hypothesis-generation":         ("scientific", "einstein",     "S3", "HIGH",   "utility"),
    "imaging-data-commons":          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "matchms":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "medchem":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "molfeat":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "molecular-dynamics":            ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "neurokit2":                     ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "neuropixels-analysis":          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "networkx":                      ("scientific", "shannon",      "S3", "MEDIUM", "executor"),
    "omero-integration":             ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "open-notebook":                 ("scientific", "einstein",     "S3", "MEDIUM", "utility"),
    "opentrons-integration":         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pathml":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "phylogenetics":                 ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "polars":                        ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "polars-bio":                    ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "primekg":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "protocolsio-integration":       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pufferlib":                     ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pydeseq2":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pydicom":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pyhealth":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pylabrobot":                    ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pymatgen":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pymc":                          ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "pymoo":                         ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "pyopenms":                      ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pysam":                         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pytdc":                         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "pytorch-lightning":             ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "pyzotero":                      ("scientific", "einstein",     "S3", "MEDIUM", "utility"),
    "rowan":                         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "scanpy":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "scikit-bio":                    ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "scikit-learn":                  ("scientific", "shannon",      "S4", "HIGH",   "executor"),
    "scikit-survival":               ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "scvelo":                        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "scvi-tools":                    ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "dnanexus-integration":          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "labarchive-integration":        ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "latchbio-integration":          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "benchling-integration":         ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "adaptyv":                       ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "aeon":                          ("scientific", "einstein",     "S4", "HIGH",   "executor"),
    "bgpt-paper-search":             ("scientific", "einstein",     "S3", "MEDIUM", "utility"),

    # ── AI / ML (S3/S4) ──────────────────────────────────────
    "ml-engineer":                   ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "machine-learning-engineer":     ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "llm-architect":                 ("ai-ml",     "terry-davis",   "S4", "HIGH",   "executor"),
    "nlp-engineer":                  ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "reinforcement-learning-engineer": ("ai-ml",   "shannon",       "S4", "ULTRA",  "executor"),
    "mlops-engineer":                ("ai-ml",     "tio-gilito",    "S4", "HIGH",   "executor"),
    "ai-engineer":                   ("ai-ml",     "terry-davis",   "S3", "MEDIUM", "executor"),
    "optimize-for-gpu":              ("ai-ml",     "shannon",       "S4", "HIGH",   "executor"),
    "prompt-engineer":               ("ai-ml",     "windows-admin",        "S3", "MEDIUM", "utility"),
    "multi-agent-coordinator":       ("ai-ml",     "windows-admin",        "S3", "MEDIUM", "executor"),
    "exploratory-data-analysis":     ("ai-ml",     "shannon",       "S3", "MEDIUM", "executor"),

    # ── DATA & VISUALIZATION (S3/S4) ─────────────────────────
    "data-scientist":                ("data",      "shannon",       "S4", "HIGH",   "executor"),
    "data-analyst":                  ("data",      "shannon",       "S3", "MEDIUM", "executor"),
    "data-engineer":                 ("data",      "personal-assistant",          "S4", "HIGH",   "executor"),
    "data-researcher":               ("data",      "manolo-lama",   "S3", "MEDIUM", "executor"),
    "matplotlib":                    ("data",      "shannon",       "S3", "MEDIUM", "executor"),
    "scientific-visualization":      ("data",      "shannon",       "S3", "MEDIUM", "executor"),
    "scientific-slides":             ("data",      "shannon",       "S3", "MEDIUM", "utility"),
    "scientific-schematics":         ("data",      "shannon",       "S3", "MEDIUM", "utility"),
    "quant-analyst":                 ("data",      "warren",        "S4", "HIGH",   "executor"),

    # ── SECURITY (S3/S4) ─────────────────────────────────────
    "penetration-tester":            ("security",  "novalbos",      "S4", "ULTRA",  "executor"),
    "security-auditor":              ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "security-engineer":             ("security",  "novalbos",      "S4", "HIGH",   "executor"),
    "semgrep-rule-creator":          ("security",  "novalbos",      "S4", "HIGH",   "executor"),
    "semgrep-rule-variant-creator":  ("security",  "novalbos",      "S4", "HIGH",   "executor"),
    "yara-rule-authoring":           ("security",  "novalbos",      "S4", "HIGH",   "executor"),
    "burpsuite-project-parser":      ("security",  "novalbos",      "S4", "HIGH",   "executor"),
    "ffuf-skill":                    ("security",  "novalbos",      "S4", "HIGH",   "executor"),
    "algorand-vulnerability-scanner":("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "cairo-vulnerability-scanner":   ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "cosmos-vulnerability-scanner":  ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "solana-vulnerability-scanner":  ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "substrate-vulnerability-scanner":("security", "novalbos",      "S4", "HIGH",   "reviewer"),
    "ton-vulnerability-scanner":     ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "firebase-apk-scanner":          ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "ad-security-reviewer":          ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "constant-time-analysis":        ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "zeroize-audit":                 ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "seatbelt-sandboxer":            ("security",  "novalbos",      "S3", "MEDIUM", "utility"),
    "secure-workflow-guide":         ("security",  "novalbos",      "S3", "MEDIUM", "utility"),
    "insecure-defaults":             ("security",  "novalbos",      "S3", "MEDIUM", "reviewer"),
    "supply-chain-risk-auditor":     ("security",  "novalbos",      "S3", "MEDIUM", "reviewer"),
    "variant-analysis":              ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "compliance-auditor":            ("security",  "novalbos",      "S3", "MEDIUM", "reviewer"),
    "token-integration-analyzer":    ("security",  "novalbos",      "S4", "HIGH",   "reviewer"),
    "fp-check":                      ("security",  "novalbos",      "S3", "MEDIUM", "reviewer"),
    "powershell-security-hardening": ("security",  "novalbos",      "S3", "MEDIUM", "executor"),
    "iso-13485-certification":       ("security",  "novalbos",      "S3", "HIGH",   "utility"),

    # ── BLOCKCHAIN / WEB3 (S4) ───────────────────────────────
    "blockchain-developer":          ("blockchain","novalbos",      "S4", "HIGH",   "executor"),

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
    "ui-ux-tester":                  ("testing",   "mike-tyson",    "S3", "MEDIUM", "executor"),

    # ── POWERSHELL (S3/S4) ───────────────────────────────────
    "powershell-5.1-expert":         ("programming", "tio-gilito",  "S3", "MEDIUM", "executor"),
    "powershell-7-expert":           ("programming", "tio-gilito",  "S3", "MEDIUM", "executor"),
    "powershell-module-architect":   ("programming", "tio-gilito",  "S4", "HIGH",   "executor"),
    "powershell-ui-architect":       ("programming", "tio-gilito",  "S3", "MEDIUM", "executor"),

    # ── WRITING & DOCUMENTATION (S3) ─────────────────────────
    "technical-writer":              ("writing",   "tolkien",       "S3", "MEDIUM", "executor"),
    "documentation-engineer":        ("writing",   "tolkien",       "S3", "MEDIUM", "executor"),
    "readme-generator":              ("writing",   "tolkien",       "S3", "MEDIUM", "executor"),
    "doc-coauthoring":               ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "scientific-writing":            ("writing",   "tolkien",       "S4", "HIGH",   "executor"),
    "scientific-literature-researcher":("writing", "tolkien",       "S4", "HIGH",   "executor"),
    "ai-writing-auditor":            ("writing",   "tolkien",       "S3", "MEDIUM", "reviewer"),
    "internal-comms":                ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "markdown-mermaid-writing":      ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "literature-review":             ("writing",   "tolkien",       "S4", "HIGH",   "executor"),
    "citation-management":           ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "peer-review":                   ("writing",   "tolkien",       "S4", "HIGH",   "reviewer"),
    "research-grants":               ("writing",   "tolkien",       "S4", "HIGH",   "executor"),
    "open-notebook":                 ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "latex-posters":                 ("writing",   "tolkien",       "S3", "MEDIUM", "executor"),
    "pptx-posters":                  ("writing",   "tolkien",       "S3", "MEDIUM", "executor"),
    "scientific-brainstorming":      ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "scientific-critical-thinking":  ("writing",   "tolkien",       "S3", "MEDIUM", "utility"),
    "paper-lookup":                  ("writing",   "manolo-lama",   "S3", "MEDIUM", "utility"),
    "paperzilla":                    ("writing",   "manolo-lama",   "S3", "MEDIUM", "utility"),
    "scholar-evaluation":            ("writing",   "tolkien",       "S3", "MEDIUM", "reviewer"),

    # ── BUSINESS & PRODUCT (S3/S4) ───────────────────────────
    "product-manager":               ("business",  "jordan-belfort","S4", "HIGH",   "executor"),
    "project-manager":               ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "business-analyst":              ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "market-researcher":             ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "market-research-reports":       ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "competitive-analyst":           ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "customer-success-manager":      ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "sales-engineer":                ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "content-marketer":              ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "scrum-master":                  ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "risk-manager":                  ("business",  "warren",        "S4", "HIGH",   "executor"),
    "legal-advisor":                 ("business",  "warren",        "S4", "HIGH",   "executor"),
    "healthcare-admin":              ("business",  "jordan-belfort","S3", "MEDIUM", "executor"),
    "project-idea-validator":        ("business",  "jordan-belfort","S3", "MEDIUM", "reviewer"),
    "seo-specialist":                ("business",  "jordan-belfort","S3", "MEDIUM", "utility"),
    "trend-analyst":                 ("business",  "manolo-lama",   "S3", "MEDIUM", "executor"),
    "search-specialist":             ("business",  "manolo-lama",   "S3", "MEDIUM", "executor"),
    "research-analyst":              ("business",  "manolo-lama",   "S3", "MEDIUM", "executor"),
    "research-lookup":               ("business",  "manolo-lama",   "S3", "MEDIUM", "utility"),

    # ── OFFICE & DOCUMENTS (S3) ──────────────────────────────
    "docx":                          ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "pdf":                           ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "pptx":                          ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "xlsx":                          ("office",    "windows-admin",        "S3", "MEDIUM", "executor"),
    "markitdown":                    ("office",    "windows-admin",        "S3", "MEDIUM", "utility"),

    # ── GAME DEVELOPMENT (S3/S4) ─────────────────────────────
    "game-developer":                ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "ue5-dev":                       ("game",      "gamedev-engineer",   "S4", "HIGH",   "utility"),
    "unreal-engine":                 ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "dwarf-expert":                  ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),
    "pufferlib":                     ("game",      "gamedev-engineer",   "S4", "HIGH",   "executor"),

    # ── ENGINEERING (CROSS-CUTTING) (S3/S4) ──────────────────
    "api-design-reviewer":           ("engineering","terry-davis",  "S3", "MEDIUM", "reviewer"),
    "code-review-excellence":        ("engineering","gamedev-engineer",  "S3", "MEDIUM", "reviewer"),
    "differential-review":           ("engineering","terry-davis",  "S3", "HIGH",   "reviewer"),
    "dimensional-analysis":          ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "focused-fix":                   ("engineering","terry-davis",  "S3", "MEDIUM", "executor"),
    "modern-python":                 ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "performance-profiler":          ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "second-opinion":                ("engineering","windows-admin",       "S3", "HIGH",   "reviewer"),
    "sharp-edges":                   ("engineering","terry-davis",  "S3", "MEDIUM", "reviewer"),
    "tech-debt-tracker":             ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "refactoring-specialist":        ("engineering","terry-davis",  "S3", "MEDIUM", "executor"),
    "legacy-modernizer":             ("engineering","terry-davis",  "S3", "HIGH",   "executor"),
    "performance-engineer":          ("engineering","terry-davis",  "S4", "HIGH",   "executor"),
    "performance-monitor":           ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "dependency-manager":            ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "license-engineer":              ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),
    "code-maturity-assessor":        ("engineering","terry-davis",  "S3", "MEDIUM", "reviewer"),
    "code-reviewer":                 ("engineering","terry-davis",  "S3", "MEDIUM", "reviewer"),
    "architect-reviewer":            ("engineering","terry-davis",  "S4", "HIGH",   "reviewer"),
    "debug-buttercup":               ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "debugger":                      ("engineering","terry-davis",  "S3", "MEDIUM", "executor"),
    "error-coordinator":             ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "error-detective":               ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "entry-point-analyzer":          ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "codebase-orchestrator":         ("engineering","terry-davis",  "S3", "HIGH",   "executor"),
    "tooling-engineer":              ("engineering","terry-davis",  "S3", "MEDIUM", "executor"),
    "dx-optimizer":                  ("engineering","terry-davis",  "S3", "MEDIUM", "utility"),
    "claude-skills":                 ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),
    "claude-in-chrome-troubleshooting":("engineering","windows-admin",     "S3", "MEDIUM", "utility"),
    "context-manager":               ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),
    "get-available-resources":       ("engineering","windows-admin",       "S3", "MEDIUM", "utility"),

    # ── WORKFLOW & UTILITIES (S3) ─────────────────────────────
    "antivibe":                      ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "developer-first":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "everything-claude-code":        ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "hyperframes":                   ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "news-publisher":                ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "superpowers":                   ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "loki-mode":                     ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "let-fate-decide":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "knowledge-synthesizer":         ("workflow",  "manolo-lama",   "S3", "MEDIUM", "utility"),
    "agentic-actions-auditor":       ("workflow",  "windows-admin",        "S3", "MEDIUM", "reviewer"),
    "agent-installer":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "agent-organizer":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "guidelines-advisor":            ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "audit-context-building":        ("memory",   "windows-admin",        "S3", "HIGH",   "reviewer"),
    "trailmark":                     ("memory",   "windows-admin",        "S3", "MEDIUM", "utility"),
    "context-manager":               ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),
    "task-distributor":              ("workflow",  "windows-admin",        "S3", "MEDIUM", "executor"),
    "workflow-orchestrator":         ("workflow",  "windows-admin",        "S3", "MEDIUM", "executor"),
    "it-ops-orchestrator":           ("devops",    "tio-gilito",    "S3", "MEDIUM", "executor"),

    # ── RESEARCH (S3/S4) ─────────────────────────────────────
    "consciousness-council":         ("research",  "einstein",      "S4", "ULTRA",  "executor"),
    "scientific-brainstorming":      ("research",  "einstein",      "S3", "HIGH",   "utility"),
    "scientific-critical-thinking":  ("research",  "einstein",      "S3", "HIGH",   "utility"),
    "knowledge-synthesizer":         ("research",  "manolo-lama",   "S3", "MEDIUM", "utility"),
    "guidelines-advisor":            ("research",  "manolo-lama",   "S3", "MEDIUM", "utility"),
    "interpreting-culture-index":    ("research",  "manolo-lama",   "S3", "MEDIUM", "utility"),

    # ── HEALTHCARE (S3/S4) ───────────────────────────────────
    "clinical-decision-support":     ("healthcare","einstein",      "S4", "HIGH",   "executor"),
    "clinical-reports":              ("healthcare","tolkien",       "S3", "MEDIUM", "executor"),
    "iso-13485-certification":       ("healthcare","novalbos",      "S3", "HIGH",   "utility"),

    # ── FINANCE (S3/S4) ──────────────────────────────────────
    "quant-analyst":                 ("finance",   "warren",        "S4", "HIGH",   "executor"),
    "risk-manager":                  ("finance",   "warren",        "S4", "HIGH",   "executor"),
    "fintech-engineer":              ("finance",   "warren",        "S4", "HIGH",   "executor"),

    # ── SLACK & COMMS (S3) ───────────────────────────────────
    "slack-expert":                  ("workflow",  "windows-admin",        "S3", "MEDIUM", "executor"),
    "slack-gif-creator":             ("workflow",  "windows-admin",        "S3", "MEDIUM", "utility"),

    # ── WORDPRESS (S3) ───────────────────────────────────────
    "wordpress-master":              ("backend",   "personal-assistant",          "S3", "MEDIUM", "executor"),

    # ── MISC UTILITIES ───────────────────────────────────────
    "audit-prep-assistant":          ("security",  "novalbos",      "S4", "HIGH",   "utility"),
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
