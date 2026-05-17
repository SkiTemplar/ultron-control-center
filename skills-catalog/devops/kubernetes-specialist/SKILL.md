---
name: kubernetes-specialist
description: Kubernetes cluster design, deployment, security hardening, and operations. Activate when designing Kubernetes architectures, writing Helm charts, configuring RBAC/network policies, implementing auto-scaling, or troubleshooting cluster issues.
kind: skill
tier: L1
category: devops
last_verified: 2026-05-03
tags: [kubernetes, specialist]
token_est: 1146
layer: L1-skills
---

# Kubernetes Specialist Skill

Production Kubernetes cluster design, deployment, configuration, and troubleshooting.

## Excellence Targets

- Pod startup < 30 seconds
- Resource utilization > 70%
- CIS Kubernetes Benchmark compliance
- >99.95% service uptime

## Deployment Patterns

```yaml
# Production Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  labels:
    app: myapp
    version: v1.2.3
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Zero-downtime deployment
  template:
    metadata:
      labels:
        app: myapp
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
      containers:
        - name: myapp
          image: myapp:1.2.3  # Always pin exact version, never :latest
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
```

## RBAC

```yaml
# Service account with minimal permissions
apiVersion: v1
kind: ServiceAccount
metadata:
  name: myapp-sa
  namespace: myapp
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: myapp-role
  namespace: myapp
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
    resourceNames: ["myapp-config"]  # Limit to specific resources
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: myapp-rolebinding
  namespace: myapp
subjects:
  - kind: ServiceAccount
    name: myapp-sa
roleRef:
  kind: Role
  name: myapp-role
  apiGroup: rbac.authorization.k8s.io
```

## Network Policies

```yaml
# Default deny all ingress/egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: myapp
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
# Allow only necessary traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-ingress
spec:
  podSelector:
    matchLabels:
      app: myapp
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
```

## Auto-Scaling

```yaml
# HorizontalPodAutoscaler
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

## Helm Chart Structure

```
mychart/
├── Chart.yaml
├── values.yaml
├── values-prod.yaml
├── templates/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   ├── serviceaccount.yaml
│   ├── networkpolicy.yaml
│   └── _helpers.tpl
```

## Troubleshooting

```bash
# Pod not starting
kubectl describe pod <pod> -n <ns>
kubectl logs <pod> -n <ns> --previous  # Previous container logs

# Check resource pressure
kubectl top nodes
kubectl top pods -A --sort-by=memory

# Debug with ephemeral container
kubectl debug -it <pod> --image=busybox --target=<container>

# Network debugging
kubectl exec -it <pod> -- nslookup <service>
kubectl exec -it <pod> -- curl http://<service>:<port>/health
```

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents kubernetes-specialist](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
