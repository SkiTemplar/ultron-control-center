cmake_minimum_required(VERSION 3.21)
project({{name}} CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(glfw3 CONFIG REQUIRED)
find_package(glad CONFIG REQUIRED)
find_package(glm CONFIG REQUIRED)
find_package(OpenGL REQUIRED)

add_executable({{name}}
        src/main.cpp
)

set(OPENGL_DEPS
        glfw
        glad::glad
        glm::glm
        OpenGL::GL
)

target_link_libraries({{name}} PRIVATE ${OPENGL_DEPS})
