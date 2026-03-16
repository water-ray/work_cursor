use std::fs;
use std::path::Path;

use tauri_build::{Attributes, InlinedPlugin, WindowsAttributes};

include!("platform_contracts/generated_build.rs");

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

fn sync_default_rule_sets(source: &str, target: &str) {
    let source_path = Path::new(source);
    if !source_path.is_dir() {
        return;
    }
    let target_path = Path::new(target);
    fs::create_dir_all(target_path).unwrap_or_else(|error| {
        panic!(
            "failed to create rule-set dir {}: {error}",
            target_path.display()
        )
    });
    let entries = fs::read_dir(source_path).unwrap_or_else(|error| {
        panic!(
            "failed to read rule-set dir {}: {error}",
            source_path.display()
        )
    });
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| {
            panic!(
                "failed to iterate rule-set dir {}: {error}",
                source_path.display()
            )
        });
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let extension = entry_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("srs") {
            continue;
        }
        let target_file_path = target_path.join(
            entry_path
                .file_name()
                .unwrap_or_else(|| panic!("invalid rule-set file name: {}", entry_path.display())),
        );
        let source_bytes = fs::read(&entry_path).unwrap_or_else(|error| {
            panic!(
                "failed to read rule-set {}: {error}",
                entry_path.display()
            )
        });
        let needs_write = match fs::read(&target_file_path) {
            Ok(current_bytes) => current_bytes != source_bytes,
            Err(_) => true,
        };
        if !needs_write {
            continue;
        }
        fs::write(&target_file_path, source_bytes).unwrap_or_else(|error| {
            panic!(
                "failed to write rule-set {}: {error}",
                target_file_path.display()
            )
        });
    }
}

fn main() {
    println!("cargo:rerun-if-changed=../ico.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/assets/_up_/default-config/rule-set");

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let android_rule_set_source = manifest_dir.join("gen/android/app/src/main/assets/_up_/default-config/rule-set");
    let default_rule_set_target = manifest_dir.join("../default-config/rule-set");

    sync_windows_icon("../ico.ico", "icons/icon.ico");
    sync_default_rule_sets(
        &android_rule_set_source.to_string_lossy(),
        &default_rule_set_target.to_string_lossy(),
    );

    let windows_attributes = WindowsAttributes::new().window_icon_path("icons/icon.ico");
    let attributes = Attributes::new()
        .windows_attributes(windows_attributes)
        .plugin(
            MOBILE_HOST_PLUGIN_NAME,
            InlinedPlugin::new().commands(MOBILE_HOST_PLUGIN_COMMANDS),
        );

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
