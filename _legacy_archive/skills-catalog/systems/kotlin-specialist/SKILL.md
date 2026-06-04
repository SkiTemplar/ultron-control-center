---
name: kotlin-specialist
description: Modern Kotlin 1.9+ specialist covering coroutines, Kotlin Multiplatform (KMP), Android development, and server-side Ktor. Activate when writing Kotlin code, implementing coroutines/Flow, building KMP shared logic, working with Ktor, or applying functional Kotlin patterns.
kind: skill
tier: L1
category: systems
last_verified: 2026-05-03
tags: [kotlin, specialist]
token_est: 1106
layer: L1-skills
---

# Kotlin Specialist Skill

Senior Kotlin developer specialized in modern Kotlin 1.9+ across multiple platforms.

## Core Expertise

Coroutines, Kotlin Multiplatform, Android development, and server-side applications with Ktor.

## Development Standards

- Static analysis via Detekt
- Code formatting with ktlint
- Test coverage > 85%
- KDoc documentation for public APIs
- Null safety enforcement everywhere
- Structured concurrency for all coroutines

## Coroutines & Flow Patterns

```kotlin
// Structured concurrency — always use scope
class UserViewModel(private val repo: UserRepository) : ViewModel() {
    private val _state = MutableStateFlow<UiState<User>>(UiState.Loading)
    val state: StateFlow<UiState<User>> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            repo.getUser()
                .catch { e -> _state.value = UiState.Error(e.message ?: "Unknown error") }
                .collect { user -> _state.value = UiState.Success(user) }
        }
    }
}

// Flow operators
fun getUserFeed(): Flow<List<Post>> = repo.getPostsFlow()
    .map { posts -> posts.filter { it.isPublished } }
    .distinctUntilChanged()
    .flowOn(Dispatchers.IO)

// Exception handling in coroutines
val handler = CoroutineExceptionHandler { _, exception ->
    logger.error("Coroutine failed", exception)
}
scope.launch(handler) { riskyOperation() }
```

## Kotlin Multiplatform (KMP)

```kotlin
// expect/actual pattern
// commonMain
expect class PlatformDate() {
    fun currentTimeMillis(): Long
}

// androidMain
actual class PlatformDate actual constructor() {
    actual fun currentTimeMillis(): Long = System.currentTimeMillis()
}

// iosMain
actual class PlatformDate actual constructor() {
    actual fun currentTimeMillis(): Long =
        NSDate().timeIntervalSince1970.toLong() * 1000
}

// Shared repository
class UserRepository(private val db: AppDatabase) {
    fun getUsers(): Flow<List<User>> = db.userQueries
        .selectAll()
        .asFlow()
        .mapToList(Dispatchers.IO)
}
```

## Ktor Server

```kotlin
fun Application.configureRouting() {
    routing {
        authenticate("jwt") {
            route("/api/v1") {
                usersRoutes()
                postsRoutes()
            }
        }
    }
}

fun Route.usersRoutes() {
    val userService by inject<UserService>()

    get("/users") {
        val users = userService.getAll()
        call.respond(users)
    }

    post("/users") {
        val request = call.receive<CreateUserRequest>()
        val user = userService.create(request)
        call.respond(HttpStatusCode.Created, user)
    }
}
```

## Functional Patterns

```kotlin
// Arrow.kt for functional style
import arrow.core.*

fun validateEmail(email: String): Either<String, String> =
    if (email.contains("@")) email.right()
    else "Invalid email".left()

fun validateAge(age: Int): Either<String, Int> =
    if (age >= 18) age.right()
    else "Must be 18+".left()

// Composition
val result: Either<String, User> = either {
    val email = validateEmail(rawEmail).bind()
    val age = validateAge(rawAge).bind()
    User(email, age)
}

// Sealed classes for domain modeling
sealed class Result<out T> {
    data class Success<T>(val value: T) : Result<T>()
    data class Failure(val error: Throwable) : Result<Nothing>()
}
```

## Testing

```kotlin
// Turbine for Flow testing
@Test
fun `emits loading then success`() = runTest {
    val flow = viewModel.state
    flow.test {
        assertEquals(UiState.Loading, awaitItem())
        assertEquals(UiState.Success(user), awaitItem())
        cancelAndIgnoreRemainingEvents()
    }
}

// MockK
@Test
fun `createUser calls repository`() = runTest {
    val repo = mockk<UserRepository>()
    coEvery { repo.createUser(any()) } returns user
    val vm = UserViewModel(repo)
    vm.createUser(request)
    coVerify { repo.createUser(request) }
}
```

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents kotlin-specialist](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
