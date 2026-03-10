#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
SERVER_DIR = ROOT_DIR / "adsroot" / "server"
WEB_DIR = ROOT_DIR / "adsroot" / "web"
PUBLISH_ROOT_DIR = ROOT_DIR / "Bin" / "adsroot"


class AdsrootPublishError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def run_command(command: list[str], cwd: Path) -> None:
    result = subprocess.run(command, cwd=str(cwd), check=False)
    if result.returncode != 0:
        raise AdsrootPublishError(f"命令执行失败：{' '.join(command)}")


def reset_publish_root() -> None:
    if PUBLISH_ROOT_DIR.exists():
        shutil.rmtree(PUBLISH_ROOT_DIR)
    PUBLISH_ROOT_DIR.mkdir(parents=True, exist_ok=True)


def publish_server() -> None:
    run_command(["npm", "run", "build"], cwd=SERVER_DIR)
    source_dist_dir = SERVER_DIR / "dist"
    if not source_dist_dir.exists():
        raise AdsrootPublishError(f"未找到服务端构建产物：{source_dist_dir}")
    publish_server_dir = PUBLISH_ROOT_DIR / "server"
    shutil.copytree(source_dist_dir, publish_server_dir / "dist")
    (publish_server_dir / "main.js").write_text("import './dist/main.js';\n", encoding="utf-8")
    for name in ("package.json", "package-lock.json", ".env.example", "README.md", "install.sh"):
        source_path = SERVER_DIR / name
        if source_path.exists():
            shutil.copy2(source_path, publish_server_dir / name)
    for path in publish_server_dir.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix == ".sqlite" or path.name.endswith((".sqlite-wal", ".sqlite-shm")):
            path.unlink()


def publish_web() -> None:
    run_command(["npm", "run", "build"], cwd=WEB_DIR)
    source_dist_dir = WEB_DIR / "dist"
    if not source_dist_dir.exists():
        raise AdsrootPublishError(f"未找到前端构建产物：{source_dist_dir}")
    shutil.copytree(source_dist_dir, PUBLISH_ROOT_DIR / "web" / "dist")


def main() -> int:
    try:
        reset_publish_root()
        publish_server()
        publish_web()
        print("广告端本地发布完成")
        print(f"- 输出目录：{PUBLISH_ROOT_DIR}")
        return 0
    except AdsrootPublishError as err:
        print(f"发布失败：[adsroot_publish] {err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"发布失败：[adsroot_publish_unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
