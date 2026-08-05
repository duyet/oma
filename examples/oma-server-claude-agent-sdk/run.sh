#!/bin/sh
# Registers the agent + an environment against a LOCAL self-hosted instance
# started from this directory's docker-compose.yml, then sends one message.
#
#   OMA_BASE_URL  default http://localhost:8787
#   OMA_API_KEY   default "local" (matches AUTH_DISABLED=1 deploys)
#   OMA_ENV_ID    optional; one is created when unset
set -eu

OMA_BASE_URL="${OMA_BASE_URL:-http://localhost:8787}"
OMA_API_KEY="${OMA_API_KEY:-local}"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Checking $OMA_BASE_URL/health ..."
curl -sf "$OMA_BASE_URL/health" >/dev/null || {
  echo "Server not reachable. Start it with:"
  echo "  docker compose -f examples/oma-server-claude-agent-sdk/docker-compose.yml up --build"
  exit 1
}

if [ -z "${OMA_ENV_ID:-}" ]; then
  echo "Creating environment..."
  OMA_ENV_ID=$(curl -sf "$OMA_BASE_URL/v1/environments" \
    -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
    -d '{"name":"oma-server-claude-agent-sdk","config":{"type":"cloud"}}' \
    | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
fi
echo "Environment: $OMA_ENV_ID"

echo "Creating agent..."
AGENT_ID=$(curl -sf "$OMA_BASE_URL/v1/agents" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d @"$DIR/agent.json" | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Agent: $AGENT_ID"

echo "Creating session..."
SESSION_ID=$(curl -sf "$OMA_BASE_URL/v1/sessions" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d "{\"agent\": \"$AGENT_ID\", \"environment_id\": \"$OMA_ENV_ID\", \"title\": \"oma-server-claude-agent-sdk example\"}" \
  | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Session: $SESSION_ID"

echo "Sending message..."
curl -sf "$OMA_BASE_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Create hello.txt containing \"hi\", then read it back."}]}]}'

echo
echo "Tail with: curl -N $OMA_BASE_URL/v1/sessions/$SESSION_ID/events/stream -H \"x-api-key: $OMA_API_KEY\""
