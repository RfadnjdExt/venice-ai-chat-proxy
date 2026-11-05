#!/usr/bin/env bash
# Runs live checks against real Venice for a list of configurations, each on its
# own proxy instance, and prints a summary table.
#
# Usage: scripts/live-matrix.sh <config-file>
#
# Config file: one configuration per line, fields separated by "|":
#   name | branch | env | models | prepare | command
#   - name:    label, used for result files
#   - branch:  local branch or commit to run the proxy from
#   - env:     space-separated KEY=VALUE pairs for the proxy and the command
#   - models:  space-separated model ids (the command runs once per model)
#   - prepare: optional shell command run inside the checkout before the proxy
#              starts (e.g. applying a throwaway patch); must not contain "|"
#   - command: "check:tools" (default) or "shell:<command>", the rest of the
#              line (may contain "|"); a shell command gets MODEL, BASE_URL,
#              RESULT_FILE, CHECKOUT and RESULTS in its env
# Blank lines and lines starting with # are ignored.
#
# Safety:
# - the proxy runs on LIVE_MATRIX_PORT (default 3457); 3456 and ports already in
#   use are refused, so a proxy you are running is never touched;
# - each configuration runs from a fresh clone under /tmp, and the commit that
#   /support/info reports must match the expected one;
# - the proxy uses a copy of the session file and never retries a 429 itself;
# - the whole matrix stops at the first auth error, 401/403/429, rate-limit
#   message or proxy 500, so a bad session or throttling cannot turn into a
#   burst of requests;
# - LIVE_MATRIX_PAUSE seconds (default 5) pass between runs.
#
# Results: ~/live-results/<timestamp>/ (override with LIVE_MATRIX_RESULTS).
# LIVE_MATRIX_PROXY_CMD replaces the proxy command (for dry runs; "{checkout}"
# and "{port}" are substituted).

set -euo pipefail

CONFIG_FILE=${1:?usage: scripts/live-matrix.sh <config-file>}
PORT=${LIVE_MATRIX_PORT:-3457}
PAUSE=${LIVE_MATRIX_PAUSE:-5}
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RESULTS=${LIVE_MATRIX_RESULTS:-$HOME/live-results/$(date +%Y%m%d-%H%M%S)}
SESSION_SOURCE=${VENICE_SESSION_FILE:-$REPO/.venice-web-session.json}
FATAL_RE='HTTP 40[13]|HTTP 429|status=(401|403|429|500)|Too Many Requests|rate.?limit|No valid Venice web session|Unauthorized|Forbidden|could not load model catalog|modelOverloaded'

if [[ "$PORT" == "3456" ]]; then
  echo "refusing port 3456: that is the regular proxy's port" >&2
  exit 1
fi

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

if port_in_use "$PORT"; then
  echo "port $PORT is already in use; refusing to start" >&2
  exit 1
fi

mkdir -p "$RESULTS"
WORK=$(mktemp -d /tmp/live-matrix.XXXXXX)
cp "$SESSION_SOURCE" "$WORK/session.json"
PROXY_PID=""
CHECK_PID=""

cleanup() {
  [[ -n "$CHECK_PID" ]] && kill "$CHECK_PID" 2>/dev/null || true
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a "$RESULTS/matrix.log"
}

