// Bootstrap only — everything lives in lib.rs so the same code builds for
// desktop targets (and, later, any mobile shell Tauri supports).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deep_cuts_lib::run();
}
