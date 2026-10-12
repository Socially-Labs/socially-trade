#!/bin/sh
# Run inside Coolify's deployment helper, in the checked-out project directory.
# Keep startup failures visible even when the API is crash-looping.
set -eu
project=${1:?usage: start-coolify.sh COOLIFY_RESOURCE_UUID}
compose() {
  docker compose --env-file .env --project-name "$project" \
    --project-directory "$PWD" -f compose.coolify.yaml "$@"
}
if [ "${2:-}" = "repair-db-password" ]; then
  # Explicit one-time repair only. Preserve the database and synchronize its
  # role with POSTGRES_PASSWORD after correcting deployment interpolation.
  compose up -d --wait postgres redis
  compose exec -T postgres sh -c 'psql -U socially -d socially_trade -v ON_ERROR_STOP=1 -v new_password="$POSTGRES_PASSWORD"' <<'SQL'
ALTER ROLE socially WITH PASSWORD :'new_password';
SQL
fi
if compose up -d; then
  exit 0
else
  status=$?
  compose logs --no-color --tail 80 api
  exit "$status"
fi
