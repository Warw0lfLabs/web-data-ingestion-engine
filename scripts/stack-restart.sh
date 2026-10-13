#!/usr/bin/env bash
set -euo pipefail

# Resolve from this file, not the operator's current working directory.
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$project_dir"

fail() {
  printf 'Stack workflow failed: %s\n' "$1" >&2
  printf 'Inspect docker compose ps -a and service logs for this project; data volumes were not removed.\n' >&2
  exit 1
}

if [[ $# -ne 0 ]]; then
  fail 'No arguments accepted. Use COMPOSE_PROJECT_NAME and COMPOSE_FILE for an alternate project.'
fi
command -v docker >/dev/null 2>&1 || fail 'Docker is unavailable; install Docker and start its daemon.'
command -v node >/dev/null 2>&1 || fail 'Node.js is unavailable; use the documented project prerequisite.'
# Pin both identity and files with CLI flags so implicit .env/default overrides
# cannot silently redirect a mutation. Alternate targets require an exact opt-in.
if ! target=$(node -e '
  const fs = require("node:fs"), path = require("node:path");
  try {
    const root = process.cwd(), normal = "web-data-ingestion-engine";
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("COMPOSE_") && !["COMPOSE_PROJECT_NAME", "COMPOSE_FILE"].includes(key)) throw new Error();
    }
    if (fs.existsSync(".env") && /^\s*(?:export\s+)?COMPOSE_[A-Z0-9_]+\s*(?:=|:\s)/m.test(fs.readFileSync(".env", "utf8"))) throw new Error();
    const name = process.env.COMPOSE_PROJECT_NAME ?? normal;
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error();
    const standard = fs.realpathSync(path.join(root, "compose.yaml"));
    const raw = process.env.COMPOSE_FILE;
    const files = raw === undefined ? [standard] : raw.split(":").map(file => {
      if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file) || file.length > 2048) throw new Error();
      const resolved = fs.realpathSync(file);
      if (!fs.statSync(resolved).isFile() || !/\.ya?ml$/i.test(resolved)) throw new Error();
      fs.accessSync(resolved, fs.constants.R_OK);
      return resolved;
    });
    if (!files.length || files.length > 10 || new Set(files).size !== files.length || files.some(f => /[\x00-\x1f\x7f]/.test(f))) throw new Error();
    const alternate = name !== normal || files.length !== 1 || files[0] !== standard;
    if (alternate && process.env.INGESTION_STACK_ALLOW_ALTERNATE_TARGET !== "1") {
      console.error("Alternate target requires INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 before any services are stopped.");
      process.exit(1);
    }
    console.log([name, ...files].join("\n"));
  } catch {
    console.error("Invalid or ambiguous Compose target: use a valid project name and distinct readable absolute YAML files; other COMPOSE_* controls and Compose target settings in .env are unsupported.");
    process.exit(1);
  }
'); then
  fail 'Target preflight rejected the selection; no services were stopped.'
fi
IFS= read -r target_project <<< "$target"
compose_args=(compose --project-directory "$project_dir" -p "$target_project")
while IFS= read -r file; do
  [[ "$file" == "$target_project" ]] && continue
  compose_args+=(-f "$file")
done <<< "$target"
compose() { docker "${compose_args[@]}" "$@"; }
printf 'Effective Compose project: %s\nCompose files:\n' "$target_project"
for ((i=0; i<${#compose_args[@]}; i++)); do
  if [[ "${compose_args[$i]}" == "-f" ]]; then
    printf '  %s\n' "${compose_args[$((i+1))]}"
  fi
done
docker compose version >/dev/null 2>&1 || fail 'Docker Compose is unavailable.'
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || fail 'Docker daemon is unavailable or access is denied.'
compose config --quiet >/dev/null 2>&1 || fail 'Invalid Compose configuration; no services were stopped.'

# Config can contain credentials. Parse it in memory; never print it or raw errors.
if ! services=$(compose config --format json 2>/dev/null | node -e '
  const fs = require("node:fs");
  try {
    const {name, services} = JSON.parse(fs.readFileSync(0, "utf8"));
    if (name !== process.argv[1]) throw new Error();
    if (!services || !services.migrate) throw new Error();
    // These mandatory gates are the V1 lifecycle contract, including for
    // explicitly acknowledged alternate configurations. Omitted required
    // means true in Compose; optional dependencies cannot satisfy a gate.
    const gates = [
      ["migrate", "postgres", "service_healthy"],
      ["api", "migrate", "service_completed_successfully"],
      ["worker", "migrate", "service_completed_successfully"],
      ["worker", "fixture-server", "service_healthy"],
      ["worker", "browser", "service_healthy"],
    ];
    for (const [service, dependency, condition] of gates) {
      const dependencies = services[service]?.depends_on;
      const gate = dependencies?.[dependency];
      if (!services[dependency] || !dependencies || Array.isArray(dependencies) ||
          !gate || typeof gate !== "object" || Array.isArray(gate) ||
          gate.condition !== condition ||
          (gate.required !== undefined && gate.required !== true)) throw new Error();
    }
    for (const [name, service] of Object.entries(services)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error();
      if (service.profiles?.length) throw new Error();
      if (name !== "migrate" && (!service.healthcheck?.test || service.healthcheck.disable || service.healthcheck.test[0] === "NONE")) throw new Error();
    }
    console.log(["migrate", ...Object.keys(services).filter(n => n !== "migrate")].join("\n"));
  } catch { process.exit(1); }
' "$target_project"); then
  fail 'Unsupported Compose service configuration; require V1 mandatory dependency gates, migrate, and health checks on all long-running services, without profiles.'
fi

printf 'Stopping stack; retaining persistent volumes.\n'
compose stop >/dev/null 2>&1 || fail 'Compose stop failed; startup was not attempted.'
printf 'Starting stack through dependency and readiness gates.\n'
up_failed=0
compose up -d --wait >/dev/null 2>&1 || up_failed=1

while IFS= read -r service; do
  if ! container_id=$(compose ps --all --quiet "$service" 2>/dev/null); then
    fail "Could not locate container for service $service."
  fi
  [[ -n "$container_id" ]] || fail "Missing required service $service."
  [[ "$container_id" =~ ^[a-f0-9]{12,64}$ ]] || fail "Expected exactly one container for service $service (V1)."
  if ! state=$(docker inspect --format '{{json .State}}' "$container_id" 2>/dev/null); then
    fail "Could not inspect service $service."
  fi
  if ! printf '%s' "$state" | node -e '
    const fs = require("node:fs");
    const service = process.argv[1];
    try {
      const s = JSON.parse(fs.readFileSync(0, "utf8"));
      const ok = service === "migrate"
        ? s.Status === "exited" && s.Running === false && s.ExitCode === 0
        : s.Status === "running" && s.Running === true && s.Health?.Status === "healthy";
      if (!ok) {
        const safe = value => String(value ?? "missing").replace(/[^a-zA-Z0-9_-]/g, "?").slice(0, 32);
        console.error(`Service ${service}: state=${safe(s.Status)}, exit=${safe(s.ExitCode)}, health=${safe(s.Health?.Status)}; verification failed.`);
        process.exit(1);
      }
    } catch { console.error(`Service ${service}: invalid inspection response.`); process.exit(1); }
  ' "$service"; then
    fail "Service $service did not reach its required state; stack may be partially started."
  fi
done <<< "$services"

[[ "$up_failed" -eq 0 ]] || fail 'Compose up failed even though subsequent state checks passed; inspect project logs.'
printf 'Stack verified: migrate exited 0; all required long-running services are running and healthy.\n'
