#!/usr/bin/env bash
set -euo pipefail

readonly SYSTEM_HELPER_PATH="/usr/local/libexec/wateray/wateray-service-helper"
readonly SYSTEM_ASSET_DIR="/usr/local/share/wateray/linux"
readonly POLICY_INSTALL_PATH="/usr/share/polkit-1/actions/net.wateray.daemon.policy"
readonly SYSTEMD_UNIT_DIR="/etc/systemd/system"
readonly SYSTEM_DESKTOP_DIR="/usr/local/share/applications"
readonly SYSTEM_DESKTOP_FILE_NAME="com.singbox.wateray.desktop"
readonly LEGACY_SYSTEM_DESKTOP_FILE_NAME="wateray.desktop"
readonly SYSTEM_DESKTOP_PATH="$SYSTEM_DESKTOP_DIR/$SYSTEM_DESKTOP_FILE_NAME"
readonly LEGACY_SYSTEM_DESKTOP_PATH="$SYSTEM_DESKTOP_DIR/$LEGACY_SYSTEM_DESKTOP_FILE_NAME"
readonly SYSTEM_ICON_DIR="/usr/local/share/icons/hicolor/128x128/apps"
readonly SYSTEM_ICON_NAME="com.singbox.wateray"
readonly SYSTEM_ICON_FILE_NAME="$SYSTEM_ICON_NAME.png"
readonly LEGACY_SYSTEM_ICON_FILE_NAME="wateray.png"
readonly SYSTEM_ICON_PATH="$SYSTEM_ICON_DIR/$SYSTEM_ICON_FILE_NAME"
readonly LEGACY_SYSTEM_ICON_PATH="$SYSTEM_ICON_DIR/$LEGACY_SYSTEM_ICON_FILE_NAME"
readonly DEFAULT_PACKAGED_SERVICE_NAME="waterayd"
readonly DEFAULT_DEV_SERVICE_NAME="waterayd-dev"
readonly DEFAULT_PACKAGED_DATA_ROOT="/var/lib/wateray"
readonly DEFAULT_DEV_DATA_ROOT="/var/lib/wateray-dev"

log() {
  printf '[wateray-helper] %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "This helper must run as root."
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

normalize_service_name() {
  local raw="${1:-}"
  raw="${raw%.service}"
  if [[ -z "$raw" ]]; then
    fail "Service name must not be empty."
  fi
  printf '%s' "$raw"
}

resolve_dir() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    fail "Directory argument must not be empty."
  fi
  if [[ ! -d "$raw" ]]; then
    fail "Directory does not exist: $raw"
  fi
  (
    cd "$raw"
    pwd -P
  )
}

resolve_path() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    fail "Path argument must not be empty."
  fi
  local parent
  parent="$(dirname "$raw")"
  if [[ ! -d "$parent" ]]; then
    fail "Parent directory does not exist: $parent"
  fi
  (
    cd "$parent"
    printf '%s/%s\n' "$(pwd -P)" "$(basename "$raw")"
  )
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
script_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"
asset_dir="$script_dir"
if [[ "$script_dir" == "/usr/local/libexec/wateray" ]] && [[ -d "$SYSTEM_ASSET_DIR" ]]; then
  asset_dir="$SYSTEM_ASSET_DIR"
fi

install_common_assets() {
  mkdir -p \
    "$(dirname "$SYSTEM_HELPER_PATH")" \
    "$SYSTEM_ASSET_DIR" \
    "$(dirname "$POLICY_INSTALL_PATH")" \
    "$SYSTEM_DESKTOP_DIR" \
    "$SYSTEM_ICON_DIR"
  # Reinstall the currently running helper, regardless of whether it was invoked
  # from the bundled ".sh" asset or the already installed no-suffix helper path.
  install -m 0755 "$script_path" "$SYSTEM_HELPER_PATH"
  install -m 0644 "$asset_dir/waterayd.service.template" "$SYSTEM_ASSET_DIR/waterayd.service.template"
  install -m 0644 "$asset_dir/waterayd-dev.service.template" "$SYSTEM_ASSET_DIR/waterayd-dev.service.template"
  install -m 0644 "$asset_dir/wateray.desktop.template" "$SYSTEM_ASSET_DIR/wateray.desktop.template"
  install -m 0644 "$asset_dir/wateray.png" "$SYSTEM_ASSET_DIR/wateray.png"
  install -m 0644 "$asset_dir/net.wateray.daemon.policy" "$SYSTEM_ASSET_DIR/net.wateray.daemon.policy"
  install -m 0644 "$asset_dir/net.wateray.daemon.policy" "$POLICY_INSTALL_PATH"
}

