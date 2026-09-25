#!/usr/bin/env bash
# ============================================================================
#  DeepSeek Harness —— Linux 桌面启动器
#
#  本文件由 dsh-linux-integration v@@VERSION@@ 自动生成，请勿手工编辑。
#  需要改配置请编辑：@@CONFIG_FILE@@
#  重新生成请执行：  dsh-lxi install --force
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
LOG_FILE="@@LOG_FILE@@"
DSH_BIN="@@DSH_BIN@@"
EXTRA_PATH="@@EXTRA_PATH@@"
VERSION="@@VERSION@@"

# ---------------------------------------------------------------------------
# 可以被环境变量覆盖的三项
#
# 桌面入口的「以开发配置运行」右键动作就是靠它们切到另一套 profile / 端口 /
# 沙箱根目录的。默认值来自安装那一刻的 config.json。
#
# DSH_PROFILE 与上面的 PROFILE_MODE / PROFILE_DIR 无关 —— 那两个说的是**浏览器**
# 配置目录，这个说的是 **dsh profile**。命名撞车是历史原因，别混。
# ---------------------------------------------------------------------------

DSH_PROFILE="${DSH_DESKTOP_PROFILE:-@@PROFILE@@}"
PORT="${DSH_DESKTOP_PORT:-@@PORT@@}"

RUNTIME_DIR="@@RUNTIME_DIR@@"

# DSH_DESKTOP_ROOT 会把插件的 config / data / runtime / bin 全部重定向到沙箱里
# （见 src/paths.js）。运行时目录和日志路径必须跟着改 —— 否则启动器会去真实目录
# 找一个永远不会出现的 runtime.env，拿不到带 token 的地址。
#
# ⚠️ 下面两行必须与 paths.js 的 runtimeDir / logFile 逐字一致：
#      runtimeDir = $DSH_DESKTOP_ROOT/runtime/dsh-lxi
#      logFile    = $DSH_DESKTOP_ROOT/runtime/dsh-lxi-web.log
if [ -n "${DSH_DESKTOP_ROOT:-}" ]; then
  RUNTIME_DIR="$DSH_DESKTOP_ROOT/runtime/dsh-lxi"
  LOG_FILE="$DSH_DESKTOP_ROOT/runtime/dsh-lxi-web.log"
fi

RUNTIME_ENV="$RUNTIME_DIR/runtime.env"
RUNTIME_JSON="$RUNTIME_DIR/runtime.json"

# 独立窗口进程存活时间短于这个秒数，就认为发生了「移交给既有浏览器进程」
# 或启动失败 —— 两种情况都不能据此判定「窗口已关闭」。
HANDOFF_THRESHOLD=3

DEBUG="${DSH_DESKTOP_DEBUG:-0}"
log() { [ "$DEBUG" = "1" ] && printf '[dsh-lxi] %s\n' "$*" >&2 || true; }

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

# 服务端 Loader 树是否已经落定。
#
# 判据是 `dsh web: <url>` 这一行 —— 它由 dsh-web-app 在整棵插件树加载完之后才
# 打印。这是**唯一**可靠的就绪信号：HTTP 端口在第一个插件激活时就 bind 了，
# 但此时工作区 / 会话等 API 控制器可能还没注册。
server_settled() {
  [ -f "$LOG_FILE" ] || return 1
  grep -q '^dsh web: ' "$LOG_FILE" 2>/dev/null
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

# 日志文件是否是「刚刚由启动器写下的」。
#
# 用来区分两种「服务在跑」：我们自己刚拉起的（start_server 会截断日志 → mtime 很新）
# 与用户在终端里早就启好的（日志要么不存在，要么是上一次留下的）。后者等下去也
# 等不到新的 `dsh web:` 行，只会白等满超时。
log_is_fresh() {
  [ -f "$LOG_FILE" ] || return 1
  find "$LOG_FILE" -newermt '-5 minutes' -print -quit 2>/dev/null | grep -q .
}

# 等 Loader 树落定。
#
# **这是「冷启动打开桌面端，侧栏里一个工作区都没有、像全新安装」的根因修复。**
#
# 实测（该用户完整插件集，15 个 bundle）：端口 3.0 秒可连，插件行 4.1 秒就把
# 运行时文件写出来了，但整棵树要到 **33.7 秒**才落定。而运行时文件是「尽早发布」
# 的，`resolve_url` 会立刻命中它 —— 于是窗口在服务端刚起来 4 秒时就打开了，
# 比工作区 / 会话这些 API 控制器注册完早了近 30 秒。前端在那时发起的首屏请求
# 拿不到数据，就会渲染成空侧栏，而且不会自己重试。
#
# 复用别人的服务时不需要等（那棵树早就落定了），所以由 log_is_fresh 兜住。
#
# @param $1 最长等待秒数
wait_settled() {
  local timeout="$1"
  if ! log_is_fresh; then
    log "启动日志不是本次产生的，跳过等待 Loader 树"
    return 1
  fi
  local attempts=$(( timeout * 4 ))
  local i
  for i in $(seq 1 "$attempts"); do
    server_settled && return 0
    # 服务已经死了就不必空等。
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "等待 Loader 树时服务已退出"
      return 1
    fi
    sleep 0.25
  done
  log "等待 Loader 树落定超时（${timeout}s），仍继续开窗"
  return 1
}

# 用一次真实的鉴权 API 调用确认「后端现在能列出会话」。
#
# 为什么在 wait_settled 之外还要这一步：树落定只说明插件都加载完了，而用户看到
# 的是**会话列表**。这里直接问一句「现在能不能列出会话」—— 前端首屏要的就是这个
# 答案。两道闸门都过，才可以说「打开窗口时后端真的可用了」。
#
# 安全性：launch token 可以重复交换（实测连续 3 次都是 303 + 种 cookie），所以
# 这里先换 cookie 不会把 token 用掉、不影响随后浏览器自己再换一次。
#
# 没有 curl 时返回 1（调用方退回「只等树落定」）。
#
# @param $1 带 token 的地址
api_ready() {
  local url="$1"
  [ -n "$CURL" ] || return 1
  case "$url" in *token=*) ;; *) return 1 ;; esac

  local jar="$RUNTIME_DIR/.probe-cookies"
  "$CURL" -s -o /dev/null -m 5 -c "$jar" "$url" 2>/dev/null || true

  local body
  body="$("$CURL" -s -m 5 -b "$jar" -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"dsh-lxi-probe","method":"session/list","payload":{"args":{"_request":{}}}}' \
    "http://$HOST:$PORT/api/session/list" 2>/dev/null)" || true

  case "$body" in *'"ok":true'*) return 0 ;; esac
  return 1
}

