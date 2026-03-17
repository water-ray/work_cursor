# Request Monitor UI Design

## 1. Goal

This document defines the desktop-only request monitor page in the current design phase.

Current scope:

- Add a top-level desktop navigation entry: `监控`
- Provide a frontend-only request monitor page layout
- Provide a monitor creation modal
- Provide history selection, deletion, filter tags, table toolbar batch actions, compact paginated table, editable rule preview modal, and JSON preview
- Define the draft JSON log structure and frontend filtering grammar

Out of scope in this phase:

- No sing-box kernel integration
- No runtime config mutation
- No real file scan of `requestlogs`
- No real start/restart/stop service flow
- No real rule persistence

## 1.1 Implementation Status (Mar 2026)

This design doc started as a frontend prototype spec. The current codebase has moved beyond pure mock mode:

- `MonitorPage` is wired to real backend APIs for session list/read/create/delete
- backend persists monitor files under `requestlogs/*.json` with `.meta.json` sidecar files
- request records are collected from sing-box Clash API connections snapshots
- table is compact, with time shown in the last column using `HH:mm:ss` only
- batch rule generation uses one shared editable multi-line modal and supports content-mode radios:
  - process: `name` / `path`
  - domain: `exact` / `suffix` / `keyword` / `regex`
  - ip: `ip` / `cidr`

Still not included:

- rule persistence (preview is editable/copy-first)
- long-term productized workflow around monitor-triggered service restart/recovery policies

## 2. Official Documentation Basis

The design is based on the following sing-box official docs:

