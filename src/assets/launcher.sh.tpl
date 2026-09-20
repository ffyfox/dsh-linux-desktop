#!/usr/bin/env bash
# ============================================================================
#  DeepSeek Harness —— Linux 桌面启动器
#
#  本文件由 dsh-linux-desktop v@@VERSION@@ 自动生成，请勿手工编辑。
#  需要改配置请编辑：@@CONFIG_FILE@@
#  重新生成请执行：  dsh-desktop install --force
#
#  职责（严格按顺序）：
#    1. 探测 dsh web 是否已在监听；没在监听就在后台静默拉起。
#    2. 取得**带 token 的**地址 —— dsh web 有鉴权围栏，裸地址会 401。
#    3. 用 Chromium 的 --app 模式打开无地址栏 / 无标签页的纯净独立窗口。
#    4. 等待窗口关闭；若这个服务是**本脚本自己拉起的**，就把它停掉。
#
#  安全底线：绝不停掉「不是自己启动的」服务。你在终端里手动跑的 dsh web、
#  或者别的 dsh 会话，本脚本只复用、不接管。
# ============================================================================

set -uo pipefail

HOST="@@HOST@@"
PORT="@@PORT@@"
WINDOW_SIZE="@@WINDOW_SIZE@@"
BROWSER="@@BROWSER@@"
BROWSER_LABEL="@@BROWSER_LABEL@@"
PROFILE_MODE="@@PROFILE_MODE@@"
PROFILE_DIR="@@PROFILE_DIR@@"
RUNTIME_DIR="@@RUNTIME_DIR@@"
RUNTIME_ENV="$RUNTIME_DIR/runtime.env"
RUNTIME_JSON="$RUNTIME_DIR/runtime.json"
LOG_FILE="@@LOG_FILE@@"
DSH_BIN="@@DSH_BIN@@"
EXTRA_PATH="@@EXTRA_PATH@@"
VERSION="@@VERSION@@"

# 独立窗口进程存活时间短于这个秒数，就认为发生了「移交给既有浏览器进程」
# 或启动失败 —— 两种情况都不能据此判定「窗口已关闭」。
HANDOFF_THRESHOLD=3

DEBUG="${DSH_DESKTOP_DEBUG:-0}"
log() { [ "$DEBUG" = "1" ] && printf '[dsh-desktop] %s\n' "$*" >&2 || true; }

# 带 token 的地址等同于一张 30 天有效的会话通行证，调试日志里必须打码。
# 字符类里必须同时排除空格与 `&`，否则会一路吃到行尾，把后面的参数也吞掉。
redact() { printf '%s' "$1" | sed 's/token=[^ &]*/token=<REDACTED>/g'; }

