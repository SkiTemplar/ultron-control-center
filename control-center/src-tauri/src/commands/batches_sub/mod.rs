// commands/batches_sub — Batch execution and project window command wrappers
//
// Groups:
//   batches         — .bat / .ps1 runner from ~/.ultron/batches/
//   detach          — Project window detach/reattach

pub mod batches;
pub mod detach;

pub use batches::*;
pub use detach::*;
