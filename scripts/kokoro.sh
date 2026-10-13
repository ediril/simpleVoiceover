#!/usr/bin/env bash
set -euo pipefail
container="${KOKORO_CONTAINER:-kokoro}"
port="${KOKORO_PORT:-8880}"
image="${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0}"
wait_seconds="${KOKORO_WAIT_SECONDS:-180}"
kokoro_url="http://localhost:$port"

is_terminal() { [[ -t "$1" && "${TERM:-}" != dumb ]]; }

paint() {
  local stream="$1" style="$2" text="$3"
  if is_terminal "$stream" && [[ -z "${NO_COLOR:-}" ]]; then
    printf '\033[%sm%s\033[0m' "$style" "$text"
  else
    printf '%s' "$text"
  fi
}

report() {
  local stream="$1" style="$2" symbol="$3" text="$4" detail="${5:-}" fix="${6:-}"
  {
    paint "$stream" "$style" "$symbol"
    printf ' %s' "$text"
    if [[ -n "$detail" ]]; then paint "$stream" 2 " · $detail"; fi
    if [[ -n "$fix" ]]; then printf ' → %s' "$fix"; fi
    printf '\n'
  } >&"$stream"
}

ok() { report 1 32 ✓ "$1" "${2:-}"; }
warn() { report 1 33 ! "$1" "" "$2"; }
problem() { report 1 31 ✗ "$1" "" "$2"; }
fail() { report 2 31 ✗ "$1" "" "${2:-}"; exit "${3:-1}"; }
muted() {
  local stream="${2:-1}"
  { paint "$stream" 2 "$1"; printf '\n'; } >&"$stream"
}

docker_installed() { command -v docker >/dev/null 2>&1; }
docker_running() { docker info >/dev/null 2>&1; }
container_state() { docker container inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true; }
image_downloaded() { docker image inspect "$image" >/dev/null 2>&1; }
voices_json() { curl -fsS --max-time 3 "$kokoro_url/v1/audio/voices" 2>/dev/null; }
count_voices() { grep -o '"id"[[:space:]]*:' | wc -l | tr -d '[:space:]'; }
published_addresses() {
  docker container inspect -f '{{range (index .HostConfig.PortBindings "8880/tcp")}}{{.HostIp}}:{{.HostPort}}{{"\n"}}{{end}}' "$container" 2>/dev/null || true
}

check_settings() {
  [[ "$port" =~ ^[0-9]+$ ]] || fail "KOKORO_PORT must be a number, not \"$port\""
  [[ "$wait_seconds" =~ ^[0-9]+$ ]] || fail "KOKORO_WAIT_SECONDS must be a number, not \"$wait_seconds\""
}

require_docker() {
  docker_installed || fail "Docker isn't installed" "install Docker Desktop or Rancher Desktop"
  docker_running || fail "Docker isn't running" "start Docker Desktop or Rancher Desktop"
}

create_container() {
  local run_options=(-d --name "$container" -p "127.0.0.1:$port:8880" --restart unless-stopped)
  case "$image" in *-gpu*) run_options+=(--gpus all) ;; esac
  if ! image_downloaded; then
    printf 'Downloading Kokoro '
    paint 1 2 '(about 1.5 GB, first time only)'
    printf '…\n'
  fi
  docker run "${run_options[@]}" "$image" >/dev/null
}

show_waiting() {
  if is_terminal 1; then
    printf '\r\033[KStarting Kokoro '
    paint 1 2 "· $1s"
  else
    printf '.'
  fi
}

end_waiting() {
  if is_terminal 1; then printf '\r\033[K'; else printf '\n'; fi
}

wait_until_ready() {
  command -v curl >/dev/null 2>&1 || fail "curl isn't installed" "install curl"
  local started=$SECONDS deadline=$((SECONDS + wait_seconds))
  if ! voices_json >/dev/null; then
    printf 'Starting Kokoro'
    until voices_json >/dev/null; do
      case "$(container_state)" in
        exited | dead | restarting)
          end_waiting
          fail "Kokoro stopped while starting" "docker logs $container"
          ;;
      esac
      if ((SECONDS >= deadline)); then
        end_waiting
        fail "Kokoro didn't answer at $kokoro_url within ${wait_seconds}s" "docker logs $container"
      fi
      show_waiting $((SECONDS - started))
      sleep 2
    done
    end_waiting
  fi
  ok "Kokoro ready" "$kokoro_url"
}

start_kokoro() {
  require_docker
  case "$(container_state)" in
    "") create_container ;;
    running) ;;
    *) docker start "$container" >/dev/null ;;
  esac
  wait_until_ready
}

stop_kokoro() {
  docker_installed || { muted "Nothing to stop · Docker isn't installed"; return; }
  docker_running || { muted "Nothing to stop · Docker isn't running"; return; }
  case "$(container_state)" in
    "") muted "Nothing to stop · no Kokoro container" ;;
    running | restarting | paused)
      docker stop "$container" >/dev/null
      ok "Kokoro stopped" "stays off until scripts/kokoro.sh start"
      ;;
    *) ok "Kokoro already stopped" ;;
  esac
}

report_network() {
  local addresses address local_only=yes listed_ports=""
  addresses="$(published_addresses)"
  if [[ -z "$addresses" ]]; then
    warn "Kokoro's port isn't published" "scripts/kokoro.sh reset"
    return
  fi
  while IFS= read -r address; do
    [[ -z "$address" ]] && continue
    listed_ports="$listed_ports ${address##*:}"
    case "$address" in
      127.0.0.1:* | ::1:* | localhost:*) ;;
      *) local_only=no ;;
    esac
  done <<<"$addresses"
  if [[ "$local_only" == no ]]; then
    warn "Reachable from your network" "scripts/kokoro.sh reset"
  fi
  case " $listed_ports " in
    *" $port "*) ;;
    *) warn "Kokoro uses port${listed_ports}, not $port" "scripts/kokoro.sh reset" ;;
  esac
}

