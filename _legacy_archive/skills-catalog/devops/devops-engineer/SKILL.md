---
name: devops-engineer
description: Senior DevOps engineer covering CI/CD pipelines, Infrastructure as Code (Terraform/Ansible), container orchestration, monitoring, and cloud platforms (AWS/GCP/Azure). Activate when designing deployment pipelines, writing Terraform/Helm, configuring monitoring, or implementing GitOps workflows.
kind: skill
tier: L1
category: devops
last_verified: 2026-05-03
tags: [devops, engineer]
token_est: 900
layer: L1-skills
---

# DevOps Engineer Skill

Senior DevOps engineering expertise across the complete software delivery lifecycle.

## Core Domains

1. **Infrastructure as Code** — Terraform, CloudFormation, Ansible, Pulumi
2. **Container Orchestration** — Docker, Kubernetes, Helm, service mesh
3. **CI/CD Implementation** — Pipeline design, build optimization, deployment strategies
4. **Monitoring & Observability** — Metrics (Prometheus), logs (Loki/ELK), traces (Jaeger/Tempo)
5. **Configuration Management** — Secrets (Vault/SOPS), environment consistency
6. **Cloud Platforms** — AWS, Azure, GCP, multi-cloud patterns
7. **Security Integration** — DevSecOps, SAST/DAST, policy enforcement
8. **Performance Optimization** — Resource tuning, auto-scaling, cost efficiency

## Success Metrics

- 100% infrastructure and deployment automation
- >80% test coverage for IaC modules
- <1 day mean time to production
- >99.9% service availability
- Comprehensive security scanning in all workflows

## Terraform Patterns

```hcl
# Module structure
module "app" {
  source  = "./modules/ecs-service"
  version = "~> 1.0"

  name        = var.app_name
  image       = "${var.ecr_url}:${var.image_tag}"
  cpu         = 256
  memory      = 512
  min_count   = 2
  max_count   = 10
}

# Remote state
terraform {
  backend "s3" {
    bucket         = "tfstate-prod"
    key            = "app/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "tfstate-lock"
  }
}
```

## CI/CD Pipeline (GitHub Actions)

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-east-1

      - name: Build & Push
        run: |
          aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URL
          docker build -t $IMAGE_TAG .
          docker push $IMAGE_TAG

      - name: Deploy
        run: |
          aws ecs update-service \
            --cluster prod \
            --service ${{ vars.SERVICE_NAME }} \
            --force-new-deployment
```

## GitOps Pattern (ArgoCD)

```yaml
# Application manifest
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-prod
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/org/gitops-repo
    targetRevision: HEAD
    path: apps/myapp/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: myapp
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Monitoring Stack

```yaml
# Prometheus scrape config
scrape_configs:
  - job_name: 'app'
    static_configs:
      - targets: ['app:8080']
    metrics_path: /metrics

# Alert rule
groups:
  - name: app
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
```

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents devops-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
