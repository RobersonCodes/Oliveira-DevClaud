#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${PRODUCTION_SMOKE_ALLOW:-}" != "1" ]]; then
  echo "Refusing to run: set PRODUCTION_SMOKE_ALLOW=1 on an isolated Linux host." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

project_name="odc-clean-host-${GITHUB_RUN_ID:-manual}"
compose=(docker compose --project-name "$project_name" --env-file .env.production -f infra/production/docker-compose.prod.yml)
workspace_root="/var/lib/oliveira-devcloud/workspaces"
backup_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/odc-smoke-backup.XXXXXX")"
restore_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/odc-smoke-restore.XXXXXX")"
evidence_root="${RUNNER_TEMP:-/tmp}/odc-smoke-evidence"
api_url="http://127.0.0.1:18081"
workspace_id=""
container_id=""
cookie=""

cleanup() {
  set +e
  if [[ -n "$workspace_id" && -n "$cookie" ]]; then
    curl --silent --show-error -X DELETE -H "Cookie: $cookie" \
      "$api_url/api/v1/workspaces/$workspace_id" >/dev/null
  fi
  "${compose[@]}" down -v --remove-orphans
}
trap cleanup EXIT

set_env() {
  local key="$1"
  local value="$2"
  grep -q "^${key}=" .env.production
  sed -i "s|^${key}=.*$|${key}=${value}|" .env.production
}

wait_for_ready() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl --fail --silent "$api_url/ready" >/dev/null; then
      return 0
    fi
    sleep 5
  done
  echo "API did not become ready within 300 seconds." >&2
  "${compose[@]}" ps >&2
  "${compose[@]}" logs --no-color migrate runtime-broker api >&2
  return 1
}

service_started_at() {
  local service="$1"
  local container
  container="$("${compose[@]}" ps -q "$service")"
  test -n "$container"
  docker inspect "$container" --format '{{.State.StartedAt}}'
}

wait_for_redis() {
  local attempt
  for attempt in $(seq 1 60); do
    if "${compose[@]}" exec -T redis redis-cli ping 2>/dev/null | grep -Fx PONG >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Redis did not become ready within 120 seconds." >&2
  "${compose[@]}" logs --no-color redis >&2
  return 1
}

wait_for_setup_stage() {
  local job_id="$1"
  local expected_stage="$2"
  local attempt response status stage
  for attempt in $(seq 1 120); do
    response="$(curl --max-time 5 --silent --show-error -H "Cookie: $cookie" \
      "$api_url/api/v1/setup/jobs/$job_id" 2>/dev/null || true)"
    status="$(jq -r '.status // empty' <<<"$response")"
    stage="$(jq -r '.stage // empty' <<<"$response")"
    if [[ "$status" == "RUNNING" && "$stage" == "$expected_stage" ]]; then
      return 0
    fi
    if [[ "$status" == "CANCELLED" ]]; then
      echo "Setup job $job_id was cancelled before reaching $expected_stage." >&2
      return 1
    fi
    sleep 1
  done
  echo "Setup job $job_id did not reach RUNNING/$expected_stage within 120 seconds." >&2
  "${compose[@]}" logs --no-color worker runtime-broker >&2
  return 1
}

wait_for_setup_ready() {
  local job_id="$1"
  local attempt response status
  for attempt in $(seq 1 180); do
    response="$(curl --max-time 5 --silent --show-error -H "Cookie: $cookie" \
      "$api_url/api/v1/setup/jobs/$job_id" 2>/dev/null || true)"
    status="$(jq -r '.status // empty' <<<"$response")"
    if [[ "$status" == "READY" ]]; then
      return 0
    fi
    if [[ "$status" == "CANCELLED" ]]; then
      echo "Setup job $job_id was cancelled instead of recovering." >&2
      return 1
    fi
    sleep 1
  done
  echo "Setup job $job_id did not recover to READY within 180 seconds." >&2
  curl --silent --show-error -H "Cookie: $cookie" "$api_url/api/v1/setup/jobs/$job_id" >&2 || true
  "${compose[@]}" logs --no-color worker runtime-broker redis >&2
  return 1
}

enqueue_setup() {
  local payload="$1"
  curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
    -H 'content-type: application/json' -X POST -d "$payload" \
    "$api_url/api/v1/setup/$workspace_id/provision" | jq -er '.id'
}

mkdir -p "$evidence_root"
sudo install -d -o 10001 -g 10001 -m 0750 "$workspace_root"

