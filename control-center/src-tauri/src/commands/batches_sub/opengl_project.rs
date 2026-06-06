// Tauri command for scaffolding new OpenGL projects (vcpkg + GLFW + GLAD + GLM).
//
// Mirrors the legacy `crear_proyecto.bat` script from a graphics course
// project, but executes it natively from the Tauri backend so the user can scaffold a
// new project from the Projects tab without dropping into a console.
//
// Generated layout:
//
//   <parent_dir>/<project_name>/
//   ├── CMakeLists.txt        (find_package glfw3 + glad + glm + OpenGL)
//   ├── CMakePresets.json     (Debug-OpenGL preset wired to C:/vcpkg toolchain)
//   ├── vcpkg.json            (manifest with glfw3 / glad / glm deps)
//   ├── README.md
//   └── src/
//       ├── common.h          (single header pulling in glad / GLFW / glm / iostream)
//       ├── main.cpp          (Simple hello-world OR full GLFW window scaffold)
//       └── shaders/, assets/ (only created for the "context" kind)
//
// The two project kinds:
//   - "simple"  → `main.cpp` is a one-liner that prints "Hello World!".
//   - "context" → `main.cpp` is the full GLFW init + window + GLAD load + render
//                 loop scaffold, ready for the student to start writing shaders.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Request payload sent from the frontend modal (`NewOpenGlProjectModal.tsx`).
/// `kind` is validated as either "simple" or "context"; anything else returns
/// a hard error rather than silently falling back so the user notices a typo
/// in the wiring.
#[derive(Debug, Deserialize)]
pub struct CreateOpenGlProjectRequest {
    pub parent_dir: String,
    pub project_name: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct CreateOpenGlProjectResult {
    pub success: bool,
    pub project_path: String,
    pub message: String,
    pub files_created: Vec<String>,
}

/// Scaffolds a new OpenGL/vcpkg project on disk and returns the absolute path
/// to the newly-created project folder. All filesystem operations are
/// idempotent on the "doesn't already exist" front-door check — if the
/// destination folder already exists we abort before touching anything so we
/// never partially overwrite a user's work.
#[tauri::command]
pub fn create_opengl_project(
    req: CreateOpenGlProjectRequest,
) -> Result<CreateOpenGlProjectResult, String> {
    // ---- validate inputs --------------------------------------------------
    let name = req.project_name.trim();
    if name.is_empty() {
        return Err("Project name cannot be empty".into());
    }
    if name.chars().any(is_invalid_name_char) {
        return Err(format!(
            "Project name contains invalid characters: {name:?}. Avoid: < > : \" / \\ | ? *"
        ));
    }

    let kind = req.kind.trim().to_lowercase();
    if kind != "simple" && kind != "context" {
        return Err(format!(
            "Invalid project kind {kind:?}; expected 'simple' or 'context'"
        ));
    }

    let parent = PathBuf::from(req.parent_dir.trim());
    if parent.as_os_str().is_empty() {
        return Err("Parent directory cannot be empty".into());
    }
    if !parent.exists() {
        return Err(format!(
            "Parent directory does not exist: {}",
            parent.display()
        ));
    }
    if !parent.is_dir() {
        return Err(format!(
            "Parent path is not a directory: {}",
            parent.display()
        ));
    }

    let project_dir = parent.join(name);
    if project_dir.exists() {
        return Err(format!(
            "Directory already exists: {}",
            project_dir.display()
        ));
    }

    // vcpkg requires lowercase package names. Spaces are not legal in vcpkg
    // manifest names either, so collapse to underscores.
    let vcpkg_name = name.to_lowercase().replace(' ', "_");

    // ---- scaffold ---------------------------------------------------------
    let src_dir = project_dir.join("src");
    fs::create_dir_all(&src_dir).map_err(|e| format!("create src dir: {e}"))?;
    if kind == "context" {
        fs::create_dir_all(src_dir.join("shaders"))
            .map_err(|e| format!("create shaders dir: {e}"))?;
        fs::create_dir_all(src_dir.join("assets"))
            .map_err(|e| format!("create assets dir: {e}"))?;
    }

    let mut files_created: Vec<String> = Vec::new();

    write_file(
        &project_dir.join("CMakePresets.json"),
        &cmake_presets_json(),
        &mut files_created,
    )?;
    write_file(
        &project_dir.join("vcpkg.json"),
        &vcpkg_manifest(&vcpkg_name),
        &mut files_created,
    )?;
    write_file(
        &project_dir.join("CMakeLists.txt"),
        &cmake_lists(name),
        &mut files_created,
    )?;
    write_file(&src_dir.join("common.h"), COMMON_H, &mut files_created)?;
    write_file(
        &src_dir.join("main.cpp"),
        &main_cpp(name, &kind),
        &mut files_created,
    )?;
    write_file(
        &project_dir.join("README.md"),
        &readme_md(name, &kind),
        &mut files_created,
    )?;

    Ok(CreateOpenGlProjectResult {
        success: true,
        project_path: project_dir.to_string_lossy().to_string(),
        message: format!("Project '{name}' created at {}", project_dir.display()),
        files_created,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_invalid_name_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
}

fn write_file(path: &Path, contents: &str, files_created: &mut Vec<String>) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))?;
    files_created.push(path.to_string_lossy().to_string());
    Ok(())
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

fn cmake_presets_json() -> String {
    // Mirrors the preset emitted by the .bat. The `CMAKE_TOOLCHAIN_FILE` path
    // is hardcoded to `C:/vcpkg/...` because that is where the user's vcpkg
    // install lives — same as the original script. If we ever need to make
    // this portable we can read `VCPKG_ROOT` from the env on the backend.
    r#"{
  "version": 6,
  "configurePresets": [
    {
      "name": "Debug-OpenGL",
      "generator": "Ninja",
      "binaryDir": "${sourceDir}/cmake-build-debug-opengl",
      "cacheVariables": {
        "CMAKE_BUILD_TYPE": "Debug",
        "CMAKE_TOOLCHAIN_FILE": "C:/vcpkg/scripts/buildsystems/vcpkg.cmake",
        "VCPKG_TARGET_TRIPLET": "x64-windows"
      }
    }
  ]
}
"#
    .to_string()
}

