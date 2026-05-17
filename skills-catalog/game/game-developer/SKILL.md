---
name: game-developer
description: Game development expert covering Unity, Unreal Engine, Godot, and custom engines. Covers ECS, rendering pipelines, physics, AI/pathfinding, multiplayer networking, and optimization. Activate when building game systems, optimizing frame rate, implementing game mechanics, or working with game engines.
kind: skill
tier: L1
category: game
last_verified: 2026-05-03
tags: [game, developer]
token_est: 1069
layer: L1-skills
---

# Game Developer Skill

Senior game developer with multi-engine expertise and focus on performance, architecture, and player experience.

## Performance Targets

- 60 FPS stable (desktop/console)
- 30 FPS stable (mobile)
- Load time < 3 seconds
- Memory within platform limits

## Platform & Engine Support

| Engine | Language | Focus |
|---|---|---|
| Unreal Engine | C++ | AAA, photorealism, GAS |
| Unity | C# | Indie-AAA, cross-platform |
| Godot | GDScript/C# | Indie, rapid prototype |
| Custom | C++/Rust | Research, specialized |

## Architecture Patterns

### Entity Component System (ECS)

```csharp
// Unity DOTS ECS
public struct HealthComponent : IComponentData {
    public float CurrentHealth;
    public float MaxHealth;
}

public struct DamageSystem : ISystem {
    public void OnUpdate(ref SystemState state) {
        foreach (var (health, damage) in
            SystemAPI.Query<RefRW<HealthComponent>, RefRO<DamageComponent>>()) {
            health.ValueRW.CurrentHealth -= damage.ValueRO.Amount;
        }
    }
}
```

### Object Pooling

```csharp
// Unity object pool
public class BulletPool : MonoBehaviour {
    [SerializeField] private Bullet prefab;
    private readonly Queue<Bullet> pool = new();

    public Bullet Get() {
        if (pool.TryDequeue(out var bullet)) {
            bullet.gameObject.SetActive(true);
            return bullet;
        }
        return Instantiate(prefab);
    }

    public void Return(Bullet bullet) {
        bullet.gameObject.SetActive(false);
        pool.Enqueue(bullet);
    }
}
```

## Rendering Optimization

```cpp
// Unreal C++ — Occlusion culling
UPROPERTY(EditAnywhere)
bool bCullDistanceSetting = true;

// Draw call batching — combine static meshes
// LOD groups — reduce poly count at distance
// Texture atlasing — reduce material switches

// GPU instancing for repeated geometry
DrawMeshInstanced(mesh, 0, material, matrices, count);
```

## Physics Optimization

```csharp
// Avoid per-frame raycasts on every object
// Good: Use triggers instead of polling
private void OnTriggerEnter(Collider other) {
    if (other.CompareTag("Collectible")) Collect(other);
}

// Bad: polling every frame
void Update() {
    if (Physics.Raycast(transform.position, Vector3.down, out hit))
        CheckGround(hit);
}

// Use Physics layers for selective collision
Physics.IgnoreLayerCollision(LayerMask.NameToLayer("Player"),
    LayerMask.NameToLayer("Decoration"), true);
```

## AI & Pathfinding

```csharp
// A* pathfinding (Unity NavMesh)
NavMeshAgent agent;
void MoveToTarget(Vector3 target) {
    NavMeshPath path = new NavMeshPath();
    if (NavMesh.CalculatePath(transform.position, target,
        NavMesh.AllAreas, path)) {
        agent.SetPath(path);
    }
}

// Behavior trees (hierarchical decision)
// Root → Selector → Sequence → Actions
```

## Multiplayer Networking

```csharp
// Unity Netcode for GameObjects — authority model
public class PlayerMovement : NetworkBehaviour {
    private NetworkVariable<Vector3> networkPosition = new();

    public override void OnNetworkSpawn() {
        if (IsOwner) {
            // Client-side prediction
            StartCoroutine(SendInputs());
        }
    }

    [ServerRpc]
    private void MoveServerRpc(Vector3 direction) {
        // Server validates and applies
        transform.position += direction * speed * Time.deltaTime;
        networkPosition.Value = transform.position;
    }
}
```

## Optimization Pipeline

1. **Profile first** — Unity Profiler, UE Insights, RenderDoc
2. **Identify bottleneck** — CPU-bound vs GPU-bound vs memory-bound
3. **Optimize hotspot** — single biggest win
4. **Measure again** — verify improvement
5. **Document** — record baseline and result

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents game-developer](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