cp .env.production.example .env.production
set_env POSTGRES_PASSWORD ci-only-postgres-password
set_env DATABASE_URL 'postgresql://oliveira:ci-only-postgres-password@postgres:5432/devcloud?schema=public'
set_env RUNTIME_TICKET_SECRET 0123456789abcdef0123456789abcdef
set_env SECRETS_MASTER_KEY_BASE64 MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
set_env RUNTIME_BROKER_TOKEN abcdef0123456789abcdef0123456789
set_env DOCKER_GID "$(stat -c '%g' /var/run/docker.sock)"

# Create only the data-service containers first so Compose materializes its private network. The
# host nginx reaches the published API through this network's gateway; trust exactly that /32,
# never every private address or an arbitrary hop count.
"${compose[@]}" create postgres redis
network_id="$(docker network ls \
  --filter "label=com.docker.compose.project=$project_name" \
  --filter 'label=com.docker.compose.network=default' \
  --format '{{.ID}}' | head -n 1)"
test -n "$network_id"
trusted_proxy="$(docker network inspect "$network_id" --format '{{(index .IPAM.Config 0).Gateway}}')/32"
set_env TRUSTED_PROXY_CIDRS "$trusted_proxy"

workspace_image="$(grep '^WORKSPACE_IMAGE=' .env.production | cut -d= -f2-)"
echo "Pulling immutable workspace image: $workspace_image"
docker pull "$workspace_image"
docker image inspect "$workspace_image" --format '{{json .RepoDigests}}'

"${compose[@]}" config --quiet
"${compose[@]}" build
"${compose[@]}" up -d
wait_for_ready

migrate_id="$("${compose[@]}" ps -a -q migrate)"
test -n "$migrate_id"
test "$(docker inspect "$migrate_id" --format '{{.State.ExitCode}}')" = "0"
curl --fail --silent "$api_url/health" >/dev/null
curl --fail --silent "$api_url/ready" >/dev/null

headers_file="$(mktemp)"
register_body="$(jq -nc --arg email "clean-host-${GITHUB_RUN_ID:-manual}@example.test" \
  '{email:$email,password:"Correct-Horse-Battery-9",name:"Clean Host User"}')"
register_response="$(curl --fail-with-body --silent --show-error -D "$headers_file" \
  -H 'content-type: application/json' -H 'X-Forwarded-For: 198.51.100.20' \
  -X POST -d "$register_body" "$api_url/api/v1/auth/register")"
user_id="$(jq -er '.id' <<<"$register_response")"
cookie="$(awk -F': ' 'tolower($1) == "set-cookie" { split($2, parts, ";"); gsub("\r", "", parts[1]); print parts[1]; exit }' "$headers_file")"
rm -f "$headers_file"
test -n "$cookie"

audit_ip="$("${compose[@]}" exec -T postgres psql -U oliveira -d devcloud -tAc \
  "SELECT \"ipAddress\" FROM \"AuditLog\" WHERE \"userId\" = '$user_id' AND action = 'USER_REGISTERED' ORDER BY \"createdAt\" DESC LIMIT 1")"
test "$(tr -d '[:space:]' <<<"$audit_ip")" = "198.51.100.20"

organizations="$(curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  "$api_url/api/v1/organizations")"
organization_id="$(jq -er '.[0].id' <<<"$organizations")"
project_body="$(jq -nc --arg organizationId "$organization_id" \
  '{organizationId:$organizationId,name:"Clean Host Project"}')"
project="$(curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  -H 'content-type: application/json' -X POST -d "$project_body" \
  "$api_url/api/v1/projects")"
project_id="$(jq -er '.id' <<<"$project")"

workspace_body="$(jq -nc --arg projectId "$project_id" \
  '{projectId:$projectId,cpuLimit:0.5,memoryMb:512}')"
workspace="$(curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  -H 'content-type: application/json' -X POST -d "$workspace_body" \
  "$api_url/api/v1/workspaces")"
workspace_id="$(jq -er '.id' <<<"$workspace")"
container_id="$(jq -er '.containerId' <<<"$workspace")"
test "$(docker exec "$container_id" id -u)" = "10001"

terminal_body="$(jq -nc --arg workspaceId "$workspace_id" \
  '{workspaceId:$workspaceId,title:"Clean host terminal"}')"
terminal="$(curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  -H 'content-type: application/json' -X POST -d "$terminal_body" \
  "$api_url/api/v1/terminals")"
terminal_id="$(jq -er '.id' <<<"$terminal")"

marker="ODC_CLEAN_HOST_${GITHUB_RUN_ID:-manual}"
printf '%s\n' "$marker" | docker exec -i "$container_id" \
  sh -c 'cat > /workspace/.odc-persistence-smoke'