report_layers() {
  docker_installed || { problem "Docker isn't installed" "install Docker Desktop or Rancher Desktop"; return 1; }
  docker_running || { problem "Docker isn't running" "start Docker Desktop or Rancher Desktop"; return 1; }
  ok "Docker running"
  case "$(container_state)" in
    "") problem "No Kokoro container" "scripts/kokoro.sh start"; return 1 ;;
    running) ;;
    *) problem "Kokoro stopped" "scripts/kokoro.sh start"; return 1 ;;
  esac
}

status_kokoro() {
  local json="" answering=no layers=ok
  if json="$(voices_json)"; then answering=yes; fi
  report_layers || layers=missing
  if [[ "$answering" == yes ]]; then
    ok "Kokoro running" "$(count_voices <<<"$json") voices · $kokoro_url"
  elif [[ "$layers" == ok ]]; then
    problem "Kokoro isn't answering at $kokoro_url" "scripts/kokoro.sh start"
  fi
  [[ "$layers" == missing ]] || report_network
  [[ "$answering" == yes ]]
}

confirm_change() {
  local answer=""
  read -r -p "$1 [y/N] " answer || { if [[ -t 0 ]]; then printf '\n' >&2; fi; }
  case "$answer" in
    y | Y | yes | Yes | YES) ;;
    *) muted "Nothing changed" 2; exit 1 ;;
  esac
}

remove_container() {
  [[ -n "$(container_state)" ]] || return 0
  docker rm -f "$container" >/dev/null
}

remove_image() {
  image_downloaded || return 0
  docker image rm "$image" >/dev/null || fail "Docker couldn't remove $image" "see Docker's message above"
}

reset_kokoro() {
  case "${1:-}" in
    "" | --yes) ;;
    *) fail "Unknown option $1" "scripts/kokoro.sh reset [--yes]" 2 ;;
  esac
  require_docker
  if [[ "${1:-}" != --yes ]]; then
    if image_downloaded; then
      confirm_change "Recreate the Kokoro container? The download is kept."
    else
      confirm_change "Recreate the Kokoro container? It downloads about 1.5 GB first."
    fi
  fi
  remove_container
  start_kokoro
}

removal_question() {
  local has_container="$1" has_image="$2" include_image="$3"
  if [[ "$has_container" == yes && "$has_image" == yes && "$include_image" == yes ]]; then
    printf 'Remove the Kokoro container and the download (about 1.5 GB)?'
  elif [[ "$has_container" == yes && "$has_image" == yes ]]; then
    printf 'Remove the Kokoro container? The download is kept.'
  elif [[ "$has_container" == yes ]]; then
    printf 'Remove the Kokoro container?'
  else
    printf 'Remove the Kokoro download (about 1.5 GB)?'
  fi
}

remove_kokoro() {
  local include_image=no confirmed=no option has_container=no has_image=no
  for option in "$@"; do
    case "$option" in
      --all) include_image=yes ;;
      --yes) confirmed=yes ;;
      *) fail "Unknown option $option" "scripts/kokoro.sh remove [--all] [--yes]" 2 ;;
    esac
  done
  docker_installed || { muted "Nothing to remove · Docker isn't installed"; return; }
  docker_running || fail "Docker isn't running" "start Docker Desktop or Rancher Desktop"
  if [[ -n "$(container_state)" ]]; then has_container=yes; fi
  if image_downloaded; then has_image=yes; fi
  if [[ "$has_container" == no && "$include_image" == no ]]; then
    muted "Nothing to remove · no Kokoro container"
    return
  fi
  if [[ "$has_container" == no && "$has_image" == no ]]; then
    muted "Nothing to remove · no Kokoro container or download"
    return
  fi
  [[ "$confirmed" == yes ]] || confirm_change "$(removal_question "$has_container" "$has_image" "$include_image")"
  remove_container
  [[ "$include_image" == no ]] || remove_image
  ok "Removed"
}

show_help() {
  printf '%s\n' \
    'Runs Kokoro, the local voice server for AI voiceover, in Docker.' \
    'Usage: scripts/kokoro.sh <command>' \
    '  start                 Start Kokoro and wait until it answers' \
    '  stop                  Stop Kokoro; it stays installed' \
    '  status                Check Docker and Kokoro' \
    '  reset [--yes]         Recreate the container; the download is kept' \
    '  remove [--yes]        Remove the container; the download is kept' \
    '  remove --all [--yes]  Also remove the download (about 1.5 GB)' \
    '  help                  Show this help' \
    'Environment:'
  show_setting KOKORO_CONTAINER 'Container name' kokoro
  show_setting KOKORO_PORT 'Port on this computer' 8880
  show_setting KOKORO_IMAGE 'Docker image; -gpu in the name adds --gpus all' ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0
  show_setting KOKORO_WAIT_SECONDS 'Seconds start waits for Kokoro' 180
}

show_setting() {
  printf '  %-21s %s ' "$1" "$2"
  paint 1 2 "($3)"
  printf '\n'
}

check_settings
case "${1:-help}" in
  start) start_kokoro ;;
  stop) stop_kokoro ;;
  status) status_kokoro ;;
  reset) reset_kokoro "${2:-}" ;;
  remove) remove_kokoro "${@:2}" ;;
  help) show_help ;;
  *) fail "Unknown command $1" "scripts/kokoro.sh help" 2 ;;
esac