# 轮询等待会话 API 真正可用。
#
# @param $1 带 token 的地址
# @param $2 最长等待秒数
wait_api_ready() {
  local url="$1" timeout="$2"
  local attempts=$(( timeout * 2 ))
  local i
  for i in $(seq 1 "$attempts"); do
    api_ready "$url" && { log "会话 API 已就绪"; return 0; }
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "等待会话 API 时服务已退出"
      return 1
    fi
    sleep 0.5
  done
  log "等待会话 API 就绪超时（${timeout}s），仍继续开窗"
  return 1
}

# ---------------------------------------------------------------------------
# 服务启停
# ---------------------------------------------------------------------------

SERVER_PID=""

start_server() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  : >"$LOG_FILE" 2>/dev/null || true

  log "拉起 dsh（profile $DSH_PROFILE）：$DSH_BIN --profile $DSH_PROFILE --no-open --port $PORT"
  # setsid 让服务脱离本脚本的进程组：脚本退出（比如窗口秒关）不会连带打死服务，
  # 同时它自己成为一个新进程组的组长，方便稍后整组回收。
  PATH="$EXTRA_PATH:$PATH" setsid "$DSH_BIN" --profile "$DSH_PROFILE" --no-open --port "$PORT" --host "$HOST" >>"$LOG_FILE" 2>&1 &
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
  # 那个实例可能正在拉起服务（树还没落定）。等一等，否则这个窗口同样会
  # 渲染成空侧栏。日志不是本次产生的（服务早就跑着）时 wait_settled 会立刻返回。
  wait_settled 120 || true
  SECOND_URL="$(resolve_url 5)"
  wait_api_ready "$SECOND_URL" 20 || true
  rm -f "$RUNTIME_DIR/.probe-cookies" 2>/dev/null || true
  open_window "$SECOND_URL"
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
  # 先等整棵树落定，再取地址 —— 顺序不能反。若先取地址，会立刻命中插件「尽早
  # 发布」的运行时文件，窗口就在服务端还没就绪时打开了（见 wait_settled 注释）。
  # 120 秒上限是实测 33.7 秒的约 3.5 倍余量；轮询是即时的，放宽不会拖慢正常路径。
  wait_settled 120 || true
  TARGET_URL="$(resolve_url 30)"
  # 再过一道「会话 API 真的能应答」的闸门，然后清掉探测用的 cookie 罐。
  wait_api_ready "$TARGET_URL" 30 || true
  rm -f "$RUNTIME_DIR/.probe-cookies" 2>/dev/null || true
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
    # 「仍在后台运行」这一句走**通知标题**，不走正文。
    #
    # 原因：FreeDesktop 通知的正文标记（body-markup）只支持 <b>/<i>/<u>/<a>/<img>，
    # **没有字号**。唯一能让一段文字「较大且较粗」的字段就是 summary（标题）——
    # KDE Plasma、GNOME、dunst 都会把标题渲染得比正文更大更粗。所以第一句放标题、
    # 去掉句号；第二句原样留在正文。
    notify "dsh web 服务仍在后台运行" \
      "停止：dsh-lxi stop" low
  fi
  exit 0
fi

if [ "$LIVED" -lt "$HANDOFF_THRESHOLD" ]; then
  if [ "$EFFECTIVE_MODE" = "dedicated" ]; then
    # 独立配置目录下进程本该与窗口同生共死；秒退说明启动失败。
    notify "DeepSeek Harness 窗口启动失败" "$BROWSER_LABEL 未能打开独立窗口。\n可执行：dsh-lxi doctor" critical
    stop_server "$SERVER_PID"
    exit 1
  fi
  # 共享配置目录下秒退是正常的「移交给既有浏览器进程」，此时无法感知窗口关闭，
  # 所以这次启动器**自己起的**服务会留在后台 —— 这是个真实的孤儿，必须告诉
  # 用户怎么收掉，否则就只能重启或等下次登录。
  log "检测到窗口移交给既有浏览器进程，无法判定关闭时刻，服务保持运行"
  notify "DeepSeek Harness" \
    "窗口已交给现有浏览器进程。\n共享配置模式下无法感知窗口关闭，本次启动的 dsh web 会留在后台。\n要停止请执行：dsh-lxi stop；或把 profileMode 改为 dedicated 实现「关窗即停」。" normal
  exit 0
fi

stop_server "$SERVER_PID"
log "已退出"
exit 0