marker_checksum="$(docker exec "$container_id" sha256sum /workspace/.odc-persistence-smoke | awk '{print $1}')"
"${compose[@]}" exec -T redis redis-cli SET odc:clean-host-smoke "$marker" | grep -Fx OK

"${compose[@]}" restart postgres redis
for attempt in $(seq 1 30); do
  if "${compose[@]}" exec -T postgres pg_isready -U oliveira -d devcloud >/dev/null 2>&1 && \
     "${compose[@]}" exec -T redis redis-cli ping | grep -Fx PONG >/dev/null; then
    break
  fi
  sleep 3
done
"${compose[@]}" exec -T postgres pg_isready -U oliveira -d devcloud
"${compose[@]}" exec -T redis redis-cli ping | grep -Fx PONG

"${compose[@]}" restart runtime-broker api worker web
wait_for_ready
curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  "$api_url/api/v1/projects/$project_id" | jq -e --arg id "$project_id" '.id == $id' >/dev/null
curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  "$api_url/api/v1/workspaces/$workspace_id" | jq -e '.runtime.running == true' >/dev/null
test "$(docker exec "$container_id" sha256sum /workspace/.odc-persistence-smoke | awk '{print $1}')" = "$marker_checksum"
test "$("${compose[@]}" exec -T redis redis-cli GET odc:clean-host-smoke | tr -d '\r')" = "$marker"

curl --fail-with-body --silent --show-error -H "Cookie: $cookie" -X POST \
  "$api_url/api/v1/workspaces/$workspace_id/restart" | jq -e '.status == "RUNNING"' >/dev/null
test "$(docker exec "$container_id" sha256sum /workspace/.odc-persistence-smoke | awk '{print $1}')" = "$marker_checksum"

# Fault injection 1/4: keep authenticated reads in flight while the API process restarts. The
# container start timestamp proves that a restart happened; a post-restart read with the original
# cookie proves that session and tenant state survived it.
api_started_before="$(service_started_at api)"
api_probe_file="$(mktemp)"
(
  for attempt in $(seq 1 120); do
    curl --max-time 2 --silent --output /dev/null --write-out '%{http_code}\n' \
      -H "Cookie: $cookie" "$api_url/api/v1/projects/$project_id" || printf '000\n'
    sleep 0.25
  done
) >"$api_probe_file" &
api_probe_pid=$!
"${compose[@]}" restart api
wait_for_ready
curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  "$api_url/api/v1/projects/$project_id" | jq -e --arg id "$project_id" '.id == $id' >/dev/null
kill "$api_probe_pid" 2>/dev/null || true
wait "$api_probe_pid" 2>/dev/null || true
api_started_after="$(service_started_at api)"
test "$api_started_before" != "$api_started_after"
grep -Fx 200 "$api_probe_file" >/dev/null
rm -f "$api_probe_file"

# Fault injection 2/4: enqueue real work with the worker stopped, restart Redis while the BullMQ
# job is waiting, then start the worker and require the persisted job to reach READY.
"${compose[@]}" stop worker
redis_setup_id="$(enqueue_setup '{"clone":false,"install":false,"startIde":false,"registerPorts":false,"maxDurationSeconds":300}')"
curl --fail-with-body --silent --show-error -H "Cookie: $cookie" \
  "$api_url/api/v1/setup/jobs/$redis_setup_id" | jq -e '.status == "QUEUED"' >/dev/null
redis_started_before="$(service_started_at redis)"
"${compose[@]}" restart redis
wait_for_redis
redis_started_after="$(service_started_at redis)"
test "$redis_started_before" != "$redis_started_after"
"${compose[@]}" start worker
wait_for_ready
wait_for_setup_ready "$redis_setup_id"

# Give the next two jobs a deterministic blocking install stage. Removing the hold file makes the
# same operation immediately retryable without an external repository or package registry.
docker exec "$container_id" sh -lc \
  'printf %s '\''{"name":"odc-fault-injection","version":"1.0.0","scripts":{"preinstall":"while [ -f .odc-hold-setup ]; do sleep 1; done"}}'\'' > /workspace/repository/package.json'

# Fault injection 3/4: restart the Runtime Broker while it owns an exec request. Docker keeps the
# workspace itself alive; the setup retry must reconnect to the broker and finish after recovery.
docker exec "$container_id" touch /workspace/repository/.odc-hold-setup
broker_setup_id="$(enqueue_setup '{"clone":false,"install":true,"startIde":false,"registerPorts":false,"maxDurationSeconds":300}')"
wait_for_setup_stage "$broker_setup_id" INSTALLING_DEPS
broker_started_before="$(service_started_at runtime-broker)"
"${compose[@]}" restart runtime-broker
docker exec "$container_id" rm -f /workspace/repository/.odc-hold-setup
wait_for_ready
broker_started_after="$(service_started_at runtime-broker)"
test "$broker_started_before" != "$broker_started_after"
test "$(docker inspect "$container_id" --format '{{.State.Running}}')" = "true"
wait_for_setup_ready "$broker_setup_id"