render_service_unit() {
  local template_path="$1"
  local destination_path="$2"
  local binary_path="$3"
  local working_dir="$4"
  local install_dir="$5"
  local data_root="$6"
  local tmp_path
  tmp_path="$(mktemp)"
  sed \
    -e "s|__WATERAY_BINARY__|$(escape_sed_replacement "$binary_path")|g" \
    -e "s|__WATERAY_WORKING_DIR__|$(escape_sed_replacement "$working_dir")|g" \
    -e "s|__WATERAY_INSTALL_DIR__|$(escape_sed_replacement "$install_dir")|g" \
    -e "s|__WATERAY_DATA_ROOT__|$(escape_sed_replacement "$data_root")|g" \
    "$template_path" >"$tmp_path"
  install -m 0644 "$tmp_path" "$destination_path"
  rm -f "$tmp_path"
}

render_desktop_entry() {
  local template_path="$1"
  local destination_path="$2"
  local exec_path="$3"
  local icon_path="$4"
  local tmp_path
  tmp_path="$(mktemp)"
  sed \
    -e "s|__WATERAY_EXEC__|$(escape_sed_replacement "$exec_path")|g" \
    -e "s|__WATERAY_ICON__|$(escape_sed_replacement "$icon_path")|g" \
    "$template_path" >"$tmp_path"
  install -m 0644 "$tmp_path" "$destination_path"
  rm -f "$tmp_path"
}

is_enabled_unit_file_state() {
  case "${1:-}" in
    enabled|enabled-runtime|linked|linked-runtime|alias)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

print_service_status() {
  local service_name="$1"
  local data_root="$2"
  local unit_name="$service_name.service"
  local unit_path="$SYSTEMD_UNIT_DIR/$unit_name"
  local load_state="not-found"
  local unit_file_state="disabled"
  local active_state="inactive"
  local sub_state="dead"
  local fragment_path=""
  local result=""

  if result="$(systemctl show "$unit_name" \
    --property=LoadState \
    --property=UnitFileState \
    --property=ActiveState \
    --property=SubState \
    --property=FragmentPath 2>/dev/null)"; then
    while IFS='=' read -r key value; do
      case "$key" in
        LoadState)
          if [[ -n "$value" ]]; then
            load_state="$value"
          fi
          ;;
        UnitFileState)
          if [[ -n "$value" ]]; then
            unit_file_state="$value"
          fi
          ;;
        ActiveState)
          if [[ -n "$value" ]]; then
            active_state="$value"
          fi
          ;;
        SubState)
          if [[ -n "$value" ]]; then
            sub_state="$value"
          fi
          ;;
        FragmentPath)
          fragment_path="$value"
          ;;
      esac
    done <<<"$result"
  fi

  local installed="false"
  if [[ -f "$unit_path" || -n "$fragment_path" || "$load_state" != "not-found" ]]; then
    installed="true"
  fi

  local enabled="false"
  if is_enabled_unit_file_state "$unit_file_state"; then
    enabled="true"
  fi

  local active="false"
  if [[ "$active_state" == "active" ]]; then
    active="true"
  fi

  printf 'service_name=%s\n' "$service_name"
  printf 'unit_name=%s\n' "$unit_name"
  printf 'unit_path=%s\n' "$unit_path"
  printf 'installed=%s\n' "$installed"
  printf 'enabled=%s\n' "$enabled"
  printf 'active=%s\n' "$active"
  printf 'load_state=%s\n' "$load_state"
  printf 'unit_file_state=%s\n' "$unit_file_state"
  printf 'active_state=%s\n' "$active_state"
  printf 'sub_state=%s\n' "$sub_state"
  printf 'fragment_path=%s\n' "$fragment_path"
  printf 'data_root=%s\n' "$data_root"
}

