#!/usr/bin/env bash
set -euo pipefail
container="${KOKORO_CONTAINER:-kokoro}"
port="${KOKORO_PORT:-8880}"
image="${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0}"
wait_seconds="${KOKORO_WAIT_SECONDS:-180}"
kokoro_url="http://localhost:$port"

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

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
  [[ "$port" =~ ^[0-9]+$ ]] || fail "KOKORO_PORT must be a number, not \"$port\"."
  [[ "$wait_seconds" =~ ^[0-9]+$ ]] || fail "KOKORO_WAIT_SECONDS must be a number, not \"$wait_seconds\"."
}

require_docker() {
  docker_installed || fail "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Rancher Desktop (https://rancherdesktop.io/), then run this again."
  docker_running || fail "Docker is installed but not running. Start Docker Desktop or Rancher Desktop, then run this again."
}

create_container() {
  local run_options=(-d --name "$container" -p "127.0.0.1:$port:8880" --restart unless-stopped)
  case "$image" in *-gpu*) run_options+=(--gpus all) ;; esac
  if image_downloaded; then
    say "Creating the Kokoro container \"$container\"."
  else
    say "Setting up Kokoro for the first time. This downloads about 1.5 GB and can take several minutes."
  fi
  docker run "${run_options[@]}" "$image" >/dev/null
}

wait_until_ready() {
  command -v curl >/dev/null 2>&1 || fail "curl is not installed, so this script cannot check whether Kokoro answers. Install curl, then run: scripts/kokoro.sh status"
  local deadline=$((SECONDS + wait_seconds))
  if ! voices_json >/dev/null; then
    printf 'Waiting for Kokoro to answer'
    until voices_json >/dev/null; do
      case "$(container_state)" in
        exited | dead | restarting)
          printf '\n'
          fail "Kokoro stopped unexpectedly while starting. See what went wrong with: docker logs $container"
          ;;
      esac
      if ((SECONDS >= deadline)); then
        printf '\n'
        fail "Kokoro did not answer at $kokoro_url within $wait_seconds seconds. Check the setup with: scripts/kokoro.sh status
See what Kokoro reports with: docker logs $container"
      fi
      printf '.'
      sleep 2
    done
    printf '\n'
  fi
  say "Kokoro is ready at $kokoro_url"
}

start_kokoro() {
  require_docker
  case "$(container_state)" in
    "") create_container ;;
    running) say "Kokoro is already running." ;;
    *) say "Starting Kokoro."; docker start "$container" >/dev/null ;;
  esac
  wait_until_ready
}

stop_kokoro() {
  docker_installed || { say "Docker is not installed, so Kokoro is not running."; return; }
  docker_running || { say "Docker is not running, so Kokoro is not running either."; return; }
  case "$(container_state)" in
    "") say "There is no Kokoro container named \"$container\". Nothing to stop." ;;
    running|restarting|paused)
      docker stop "$container" >/dev/null
      say "Kokoro stopped. It stays stopped until you run: scripts/kokoro.sh start"
      ;;
    *) say "Kokoro is already stopped." ;;
  esac
}

report_network() {
  local addresses address local_only=yes listed_ports=""
  addresses="$(published_addresses)"
  if [[ -z "$addresses" ]]; then
    say "Network: Kokoro's port is not published, so the app cannot reach it. Fix it with: scripts/kokoro.sh reset"
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
  if [[ "$local_only" == yes ]]; then
    say "Network: only this computer can reach Kokoro."
  else
    say "Network: warning, Kokoro listens on all network interfaces, so other computers on your network can reach it. Limit it to this computer with: scripts/kokoro.sh reset"
  fi
  case " $listed_ports " in
    *" $port "*) ;;
    *) say "Port: Kokoro is published on port${listed_ports}, but this script checks port $port. Set KOKORO_PORT or run: scripts/kokoro.sh reset" ;;
  esac
}

report_docker_and_container() {
  if ! docker_installed; then
    say "Docker: not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Rancher Desktop (https://rancherdesktop.io/)."
    return
  fi
  say "Docker: installed."
  if ! docker_running; then
    say "Docker: not running. Start Docker Desktop or Rancher Desktop."
    return
  fi
  say "Docker: running."
  local state
  state="$(container_state)"
  case "$state" in
    "") say "Container: there is no Kokoro container named \"$container\". Create it with: scripts/kokoro.sh start"; return ;;
    running) say "Container: \"$container\" exists and is running." ;;
    *) say "Container: \"$container\" exists but is stopped. Start it with: scripts/kokoro.sh start" ;;
  esac
  report_network
}

status_kokoro() {
  report_docker_and_container
  local json
  if json="$(voices_json)"; then
    say "Kokoro: answering at $kokoro_url with $(count_voices <<<"$json") voices."
  else
    say "Kokoro: not answering at $kokoro_url."
    return 1
  fi
}