fn vcpkg_manifest(lowercase_name: &str) -> String {
    format!(
        r#"{{
  "name": "{lowercase_name}",
  "version-string": "1.0.0",
  "dependencies": [
    "glfw3",
    "glad",
    "glm"
  ]
}}
"#
    )
}

fn cmake_lists(name: &str) -> String {
    format!(
        r#"cmake_minimum_required(VERSION 3.21)
project({name} CXX)
set(CMAKE_CXX_STANDARD 20)

find_package(glfw3 CONFIG REQUIRED)
find_package(glad CONFIG REQUIRED)
find_package(glm CONFIG REQUIRED)
find_package(OpenGL REQUIRED)

add_executable({name}
        src/main.cpp
)

set(OPENGL_DEPS
        glfw
        glad::glad
        glm::glm
        OpenGL::GL
)

target_link_libraries({name} PRIVATE ${{OPENGL_DEPS}})
"#
    )
}

// The original `.bat` copied `common.h` from `Test_1/src/common/common.h`,
// which is not present on every machine. We inline a minimal stand-in that
// just pulls in the headers the generated `main.cpp` relies on (glad, GLFW,
// glm, plus the standard `iostream`/`string`/`vector`). Students can extend
// it freely.
const COMMON_H: &str = r#"#pragma once

#include <glad/glad.h>
#include <GLFW/glfw3.h>

#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>

#include <iostream>
#include <string>
#include <vector>
"#;

fn main_cpp(name: &str, kind: &str) -> String {
    if kind == "simple" {
        // OPCION 1 in the .bat — single-line hello world. We keep it
        // byte-for-byte equivalent so muscle memory works.
        r#"#include "common.h"

int main() {
    std::cout << "Hello World!" << std::endl;

    return 0;
}
"#
        .to_string()
    } else {
        // OPCION 2 in the .bat — full GLFW + GLAD scaffold ready to render.
        format!(
            r#"#include "common.h"

// Settings
const unsigned int SCR_WIDTH = 800;
const unsigned int SCR_HEIGHT = 600;

// Callbacks
void framebuffer_size_callback(GLFWwindow* window, int width, int height) {{
    glViewport(0, 0, width, height);
}}

void processInput(GLFWwindow* window) {{
    if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS)
        glfwSetWindowShouldClose(window, true);
}}

int main() {{
    // Initialize GLFW
    if (!glfwInit()) {{
        std::cout << "Failed to initialize GLFW" << std::endl;
        return -1;
    }}

    // Configure GLFW
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);

    // Create window
    GLFWwindow* window = glfwCreateWindow(SCR_WIDTH, SCR_HEIGHT, "{name}", nullptr, nullptr);
    if (!window) {{
        std::cout << "Failed to create GLFW window" << std::endl;
        glfwTerminate();
        return -1;
    }}
    glfwMakeContextCurrent(window);
    glfwSetFramebufferSizeCallback(window, framebuffer_size_callback);

    // Load GLAD
    if (!gladLoadGLLoader((GLADloadproc)glfwGetProcAddress)) {{
        std::cout << "Failed to initialize GLAD" << std::endl;
        return -1;
    }}

    // OpenGL configuration
    glEnable(GL_DEPTH_TEST);
    glViewport(0, 0, SCR_WIDTH, SCR_HEIGHT);

    std::cout << "OpenGL Context Window Ready!" << std::endl;
    std::cout << "OpenGL Version: " << glGetString(GL_VERSION) << std::endl;

    // TODO: Setup shaders, VAO, VBO, textures, etc.

    // Render loop
    while (!glfwWindowShouldClose(window)) {{
        processInput(window);

        // Clear buffers
        glClearColor(0.1f, 0.1f, 0.15f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

        // TODO: Render your scene here

        glfwSwapBuffers(window);
        glfwPollEvents();
    }}

    // Cleanup
    // TODO: Delete VAO, VBO, shaders, etc.

    glfwTerminate();
    return 0;
}}
"#
        )
    }
}

