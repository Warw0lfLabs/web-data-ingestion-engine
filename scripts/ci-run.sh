#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$root"
[[ $# -eq 1 ]] || { printf 'Usage: bash scripts/ci-run.sh ARTIFACT_DIRECTORY\n' >&2; exit 1; }
mkdir -p -- "$1"
output=$(cd -- "$1" && pwd -P)
# Selection is generated internally; no caller-supplied application project name.
project="ingestion-ci-$(date +%s)-$$"
for key in ${!COMPOSE_@}; do unset "$key"; done
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || exit 1
[[ -z $(docker network ls -q --filter "label=com.docker.compose.project=$project") ]] || exit 1
[[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] || exit 1
[[ -z $(docker ps -aq --filter "name=^/${project}-tests-run$") ]] || exit 1
[[ -z $(docker image ls -q "${project}-tests") ]] || exit 1
profile=$(mktemp)
export CI_SECCOMP_FILE="$profile"
container="${project}-tests-run"
compose() { docker compose --project-directory "$root" -p "$project" -f "$root/compose.ci.yaml" "$@"; }
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if docker container inspect "$container" >/dev/null 2>&1; then
    if [[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container") == "$project" ]]; then
      docker cp "$container:/app/test-logs/." "$output/" || status=1
      docker rm -f "$container" || status=1
    else
      printf 'Refusing cleanup of a container with unexpected project ownership.\n' >&2
      status=1
    fi
  fi
  compose down --volumes || status=1
  if docker image inspect "${project}-tests" >/dev/null 2>&1; then
    docker image rm "${project}-tests" || status=1
  fi
  rm -f -- "$profile"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node scripts/ci-seccomp.mjs > "$profile"
compose config --quiet
printf 'Disposable CI project: %s\n' "$project"
compose build tests
compose up -d --wait --wait-timeout 90 postgres
compose run --name "$container" --no-deps -T tests
