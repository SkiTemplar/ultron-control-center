// commands/notes_sub — Notes & quick-capture domain command wrappers
//
// Groups:
//   notes          — Per-project notes + global notes CRUD, send-to-project
//   inbox          — Quick-capture inbox append/list
//   button_prompts — Button prompts catalog list/update/reset/get

pub mod button_prompts;
pub mod notes;

pub use button_prompts::*;
pub use notes::*;
