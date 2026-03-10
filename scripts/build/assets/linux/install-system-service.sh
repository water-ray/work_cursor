#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
helper_path="$script_dir/wateray-service-helper.sh"
install_dir="$(cd "$script_dir/.." && pwd -P)"

if [[ ! -x "$helper_path" ]]; then
  echo "wateray install helper not found: $helper_path" >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  exec pkexec "$0" "$@"
fi

exec "$helper_path" install-packaged --install-dir "$install_dir" "$@"