- [General client documentation](https://sing-box.sagernet.org/clients/general/)
- [Clash API documentation](https://sing-box.sagernet.org/zh/configuration/experimental/clash-api/)

Relevant conclusions:

1. The official client documentation explicitly says a graphical client should provide a Dashboard and display information such as connection and traffic.
2. The official docs do not define a built-in "temporary request monitor history page" or a standard request-log JSON schema for this use case.
3. The Clash API documentation describes `external_controller`, `external_ui`, and control-plane capabilities, but it still does not define the exact JSON array structure needed by Wateray for this feature.

Therefore:

- The page itself is aligned with sing-box client capabilities.
- The request monitor log format is a Wateray-defined application contract.
- The current design keeps frontend UI and backend runtime responsibilities clearly separated.

## 3. Desktop Information Architecture

Desktop navigation adds one new entry:

- `监控`: temporary monitor of inbound requests for rule drafting

Desktop page structure:

1. History monitor record selector
2. `新增` / `删除` actions
3. Tag-based filter bar
4. Table toolbar for selection summary and batch rule actions
5. Rule preview modal with content-mode radios and editable multi-line text
6. Compact paginated request table with multi-select checkboxes
7. Expanded JSON preview for one request row

## 4. User Scenario

Primary scenario:

1. User opens `监控`
2. User clicks `新增`
3. User selects monitor duration, file name, and whether to record all requests or only unmatched requests
4. User confirms the task
5. Backend temporarily raises the current proxy log level to `info`, then starts or restarts the normal proxy service if needed
6. If `仅记录漏网之鱼请求` is enabled, only unmatched requests that fall through the active rules are persisted
7. After the duration is reached, backend restores the original log level; if proxy was off before monitoring, it is stopped again
8. User selects a generated JSON record from history
9. User filters requests by process/domain/IP/tags
10. User uses request details to create custom routing rules

Current implementation uses real backend APIs for steps 4-10, while rule persistence remains preview-only.

## 5. UI Layout Spec

### 5.1 History Record Toolbar

Controls:

- Record dropdown
- `新增` button
- `删除` button

Behavior:

- Dropdown values come from future scan results of `requestlogs/*.json`
- Delete removes the currently selected log file
- In current prototype, add/delete only updates local page state
- The main view intentionally stays compact and does not show extra record path or filesystem description text

Recommended dropdown label content:

- `fileBaseName.json`
- record-scope tag
- request count

### 5.2 Create Monitor Modal

Fields:

1. `监控时长`
   - editable dropdown
   - presets: `10 / 30 / 60 / 120`
   - default: `30`
   - unit: seconds
2. `监控记录文件名称`
   - default: current date-time
   - user inputs file base name only
   - `.json` is appended internally
3. `仅记录漏网之鱼请求`
   - default: `off`
   - when enabled, only unmatched requests that fall through the active rules are recorded
   - when disabled, all requests visible to the current proxy service are recorded
4. footer buttons
   - `取消`
   - `确认`

Runtime implication after confirm:

- The backend reuses the normal proxy runtime instead of creating a dedicated monitor runtime
- Monitoring only forces proxy log level to `info` temporarily
- After monitor completion, the original log level is restored; if proxy was off before monitoring, the proxy is stopped again

### 5.3 Filter Bar

Use a multi-tag input control.

Behavior:

- User can enter multiple tags
- Press Enter to create a filter tag
- Suggestions are built from current log content
- Provide a `条件组合` toggle for `AND / OR`
- Default mode is `AND`
- `AND`: all tags must match
- `OR`: any tag match is enough
- With a single tag, the combination mode has no practical difference

Supported keys:

- `process`
- `pid`
- `domain`
- `ip`
- `port`
- `protocol`
- `inbound`
- `scope`
- `result`
- `matched`
- `outbound`
- `rule`
- `country`

If no prefix is provided, do a fuzzy match across the full request text.

Examples:

- `process:chrome.exe`
- `domain:github.com`
- `ip:8.8.8.8`
- `result:matched`
- `scope:miss_only`
- `rule:domain_suffix:telegram.org`
- `steam`

Examples with combination mode:

- `AND`: `process:chrome.exe` + `domain:github.com`
- `OR`: `domain:github.com` + `domain:githubusercontent.com`

### 5.4 Table Toolbar

The filter bar is followed by a compact table toolbar.

Toolbar content:

- current match count
- current selected row count
- `清空勾选`
- `按进程生成规则`
- `按域名生成规则`
- `按 IP 生成规则`

Behavior:

- Request rows are selected by checkbox
- Batch rule actions work on selected rows only
- Rule generation entry is no longer rendered in each row
- Toolbar actions open a rule preview modal instead of a readonly message box
- In the design phase, the modal only generates editable candidate rule content and does not persist rules

### 5.5 Rule Preview Modal

The toolbar actions open one shared modal.

Common modal content:

- selected request count
- generated rule line count
- `规则内容方式` radio group
- editable multi-line text area
- optional copy button
- field-level help icon instead of long helper paragraphs

The multi-line text area is the key design point:

- Output must match the existing rules page `匹配内容` input format
- User should be able to copy and paste directly into the rules page
- User can also make manual adjustments before copying

Process rule content modes:

- `进程名称`
  - output format: `name:chrome.exe`
- `包含路径`
  - output format: `path:C:\Program Files\Google\Chrome\Application\chrome.exe`

Domain rule content modes:

- `精确匹配`
  - output format: `exact:api.github.com`
- `域名后缀`
  - output format: `suffix:github.com`
- `关键词`
  - output format: `keyword:github`
- `正则`
  - output format example: `regex:(?i)^([a-z0-9-]+\.)*github\.com$`

IP rule content modes:

- `单个 IP`
  - output format: `ip:8.8.8.8`
- `CIDR /32`
  - output format: `cidr:8.8.8.8/32`

### 5.6 Request Table

The table is paginated because request count can be large.
The table should use a compact visual style.

Recommended columns:

1. `进程`
2. `目标`
3. `监控结果`
4. `流量`
5. `时间`

Column meaning:

- `进程`: process name only; if name is missing but path exists, derive the filename from path
- `目标`: single-line `domain:port` or `ip:port`; domain has display priority
- `监控结果`: rule-hit result, outbound tag, suggested rule
- `时间`: time only, no date, recommended format `HH:mm:ss`

Notes:

- `协议 / 入站` no longer occupy a dedicated table column
- These fields remain available in raw JSON, filter tags, and future backend payloads
- The table must support multi-select checkboxes for batch actions
- The time column should be placed at the far right for compact scanning
- The compact table should use single-line cell content wherever possible and avoid oversized summary cards above it

### 5.7 Row Expansion

Expanded row should show:

- full JSON structure of the request record
- open by double-clicking a row

Purpose:

- Help confirm backend log shape before real implementation
- Make later frontend-backend integration easier

## 6. Draft Log File Contract

The log file should be a JSON array.

Draft shape:

```json
[
  {
    "timestamp_ms": 1710660000000,
    "process": {
      "pid": 4201,
      "name": "chrome.exe",
      "path": "C:/Program Files/Google/Chrome/Application/chrome.exe"
    },
    "request": {
      "domain": "api.github.com",
      "destination_ip": "140.82.114.6",
      "destination_port": 443,
      "network": "tcp",
      "protocol": "tls",
      "inbound_tag": "tun-in",
      "country": "US"
    },
    "monitor": {
      "record_scope": "all",
      "rule_missed": false,
      "matched_rule": "DOMAIN-SUFFIX,github.com",
      "outbound_tag": "select-auto",
      "suggested_rule": "domain_suffix:github.com",
      "upload_bytes": 1024,
      "download_bytes": 4096
    },
    "tags": [
      "process:chrome.exe",
      "pid:4201",
      "domain:api.github.com",
      "ip:140.82.114.6",
      "port:443",
      "protocol:tls",
      "inbound:tun-in",
      "scope:all",
      "result:matched",
      "rule:domain_suffix:github.com",
      "country:US"
    ]
  }
]
```

Why JSON array:

- The user requirement already expects a JSON structure from the monitor result
- A JSON array is easy for frontend pagination, filtering, export, and future diff logic
- It is also straightforward for backend to write once monitoring finishes

## 7. Future Backend Responsibilities

The backend phase should later do the following:

1. Scan `requestlogs` directory and return available record files
2. Create a monitor task from:
   - `durationSec`
   - `fileBaseName`
   - `recordScope`
3. Temporarily persist proxy log level as `info`
4. Start or restart current proxy service
5. Record request events into `requestlogs/<fileBaseName>.json`
6. Stop monitoring when duration expires
7. Restore original log level, and stop proxy if monitoring started it
8. Delete one selected monitor log file
9. Read one selected monitor log file as JSON array

This document intentionally does not define the backend API names yet.
Only the UI behavior and data contract are fixed here.

## 8. Frontend Handoff Notes

Current prototype choices:

- Desktop only
- Mock history records
- Mock request rows
- Real filter logic
- Real pagination logic
- Real create/delete UI flow
- No runtime side effects

Frontend assumptions for next stage:

- Record list will later be replaced by backend directory scan results
- Selected log content will later be replaced by backend JSON file loading
- Create modal confirm will later trigger backend monitoring
- Delete will later remove the actual file
- Table toolbar rule buttons will later open or populate custom rule drafting flow based on selected rows

## 9. Design Decisions To Confirm Before Backend Phase

These should be confirmed before implementing the backend:

1. Whether one log file is written progressively or written only after monitor completion
2. Whether the frontend should support exporting filtered subsets
3. Whether generated rule drafts should open in a rule editor modal or jump to rules page