# Fault injection 4/4: SIGKILL the worker in the middle of an install, age the persisted heartbeat
# to model the documented 60-second stale lease, and prove startup recovery reclaims the real job.
docker exec "$container_id" touch /workspace/repository/.odc-hold-setup
worker_setup_id="$(enqueue_setup '{"clone":false,"install":true,"startIde":false,"registerPorts":false,"maxDurationSeconds":300}')"
wait_for_setup_stage "$worker_setup_id" INSTALLING_DEPS
worker_started_before="$(service_started_at worker)"
"${compose[@]}" kill -s SIGKILL worker
test "$(docker inspect "$("${compose[@]}" ps -a -q worker)" --format '{{.State.Running}}')" = "false"
docker exec "$container_id" rm -f /workspace/repository/.odc-hold-setup
updated_setup_jobs="$("${compose[@]}" exec -T postgres psql -U oliveira -d devcloud -tAc \
  "WITH updated AS (UPDATE \"SetupJob\" SET \"heartbeatAt\" = NOW() - INTERVAL '2 minutes' WHERE id = '$worker_setup_id' AND status = 'RUNNING' RETURNING id) SELECT count(*) FROM updated")"
test "$(tr -d '[:space:]' <<<"$updated_setup_jobs")" = "1"
"${compose[@]}" start worker
worker_started_after="$(service_started_at worker)"
test "$worker_started_before" != "$worker_started_after"
wait_for_setup_ready "$worker_setup_id"
"${compose[@]}" exec -T postgres psql -U oliveira -d devcloud -tAc \
  "SELECT count(*) FROM \"SetupJobLog\" WHERE \"setupJobId\" = '$worker_setup_id' AND message LIKE 'Worker detectou execu%job reenfileirado'" \
  | tr -d '[:space:]' | grep -Fx 1 >/dev/null

"${compose[@]}" exec -T postgres pg_dump -U oliveira -d devcloud -Fc > "$backup_root/devcloud.dump"
sudo tar -C /var/lib/oliveira-devcloud -czf - workspaces > "$backup_root/workspaces.tar.gz"
sha256sum "$backup_root/devcloud.dump" "$backup_root/workspaces.tar.gz" | tee "$evidence_root/backup-sha256.txt"

"${compose[@]}" exec -T postgres createdb -U oliveira devcloud_restore
"${compose[@]}" exec -T postgres pg_restore -U oliveira -d devcloud_restore \
  --no-owner --no-privileges < "$backup_root/devcloud.dump"
restored_projects="$("${compose[@]}" exec -T postgres psql -U oliveira -d devcloud_restore -tAc \
  "SELECT count(*) FROM \"Project\" WHERE id = '$project_id'")"
test "$(tr -d '[:space:]' <<<"$restored_projects")" = "1"

sudo tar -C "$restore_root" -xzf "$backup_root/workspaces.tar.gz"
restored_checksum="$(sudo sha256sum "$restore_root/workspaces/$workspace_id/.odc-persistence-smoke" | awk '{print $1}')"
test "$restored_checksum" = "$marker_checksum"

curl --fail-with-body --silent --show-error -H "Cookie: $cookie" -X DELETE \
  "$api_url/api/v1/terminals/$terminal_id" >/dev/null
curl --fail-with-body --silent --show-error -H "Cookie: $cookie" -X DELETE \
  "$api_url/api/v1/workspaces/$workspace_id" >/dev/null
workspace_id=""
container_id=""

cat > "$evidence_root/summary.txt" <<EOF
clean_host=ubuntu-latest
workspace_image=$workspace_image
workspace_user=10001
trusted_proxy=$trusted_proxy
forwarded_client_ip=198.51.100.20
migrations=passed
readiness=passed
user_project_workspace_terminal=passed
postgres_restart=passed
redis_aof_restart=passed
workspace_bind_restart=passed
api_restart_during_authenticated_reads=passed
redis_restart_with_queued_setup=passed
runtime_broker_restart_during_setup=passed
worker_sigkill_setup_recovery=passed
postgres_isolated_restore=passed
workspace_isolated_restore=passed
marker_checksum=$marker_checksum
EOF

cat "$evidence_root/summary.txt"
