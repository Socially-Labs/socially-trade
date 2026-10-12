#!/bin/sh
# Run inside Coolify's deployment helper, in the checked-out project directory.
# Keep startup failures visible even when the API is crash-looping.
set -eu
project=${1:?usage: start-coolify.sh COOLIFY_RESOURCE_UUID}
compose() {
  docker compose --env-file .env --project-name "$project" \
    --project-directory "$PWD" -f compose.coolify.yaml "$@"
}
if compose up -d; then
  exit 0
else
  status=$?
  compose logs --no-color --tail 80 api
  exit "$status"
fi