notify() {
  local title="$1" body="$2" urgency="${3:-normal}"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name="DeepSeek Harness" --urgency="$urgency" --icon=deepseek-harness "$title" "$body" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# 服务探测
# ---------------------------------------------------------------------------

CURL=""
command -v curl >/dev/null 2>&1 && CURL="$(command -v curl)"

# 任何 HTTP 响应都算「在监听」—— 包括 401。鉴权失败恰恰说明服务活着。
server_up() {
  if [ -n "$CURL" ]; then
    local code
    code="$("$CURL" -s -o /dev/null -m 2 -w '%{http_code}' "http://$HOST:$PORT/" 2>/dev/null)" || true
    [ -n "$code" ] && [ "$code" != "000" ]
  else
    # 没有 curl 时的兜底：bash 内建 /dev/tcp。
    (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# 运行时状态读取（由 dsh web 里的插件宿主行写入）
# ---------------------------------------------------------------------------

runtime_field() {
  [ -f "$RUNTIME_ENV" ] || return 1
  grep -m1 "^$1=" "$RUNTIME_ENV" 2>/dev/null | cut -d= -f2-
}

# 运行时文件可能来自一个已经死掉或换了端口的旧进程，必须校验。
runtime_url_if_fresh() {
  local pid port url
  pid="$(runtime_field pid)" || return 1
  port="$(runtime_field port)" || return 1
  url="$(runtime_field url)" || return 1
  [ -n "$url" ] || return 1
  [ "$port" = "$PORT" ] || { log "运行时文件端口 $port 与配置 $PORT 不符，忽略"; return 1; }
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || { log "运行时文件记录的进程 $pid 已不存在，忽略"; return 1; }
  printf '%s' "$url"
}

# 从我们自己的启动日志里抓 token。仅当服务是本脚本拉起时才有意义。
token_from_log() {
  [ -f "$LOG_FILE" ] || return 1
  local url
  url="$(grep -o 'http://[^ ]*token=[^ )]*' "$LOG_FILE" 2>/dev/null | tail -n1)" || true
  [ -n "$url" ] || return 1
  printf '%s' "$url"
}

# 单次尝试：插件写的运行时文件 → 启动日志。
resolve_url_once() {
  local url
  url="$(runtime_url_if_fresh)" && [ -n "$url" ] && { printf '%s' "$url"; return 0; }
  url="$(token_from_log)" && [ -n "$url" ] && { printf '%s' "$url"; return 0; }
  return 1
}

# 轮询等待带 token 的地址出现。
#
# 为什么必须等：HTTP 端口在插件行激活时就已经 bind，`server_up` 立刻为真；但
# 「dsh web: http://...?token=...」这行要等整棵 Loader 树落定才打印（所有插件
# 都加载完）。如果这里不等，就会拿着裸地址去开窗口 —— 而独立浏览器配置目录里
# 没有 cookie，页面直接 401。
#
# @param $1 最长等待秒数
resolve_url() {
  local timeout="$1"
  local attempts=$(( timeout * 4 ))
  local url i
  for i in $(seq 1 "$attempts"); do
    if url="$(resolve_url_once)"; then
      printf '%s' "$url"
      return 0
    fi
    sleep 0.25
  done
  # 兜底：裸地址。cookie 仍在有效期（默认 30 天）时依然可用。
  printf 'http://%s:%s/' "$HOST" "$PORT"
}

# ---------------------------------------------------------------------------
# 服务启停
# ---------------------------------------------------------------------------

SERVER_PID=""

start_server() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  : >"$LOG_FILE" 2>/dev/null || true

  log "拉起 dsh web：$DSH_BIN web --no-open --port $PORT"
  # setsid 让服务脱离本脚本的进程组：脚本退出（比如窗口秒关）不会连带打死服务，
  # 同时它自己成为一个新进程组的组长，方便稍后整组回收。
  PATH="$EXTRA_PATH:$PATH" setsid "$DSH_BIN" web --no-open --port "$PORT" --host "$HOST" >>"$LOG_FILE" 2>&1 &
  SERVER_PID=$!
}

wait_ready() {
  # 实测（Arch + KDE + 该用户完整的插件集）：端口 4.6 秒可连、5.0 秒拿到 token。
  # 这里给到 40 秒（约 8 倍余量），因为超时的代价很重 —— 会误报「启动失败」并
  # 把刚拉起来的服务杀掉。轮询是即时的，所以放宽上限不会拖慢正常路径。
  local i
  for i in $(seq 1 160); do
    server_up && return 0
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "dsh web 进程已退出，启动失败"
      return 1
    fi
    sleep 0.25
  done
  return 1
}

stop_server() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || { log "服务 $pid 已不在"; return 0; }

  log "停止服务 $pid"
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  local i
  for i in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "优雅退出超时，强制结束"
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi

  # 只清理「确实属于刚停掉的那个进程」的运行时文件，避免误删别人的状态。
  local recorded
  recorded="$(runtime_field pid)" || recorded=""
  if [ -z "$recorded" ] || [ "$recorded" = "$pid" ]; then
    rm -f "$RUNTIME_ENV" "$RUNTIME_JSON" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# 窗口
# ---------------------------------------------------------------------------

open_window() {
  local url="$1"
  local mode="${2:-$PROFILE_MODE}"
  local args=(--app="$url" "--window-size=$WINDOW_SIZE" --ozone-platform-hint=auto
              --no-first-run --no-default-browser-check)

  if [ "$mode" = "dedicated" ]; then
    mkdir -p "$PROFILE_DIR" 2>/dev/null || true
    args+=(--user-data-dir="$PROFILE_DIR")
  fi

  log "启动 $BROWSER_LABEL（$mode）：$(redact "${args[*]}")"
  "$BROWSER" "${args[@]}" >/dev/null 2>&1 &
  BROWSER_PID=$!
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

mkdir -p "$RUNTIME_DIR" 2>/dev/null || true

# 单实例锁：只有拿到锁的那个实例负责「服务的生命周期」。第二次点击图标时，
# 它只补开一个窗口就退出，绝不去管服务。
#
# 注意：这里**绝不能**写成 `exec 9>file 2>/dev/null`。`exec` 后面没有命令时，
# 它的所有重定向都会**永久**作用在当前 shell 上 —— 那个 `2>/dev/null` 会把
# 整个脚本后续的 stderr（也就是所有调试日志）全部丢进黑洞。
LOCK_OK=0
if command -v flock >/dev/null 2>&1 && [ -d "$RUNTIME_DIR" ] && [ -w "$RUNTIME_DIR" ]; then
  if exec 9>"$RUNTIME_DIR/launcher.lock"; then
    LOCK_OK=1
  fi
fi

if [ "$LOCK_OK" = "1" ] && ! flock -n 9; then
  log "已有实例在管理生命周期，只补开窗口"
  open_window "$(resolve_url 5)"
  exit 0
fi

STARTED_BY_US=0
if server_up; then
  log "复用已在监听的 dsh web（不是本脚本启动，不会去停它）"
else
  start_server
  if ! wait_ready; then
    notify "DeepSeek Harness 启动失败" "dsh web 未能在预期时间内就绪。\n日志：$LOG_FILE" critical
    stop_server "$SERVER_PID"
    exit 1
  fi
  STARTED_BY_US=1
  log "dsh web 已就绪，等待鉴权地址…"
fi

# 我们自己启的服务：等它打印 token（Loader 树落定需要几秒）。
# 复用别人的服务：只短暂等一下运行时文件，拿不到就用裸地址（依赖已有 cookie）。
if [ "$STARTED_BY_US" = "1" ]; then
  TARGET_URL="$(resolve_url 30)"
else
  TARGET_URL="$(resolve_url 3)"
fi
log "目标地址：$(redact "$TARGET_URL")"

# 没拿到 token 时的兜底。
#
# 独立浏览器配置目录是「干净」的：没有 cookie 就必然 401。而 token 拿不到只有
# 两种情况 —— 服务不是本脚本启的（因此也不会被本脚本停掉），或者插件没能发布
# 运行时状态。两种情况下「窗口能正常打开」都比「坚持用独立配置目录」重要。
#
# 判据用「独立配置目录里有没有 Cookies 文件」：有就说明它以前登录过，30 天
# cookie 可能仍在有效期，继续用独立目录即可。
NO_TOKEN=0
case "$TARGET_URL" in
  *token=*) ;;
  *) NO_TOKEN=1 ;;
esac

EFFECTIVE_MODE="$PROFILE_MODE"
if [ "$NO_TOKEN" = "1" ] && [ "$PROFILE_MODE" = "dedicated" ] && [ ! -f "$PROFILE_DIR/Default/Cookies" ]; then
  log "未取得 token，且独立配置目录从未登录过 → 本次改用默认浏览器配置以避免 401"
  EFFECTIVE_MODE="shared"
  notify "DeepSeek Harness" \
    "未能取得带 token 的鉴权地址，本次改用你的默认浏览器配置打开。\n重启一次 dsh web 后，桌面图标即可使用独立窗口。" normal
fi

open_window "$TARGET_URL" "$EFFECTIVE_MODE"
LAUNCH_TS=$(date +%s)
wait "$BROWSER_PID" 2>/dev/null
LIVED=$(( $(date +%s) - LAUNCH_TS ))
log "窗口进程结束，存活 ${LIVED}s"

if [ "$STARTED_BY_US" != "1" ]; then
  log "服务不是本脚本启动的，保持不动"
  # 用户此刻的预期是「窗口关了，服务应该也没了」。它还在，必须解释清楚，
  # 否则看起来就像坏了。只在 dedicated 模式下提示：那种模式下用户明确选了
  # 「关窗即停」，静默不生效才叫意外；shared 模式下服务常驻是约定行为，
  # 每次都弹通知只会变成噪音。
  if [ "$PROFILE_MODE" = "dedicated" ]; then
    notify "DeepSeek Harness" \
      "窗口已关闭，但 dsh web 仍在后台运行。\n它是从终端或其它方式启动的，桌面启动器不会去停它（避免误杀你自己的服务）。\n要停止请执行：dsh-desktop stop" low
  fi
  exit 0
fi

if [ "$LIVED" -lt "$HANDOFF_THRESHOLD" ]; then
  if [ "$EFFECTIVE_MODE" = "dedicated" ]; then
    # 独立配置目录下进程本该与窗口同生共死；秒退说明启动失败。
    notify "DeepSeek Harness 窗口启动失败" "$BROWSER_LABEL 未能打开独立窗口。\n可执行：dsh-desktop doctor" critical
    stop_server "$SERVER_PID"
    exit 1
  fi
  # 共享配置目录下秒退是正常的「移交给既有浏览器进程」，此时无法感知窗口关闭，
  # 所以这次启动器**自己起的**服务会留在后台 —— 这是个真实的孤儿，必须告诉
  # 用户怎么收掉，否则就只能重启或等下次登录。
  log "检测到窗口移交给既有浏览器进程，无法判定关闭时刻，服务保持运行"
  notify "DeepSeek Harness" \
    "窗口已交给现有浏览器进程。\n共享配置模式下无法感知窗口关闭，本次启动的 dsh web 会留在后台。\n要停止请执行：dsh-desktop stop；或把 profileMode 改为 dedicated 实现「关窗即停」。" normal
  exit 0
fi

stop_server "$SERVER_PID"
log "已退出"
exit 0
