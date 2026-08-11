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

mkdir -p "$evidence_root"
sudo install -d -o 10001 -g 10001 -m 0750 "$workspace_root"

cp .env.production.example .env.production
set_env POSTGRES_PASSWORD ci-only-postgres-password
set_env DATABASE_URL 'postgresql://oliveira:ci-only-postgres-password@postgres:5432/devcloud?schema=public'
set_env RUNTIME_TICKET_SECRET 0123456789abcdef0123456789abcdef
set_env SECRETS_MASTER_KEY_BASE64 MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
set_env RUNTIME_BROKER_TOKEN abcdef0123456789abcdef0123456789
set_env DOCKER_GID "$(stat -c '%g' /var/run/docker.sock)"

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
curl --fail-with-body --silent --show-error -D "$headers_file" -o /dev/null \
  -H 'content-type: application/json' -X POST -d "$register_body" \
  "$api_url/api/v1/auth/register"
cookie="$(awk -F': ' 'tolower($1) == "set-cookie" { split($2, parts, ";"); gsub("\r", "", parts[1]); print parts[1]; exit }' "$headers_file")"
rm -f "$headers_file"
test -n "$cookie"

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
migrations=passed
readiness=passed
user_project_workspace_terminal=passed
postgres_restart=passed
redis_aof_restart=passed
workspace_bind_restart=passed
postgres_isolated_restore=passed
workspace_isolated_restore=passed
marker_checksum=$marker_checksum
EOF

cat "$evidence_root/summary.txt"