# Stops everything and exits when a log shows auth trouble or throttling.
abort_if_fatal() {
  local file
  for file in "$@"; do
    [[ -f "$file" ]] || continue
    local hit
    hit=$(grep -E -i -m1 "$FATAL_RE" "$file" || true)
    if [[ -n "$hit" ]]; then
      log "STOP: fatal response in $(basename "$file"): ${hit:0:300}"
      [[ -n "$CHECK_PID" ]] && kill "$CHECK_PID" 2>/dev/null || true
      [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
      exit 2
    fi
  done
}

stop_proxy() {
  if [[ -n "$PROXY_PID" ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
  fi

  for _ in $(seq 1 20); do
    port_in_use "$PORT" || return 0
    sleep 0.5
  done
  log "port $PORT still in use after stopping the proxy"
  exit 1
}

start_proxy() {
  local name=$1 checkout=$2 expected=$3 env_list=$4
  local proxy_log="$RESULTS/$name.proxy.log"
  local cmd=${LIVE_MATRIX_PROXY_CMD:-"node src/proxy.mjs"}
  cmd=${cmd//\{checkout\}/$checkout}
  cmd=${cmd//\{port\}/$PORT}
  # shellcheck disable=SC2086
  (cd "$checkout" && exec env PORT="$PORT" HOST=127.0.0.1 VENICE_SESSION_FILE="$WORK/session.json" \
    VENICE_MODEL_OVERLOADED_MAX_RETRIES=0 $env_list bash -c "exec $cmd") >"$proxy_log" 2>&1 &
  PROXY_PID=$!

  local info=""
  for _ in $(seq 1 120); do
    abort_if_fatal "$proxy_log"
    kill -0 "$PROXY_PID" 2>/dev/null || { log "proxy for $name exited; see $proxy_log"; exit 1; }
    info=$(curl -sf "http://127.0.0.1:$PORT/support/info" 2>/dev/null || true)
    [[ -n "$info" ]] && break
    sleep 0.5
  done
  [[ -n "$info" ]] || { log "proxy for $name did not answer /support/info"; exit 1; }
  local commit
  commit=$(printf '%s' "$info" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).build?.commit ?? ""))')
  if [[ "$commit" != "$expected" ]]; then
    log "STOP: proxy on $PORT reports commit '$commit', expected $expected"
    exit 1
  fi
  # The catalog request at startup is the first real Venice call.
  sleep 2
  abort_if_fatal "$proxy_log"
  log "proxy for $name up on $PORT at ${commit:0:7}"
}

run_command() {
  local name=$1 checkout=$2 env_list=$3 model=$4 command=$5
  local result="$RESULTS/$name-$model.txt"
  local proxy_log="$RESULTS/$name.proxy.log"
  local base_url="http://127.0.0.1:$PORT/v1"
  log "run $name model=$model command=$command"
  if [[ "$command" == check:tools ]]; then
    # shellcheck disable=SC2086
    (cd "$checkout" && exec env $env_list CHECK_PROXY_MODEL="$model" CHECK_PROXY_BASE_URL="$base_url" \
      node check/tools.mjs) >"$result" 2>&1 &
  else
    # shellcheck disable=SC2086
    (cd "$checkout" && exec env $env_list MODEL="$model" BASE_URL="$base_url" RESULT_FILE="$result" \
      CHECKOUT="$checkout" RESULTS="$RESULTS" bash -c "${command#shell:}") >"$result" 2>&1 &
  fi
  CHECK_PID=$!
  while kill -0 "$CHECK_PID" 2>/dev/null; do
    abort_if_fatal "$proxy_log" "$result"
    sleep 0.5
  done
  local status=0
  wait "$CHECK_PID" || status=$?
  CHECK_PID=""
  abort_if_fatal "$proxy_log" "$result"
  log "done $name model=$model exit=$status"
}

trim() {
  local value=$1
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

first=1
while IFS='|' read -r name branch env_list models prepare command || [[ -n "${name:-}" ]]; do
  name=$(trim "${name:-}")
  [[ -z "$name" || "$name" == \#* ]] && continue
  branch=$(trim "$branch")
  env_list=$(trim "${env_list:-}")
  models=$(trim "${models:-}")
  command=$(trim "${command:-}")
  command=${command:-check:tools}
  prepare=$(trim "${prepare:-}")

  [[ $first -eq 1 ]] || sleep "$PAUSE"
  first=0

  expected=$(git -C "$REPO" rev-parse "$branch^{commit}")
  checkout="$WORK/$name"
  git clone -q --shared --no-checkout "$REPO" "$checkout"
  git -C "$checkout" checkout -q --detach "$expected"
  ln -s "$REPO/node_modules" "$checkout/node_modules"
  if [[ -n "$prepare" ]]; then
    (cd "$checkout" && bash -c "$prepare") || { log "prepare failed for $name"; exit 1; }
  fi

  start_proxy "$name" "$checkout" "$expected" "$env_list"
  firstModel=1
  for model in $models; do
    [[ $firstModel -eq 1 ]] || sleep "$PAUSE"
    firstModel=0
    run_command "$name" "$checkout" "$env_list" "$model" "$command"
  done
  stop_proxy
  log "proxy for $name stopped; port $PORT free"
done <"$CONFIG_FILE"

# Summary of every check:tools result in this run.
summary="$RESULTS/summary.txt"
{
  printf '%-38s %-11s %-11s %-14s %-34s %s\n' model format round_trip opencode_exact trailing_newlines_exact retries
  for result in "$RESULTS"/*.txt; do
    [[ "$result" == "$summary" ]] && continue
    grep -q "opencode-like success rate" "$result" 2>/dev/null || continue
    name=$(basename "$result" .txt)
    model=$(sed -n 's/^Using model: \([^ ]*\).*/\1/p' "$result" | head -1)
    config=${name%-"$model"}
    format=$(grep -F "model=\"$model\"" "$RESULTS/$config.proxy.log" 2>/dev/null | grep -o 'tool_format=[a-z-]*' | head -1 | sed 's/.*=//')
    round=$(awk '/── tool round trip/ {inside=1; seen=1; next} /^── / {inside=0} inside && /FAIL/ {fail+=1} END {print (!seen ? "-" : fail ? fail " FAIL" : "pass")}' "$result")
    rate=$(sed -n 's/^opencode-like success rate ([^)]*): stream=false: \([0-9]*\)\/\([0-9]*\), stream=true: \([0-9]*\)\/\([0-9]*\)/\1 \2 \3 \4/p' "$result" \
      | awk '{print $1+$3 "/" $2+$4}')
    # "stream=false: a/b, stream=true: c/d, blank-line stream=false: e/f, ...":
    # the regular file, then the variant ending in a blank line.
    trailing=$(sed -n 's/^trailing newlines kept exactly (of successful runs): //p' "$result" \
      | grep -o '[0-9]*/[0-9]*' | awk -F/ '{n+=1; if (n <= 2) {a+=$1; b+=$2} else {c+=$1; d+=$2}}
        END {if (n) print a "/" b ", blank-line " c "/" d}')
    retries=$(grep -o '[0-9]* run(s) needed a retry' "$result" | awk '{s+=$1} END {print s+0}')
    printf '%-38s %-11s %-11s %-14s %-34s %s\n' "$model" "${format:--}" "$round" "${rate:--}" "${trailing:--}" "$retries"
  done
} >"$summary"
cat "$summary"
log "results in $RESULTS"
