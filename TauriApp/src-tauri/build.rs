use std::fs;
use std::path::Path;

use tauri_build::{Attributes, WindowsAttributes};

fn sync_windows_icon(source: &str, target: &str) {
    let source_path = Path::new(source);
    let target_path = Path::new(target);
    let source_bytes = fs::read(source_path)
        .unwrap_or_else(|error| panic!("failed to read icon {}: {error}", source_path.display()));
    let needs_write = match fs::read(target_path) {
        Ok(current_bytes) => current_bytes != source_bytes,
        Err(_) => true,
    };
    if !needs_write {
        return;
    }
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).unwrap_or_else(|error| {
            panic!(
                "failed to create icon dir {}: {error}",
                parent.display()
            )
        });
    }
    fs::write(target_path, source_bytes)
        .unwrap_or_else(|error| panic!("failed to write icon {}: {error}", target_path.display()));
}

fn main() {
    println!("cargo:rerun-if-changed=../ico.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    sync_windows_icon("../ico.ico", "icons/icon.ico");

    let windows_attributes = WindowsAttributes::new().window_icon_path("icons/icon.ico");
    let attributes = Attributes::new().windows_attributes(windows_attributes);

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
