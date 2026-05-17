---
name: android-kotlin
description: Production Android development with Jetpack Compose, MVVM, Hilt, Room, and Kotlin Coroutines/Flow. Activate when building Android apps, designing feature modules, implementing offline-first architecture, or working with Kotlin Android patterns.
kind: skill
tier: L1
category: mobile
last_verified: 2026-05-03
tags: [android, kotlin]
token_est: 665
layer: L1-skills
---

# Android Kotlin Skill

Production-quality Android development following Google's official architecture patterns and the NowInAndroid reference implementation.

## Core Architecture

Layered approach: UI → Domain (optional) → Data layers. Applications organize into modules by feature, with each feature containing public API and internal implementation submodules.

## Key Patterns

**State Management**: ViewModels expose UI state through `StateFlow<UiState>`, where `UiState` is a sealed interface representing Loading, Success, or Error conditions.

**Data Flow**: Repositories abstract data sources (local database as source-of-truth, remote sync optional). They expose data reactively through Kotlin Flow.

**Modularization**: Create `feature:myfeature:api` module with navigation key, implementation details in a separate `impl` module.

## Standard Stack

- **UI**: Jetpack Compose with MVVM pattern
- **DI**: Hilt for dependency injection
- **Database**: Room for local storage (source of truth)
- **Async**: Kotlin Coroutines and Flow
- **Build**: Gradle with convention plugins, libs.versions.toml
- **Navigation**: Navigation Compose with type-safe routes
- **Testing**: JUnit5, MockK, Turbine for Flow testing

## Architecture Principles

- Offline-first: local DB is always source of truth, remote is a sync target
- Unidirectional data flow: Events up, state down
- Testability through interfaces, not mocking libraries directly
- Reactive streams (Flow) for all data exposure
- Each layer owns its models; map at boundaries

## Module Structure

```
:app
:core:data
:core:database
:core:network
:core:ui
:core:testing
:feature:<name>:api
:feature:<name>:impl
```

## Key Kotlin Patterns

```kotlin
// ViewModel state
sealed interface UiState<out T> {
    data object Loading : UiState<Nothing>
    data class Success<T>(val data: T) : UiState<T>
    data class Error(val message: String) : UiState<Nothing>
}

// Repository pattern
interface UserRepository {
    fun getUsers(): Flow<List<User>>
    suspend fun syncUsers(): Result<Unit>
}

// Collect in Compose
val uiState by viewModel.uiState.collectAsStateWithLifecycle()
```

## Source

Adapted from [dpconde/claude-android-skill](https://github.com/dpconde/claude-android-skill) — Production Android skill following NowInAndroid patterns.
