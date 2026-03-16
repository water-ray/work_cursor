#!/usr/bin/env python3
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
TAURI_DIR = ROOT_DIR / "TauriApp"
DEFAULT_RULE_SET_DIR = TAURI_DIR / "default-config" / "rule-set"
ANDROID_GENERATED_RULE_SET_DIR = (
    TAURI_DIR
    / "src-tauri"
    / "gen"
    / "android"
    / "app"
    / "src"
    / "main"
    / "assets"
    / "_up_"
    / "default-config"
    / "rule-set"
)


@dataclass(frozen=True)
class RuleSetSyncSummary:
    source_dir: Path
    target_dir: Path
    source_count: int
    copied: int
    updated: int
    skipped: int


def list_rule_set_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(
        path
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == ".srs"
    )


def ensure_default_rule_sets_synced(
    *,
    source_dir: Path | None = None,
    target_dir: Path | None = None,
) -> RuleSetSyncSummary:
    resolved_source_dir = source_dir or ANDROID_GENERATED_RULE_SET_DIR
    resolved_target_dir = target_dir or DEFAULT_RULE_SET_DIR
    source_files = list_rule_set_files(resolved_source_dir)
    resolved_target_dir.mkdir(parents=True, exist_ok=True)

    copied = 0
    updated = 0
    skipped = 0

    for source_file in source_files:
        target_file = resolved_target_dir / source_file.name
        if not target_file.exists():
            shutil.copy2(source_file, target_file)
            copied += 1
            continue
        if target_file.read_bytes() != source_file.read_bytes():
            shutil.copy2(source_file, target_file)
            updated += 1
            continue
        skipped += 1

    return RuleSetSyncSummary(
        source_dir=resolved_source_dir,
        target_dir=resolved_target_dir,
        source_count=len(source_files),
        copied=copied,
        updated=updated,
        skipped=skipped,
    )


def print_rule_set_sync_summary(summary: RuleSetSyncSummary) -> None:
    if summary.source_count <= 0:
        print(
            "默认规则集同步：未找到源规则集，"
            f"source={summary.source_dir}"
        )
        return
    print(
        "默认规则集同步完成："
        f"source={summary.source_count} copied={summary.copied} "
        f"updated={summary.updated} skipped={summary.skipped} "
        f"target={summary.target_dir}"
    )
