// commands/batches_sub — Batch execution & project scaffolding command wrappers
//
// Groups:
//   batches         — .bat / .ps1 runner from ~/.ultron/batches/
//   opengl_project  — OpenGL/vcpkg project scaffolder
//   detach          — Project window detach/reattach

pub mod batches;
pub mod detach;

pub use batches::*;
pub use detach::*;