confirm_change() {
  local answer=""
  read -r -p "Continue? [y/N] " answer || true
  case "$answer" in
    y | Y | yes | Yes | YES) ;;
    *) fail "Nothing changed." ;;
  esac
}

remove_container() {
  [[ -n "$(container_state)" ]] || return 0
  docker rm -f "$container" >/dev/null
  say "Removed the Kokoro container \"$container\"."
}

remove_image() {
  image_downloaded || return 0
  docker image rm "$image" >/dev/null || fail "Docker could not remove the image $image. See the message above."
  say "Removed the Kokoro image $image."
}

reset_kokoro() {
  case "${1:-}" in
    "" | --yes) ;;
    *) printf 'Unknown option: %s\nUse: scripts/kokoro.sh reset [--yes]\n' "$1" >&2; exit 2 ;;
  esac
  require_docker
  say "Reset removes the Kokoro container \"$container\" and creates it again, reachable only from this computer on port $port."
  if image_downloaded; then
    say "The downloaded Kokoro image is kept, so nothing is downloaded again."
  else
    say "The image $image is not downloaded yet, so Kokoro downloads it first."
  fi
  [[ "${1:-}" == --yes ]] || confirm_change
  remove_container
  start_kokoro
}

describe_removal() {
  local include_image="$1"
  if [[ -z "$(container_state)" ]]; then
    say "There is no Kokoro container named \"$container\"."
  elif [[ "$include_image" == yes ]]; then
    say "This removes the Kokoro container \"$container\"."
  elif image_downloaded; then
    say "This removes the Kokoro container \"$container\". The next start creates it again without downloading."
    say "The downloaded Kokoro image is kept. To remove it too, run: scripts/kokoro.sh remove --all"
  else
    say "This removes the Kokoro container \"$container\". The image $image is not downloaded, so the next start downloads it first."
  fi
  [[ "$include_image" == yes ]] || return 0
  if image_downloaded; then
    say "This removes the downloaded Kokoro image $image to free about 1.5 GB. The next start downloads it again."
  else
    say "The Kokoro image $image is not downloaded, so there is no image to remove."
  fi
}

something_to_remove() {
  [[ -n "$(container_state)" ]] || { [[ "$1" == yes ]] && image_downloaded; }
}

remove_kokoro() {
  local include_image=no confirmed=no option
  for option in "$@"; do
    case "$option" in
      --all) include_image=yes ;;
      --yes) confirmed=yes ;;
      *) printf 'Unknown option: %s\nUse: scripts/kokoro.sh remove [--all] [--yes]\n' "$option" >&2; exit 2 ;;
    esac
  done
  docker_installed || { say "Docker is not installed, so there is no Kokoro container or image to remove."; return; }
  docker_running || fail "Docker is not running, so nothing was removed. Start Docker Desktop or Rancher Desktop, then run this again."
  describe_removal "$include_image"
  if ! something_to_remove "$include_image"; then
    say "Nothing to remove."
    return
  fi
  [[ "$confirmed" == yes ]] || confirm_change
  remove_container
  [[ "$include_image" == no ]] || remove_image
}

show_help() {
  printf '%s\n' \
    'kokoro <start|stop|status|reset|remove|help>' \
    '' \
    'Runs Kokoro, the local voice server for AI voiceover, in Docker.' \
    '  start                 Create or start Kokoro and wait until it answers' \
    '  stop                  Stop Kokoro; it stays installed' \
    '  status                Show whether Docker and Kokoro are running' \
    '  reset [--yes]         Remove and recreate the Kokoro container; no new download' \
    '  remove [--yes]        Remove the Kokoro container; the downloaded image stays' \
    '  remove --all [--yes]  Also remove the downloaded image (about 1.5 GB) to uninstall Kokoro' \
    '  help                  Show this help' \
    '' \
    'Settings (environment variables):' \
    '  KOKORO_CONTAINER     Container name (default kokoro)' \
    '  KOKORO_PORT          Port on this computer (default 8880)' \
    '  KOKORO_IMAGE         Docker image (default ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0)' \
    '                       An image with -gpu in its name also gets --gpus all' \
    '  KOKORO_WAIT_SECONDS  How long start waits for Kokoro (default 180)'
}

check_settings
case "${1:-help}" in
  start) start_kokoro ;;
  stop) stop_kokoro ;;
  status) status_kokoro ;;
  reset) reset_kokoro "${2:-}" ;;
  remove) remove_kokoro "${@:2}" ;;
  help) show_help ;;
  *) printf 'Unknown command: %s\nUse: scripts/kokoro.sh help\n' "$1" >&2; exit 2 ;;
esac