fn readme_md(name: &str, kind: &str) -> String {
    let kind_label = if kind == "simple" {
        "Simple (Hello World)"
    } else {
        "Context Window (GLFW + GLAD scaffold)"
    };
    format!(
        r#"# {name}

OpenGL project scaffolded by ULTRON Control Center.

**Kind:** {kind_label}

## Build

1. Open the folder in your IDE (CLion / VS Code with CMake Tools).
2. Configure with the `Debug-OpenGL` preset (`CMakePresets.json`).
3. Build: `cmake --build --preset Debug-OpenGL` or your IDE shortcut.

## Dependencies (via vcpkg manifest)

- **GLFW3** — window + input + context
- **GLAD**  — OpenGL function loader
- **GLM**   — math (vectors, matrices)

vcpkg toolchain expected at `C:/vcpkg/scripts/buildsystems/vcpkg.cmake`.
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_simple_project_with_expected_files() {
        let tmp = TempDir::new().unwrap();
        let req = CreateOpenGlProjectRequest {
            parent_dir: tmp.path().to_string_lossy().to_string(),
            project_name: "Demo".to_string(),
            kind: "simple".to_string(),
        };
        let result = create_opengl_project(req).expect("scaffold succeeds");
        assert!(result.success);
        let root = tmp.path().join("Demo");
        assert!(root.join("CMakeLists.txt").is_file());
        assert!(root.join("CMakePresets.json").is_file());
        assert!(root.join("vcpkg.json").is_file());
        assert!(root.join("README.md").is_file());
        assert!(root.join("src").join("common.h").is_file());
        assert!(root.join("src").join("main.cpp").is_file());
        assert!(!root.join("src").join("shaders").exists());
    }

    #[test]
    fn creates_context_project_with_shader_dirs() {
        let tmp = TempDir::new().unwrap();
        let req = CreateOpenGlProjectRequest {
            parent_dir: tmp.path().to_string_lossy().to_string(),
            project_name: "MyGame".to_string(),
            kind: "context".to_string(),
        };
        let result = create_opengl_project(req).expect("scaffold succeeds");
        assert!(result.success);
        let root = tmp.path().join("MyGame");
        assert!(root.join("src").join("shaders").is_dir());
        assert!(root.join("src").join("assets").is_dir());
    }

    #[test]
    fn vcpkg_name_is_lowercased() {
        let tmp = TempDir::new().unwrap();
        let req = CreateOpenGlProjectRequest {
            parent_dir: tmp.path().to_string_lossy().to_string(),
            project_name: "CamelCase".to_string(),
            kind: "simple".to_string(),
        };
        create_opengl_project(req).unwrap();
        let manifest = fs::read_to_string(tmp.path().join("CamelCase/vcpkg.json")).unwrap();
        assert!(manifest.contains("\"name\": \"camelcase\""));
    }

    #[test]
    fn rejects_existing_dir() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("Taken")).unwrap();
        let req = CreateOpenGlProjectRequest {
            parent_dir: tmp.path().to_string_lossy().to_string(),
            project_name: "Taken".to_string(),
            kind: "simple".to_string(),
        };
        let err = create_opengl_project(req).unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn rejects_invalid_kind() {
        let tmp = TempDir::new().unwrap();
        let req = CreateOpenGlProjectRequest {
            parent_dir: tmp.path().to_string_lossy().to_string(),
            project_name: "Demo".to_string(),
            kind: "rubbish".to_string(),
        };
        assert!(create_opengl_project(req).is_err());
    }

    #[test]
    fn rejects_invalid_name_chars() {
        let tmp = TempDir::new().unwrap();
        let req = CreateOpenGlProjectRequest {
            parent_dir: tmp.path().to_string_lossy().to_string(),
            project_name: "bad/name".to_string(),
            kind: "simple".to_string(),
        };
        let err = create_opengl_project(req).unwrap_err();
        assert!(err.contains("invalid characters"));
    }
}