ensure_service() {
  local template_name="$1"
  local install_dir="$2"
  local service_name="$3"
  local data_root="$4"
  local enable_on_boot="$5"
  local template_path="$asset_dir/$template_name"
  if [[ ! -f "$template_path" ]]; then
    fail "Missing service template: $template_path"
  fi
  local binary_path="$install_dir/core/waterayd"
  local working_dir="$install_dir/core"
  if [[ ! -x "$binary_path" ]]; then
    fail "Daemon binary is not executable: $binary_path"
  fi
  mkdir -p "$SYSTEMD_UNIT_DIR" "$data_root"
  render_service_unit \
    "$template_path" \
    "$SYSTEMD_UNIT_DIR/$service_name.service" \
    "$binary_path" \
    "$working_dir" \
    "$install_dir" \
    "$data_root"
  systemctl daemon-reload
  if [[ "$enable_on_boot" == "true" ]]; then
    systemctl enable "$service_name.service" >/dev/null
  fi
  systemctl restart "$service_name.service"
}

remove_service() {
  local service_name="$1"
  local unit_name="$service_name.service"
  local unit_path="$SYSTEMD_UNIT_DIR/$unit_name"
  systemctl disable --now "$unit_name" >/dev/null 2>&1 || true
  rm -f "$unit_path"
  systemctl daemon-reload
  systemctl reset-failed "$unit_name" >/dev/null 2>&1 || true
}

install_packaged_launcher() {
  local install_dir="$1"
  local template_path="$asset_dir/wateray.desktop.template"
  local app_path="$install_dir/WaterayApp"
  if [[ ! -x "$app_path" ]]; then
    fail "Frontend executable is not executable: $app_path"
  fi
  if [[ ! -f "$template_path" ]]; then
    fail "Missing desktop template: $template_path"
  fi
  install -m 0644 "$asset_dir/wateray.png" "$SYSTEM_ICON_PATH"
  rm -f "$LEGACY_SYSTEM_ICON_PATH"
  rm -f "$LEGACY_SYSTEM_DESKTOP_PATH"
  render_desktop_entry "$template_path" "$SYSTEM_DESKTOP_PATH" "$app_path" "$SYSTEM_ICON_NAME"
}

command_name="${1:-}"
if [[ -z "$command_name" ]]; then
  fail "Missing helper command."
fi
shift

install_dir=""
service_name=""
data_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      install_dir="${2:-}"
      shift 2
      ;;
    --service-name)
      service_name="${2:-}"
      shift 2
      ;;
    --data-root)
      data_root="${2:-}"
      shift 2
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

require_root
require_command systemctl
require_command install
require_command sed

case "$command_name" in
  install-packaged|ensure-packaged)
    install_common_assets
    install_dir="$(resolve_dir "${install_dir:-$(cd "$script_dir/.." && pwd -P)}")"
    service_name="$(normalize_service_name "${service_name:-$DEFAULT_PACKAGED_SERVICE_NAME}")"
    data_root="$(resolve_path "${data_root:-$DEFAULT_PACKAGED_DATA_ROOT}")"
    install_packaged_launcher "$install_dir"
    ensure_service "waterayd.service.template" "$install_dir" "$service_name" "$data_root" "true"
    ;;
  ensure-dev)
    install_common_assets
    install_dir="$(resolve_dir "${install_dir:-}")"
    service_name="$(normalize_service_name "${service_name:-$DEFAULT_DEV_SERVICE_NAME}")"
    data_root="$(resolve_path "${data_root:-$DEFAULT_DEV_DATA_ROOT}")"
    ensure_service "waterayd-dev.service.template" "$install_dir" "$service_name" "$data_root" "false"
    ;;
  status-packaged)
    service_name="$(normalize_service_name "${service_name:-$DEFAULT_PACKAGED_SERVICE_NAME}")"
    data_root="$(resolve_path "${data_root:-$DEFAULT_PACKAGED_DATA_ROOT}")"
    print_service_status "$service_name" "$data_root"
    ;;
  status-dev)
    service_name="$(normalize_service_name "${service_name:-$DEFAULT_DEV_SERVICE_NAME}")"
    data_root="$(resolve_path "${data_root:-$DEFAULT_DEV_DATA_ROOT}")"
    print_service_status "$service_name" "$data_root"
    ;;
  uninstall-packaged)
    service_name="$(normalize_service_name "${service_name:-$DEFAULT_PACKAGED_SERVICE_NAME}")"
    remove_service "$service_name"
    ;;
  uninstall-dev)
    service_name="$(normalize_service_name "${service_name:-$DEFAULT_DEV_SERVICE_NAME}")"
    remove_service "$service_name"
    ;;
  *)
    fail "Unsupported helper command: $command_name"
    ;;
esac
