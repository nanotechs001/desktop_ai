#!/bin/sh
# Spike probe (verdicts 1, 2 hop main->aioncore->claude, 4, 5) against an ISOLATED instance started by
# launch-isolated.mjs. Usage: probe-backend.sh <aioncore port> <scratch dir>. Prints one line per check.
set -eu
B="http://127.0.0.1:$1"; S="$2"; mkdir -p "$S"; W=$(mktemp -d)
here=$(cd "$(dirname "$0")" && pwd)
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
post() { curl -s -X POST -H 'Content-Type: application/json' -d "$2" "$B$1"; }

claude_id=$(curl -s "$B/api/agents/management" | j "[a['id'] for a in d['data'] if a.get('backend')=='claude'][0]")
printf '#!/bin/sh\nSPIKE_STUB_OUT=%s/spawns.jsonl exec %s %s/stub-claude.cjs "$@"\n' "$S" "$(command -v node)" "$here" > "$S/claude"
chmod +x "$S/claude"; : > "$S/spawns.jsonl"
curl -s -X PUT -H 'Content-Type: application/json' -d "{\"command_override\":\"$S/claude\",\"env_override\":[]}" \
  "$B/api/agents/$claude_id/overrides" >/dev/null

# Verdict 1: per-conversation engine override on a built-in (aionrs) assistant -> ignored?
echo "v1 word-creator bound to ->" $(curl -s "$B/api/assistants" | j "[a['agent_id'] for a in d['data'] if a['id']=='word-creator'][0]") "(claude is $claude_id)"
echo "v1 extra.backend/agent_id override ->" $(post /api/conversations "{\"name\":\"v1\",\"assistant\":{\"id\":\"word-creator\",\"conversation_overrides\":{\"agent_id\":\"$claude_id\"}},\"extra\":{\"workspace\":\"$W\",\"backend\":\"claude\",\"agent_id\":\"$claude_id\"}}" | j "d['data']['extra']['agent_id']")
curl -s -X PUT -H 'Content-Type: application/json' -d "{\"id\":\"word-creator\",\"agent_id\":\"$claude_id\"}" "$B/api/assistants/word-creator" >/dev/null
echo "v1 after PUT /api/assistants/word-creator {agent_id} ->" $(post /api/conversations "{\"name\":\"v1b\",\"assistant\":{\"id\":\"word-creator\"},\"extra\":{\"workspace\":\"$W\"}}" | j "d['data']['extra']['agent_id']")

# Verdict 4: non-builtin "Agent" with an explicit id and agent_id; rule write; built-in rejects.
id="spike-agent-$$"
echo "v4 create ->" $(post /api/assistants "{\"id\":\"$id\",\"name\":\"Agent\",\"agent_id\":\"$claude_id\"}" | j "(d['data']['id'], d['data']['source'])")
echo "v4 write rule ->" $(post /api/skills/assistant-rule/write "{\"assistant_id\":\"$id\",\"content\":\"SPIKE-RULE\"}")
echo "v4 write rule builtin ->" $(post /api/skills/assistant-rule/write '{"assistant_id":"word-creator","content":"x"}')

# Verdict 5 + verdict 2 hop 1: create a chat on the Agent, send, read back assistant id and the stub's env.
cid=$(post /api/conversations "{\"name\":\"v5\",\"assistant\":{\"id\":\"$id\"},\"extra\":{\"workspace\":\"$W\"}}" | j "d['data']['id']")
echo "v5 GET data.assistant.id ->" $(curl -s "$B/api/conversations/$cid" | j "d['data']['assistant']['id']")
post "/api/conversations/$cid/messages" '{"content":"hello"}' >/dev/null; sleep 6
python3 - "$S/spawns.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    if '--print' in d['argv']:
        keys = set(d['envKeys'])
        print('v2 claude env:', {k: k in keys for k in ('AIONUI_CONVERSATION_ID', 'AION_ARTIFACTS_URL', 'AION_ARTIFACTS_TOKEN')},
              'conv id matches:', d['convIdEnvMatches'], 'rule in argv:', any('SPIKE-RULE' in a for a in d['argv']))
PY
