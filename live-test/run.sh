#!/usr/bin/env bash
# Live hand-off test with realtime AIs on two otacon fleet phones. Not run in CI.
#
#   SCENARIO=answer   OpenClaw calls the "business" phone; the hand-off rings the
#                     "human" phone, which answers; both should end up talking.
#   SCENARIO=noanswer the human phone is left ringing; the voice agent should be
#                     told and pass that on to the business.
#
# Configure with environment variables (see .env.example); load your own file
# with `set -a; . ./my.env; set +a` first. Exit status 0 = pass.
set -euo pipefail
cd "$(dirname "$0")"

need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "missing env: $v" >&2; exit 2; }; done; }
need OTACON_AUDIO_HOST OPENAI_API_KEY GATEWAY_CLI \
  BUSINESS_PHONE BUSINESS_HOST_ID BUSINESS_NUMBER HUMAN_PHONE HUMAN_HOST_ID
SCENARIO="${SCENARIO:-answer}"
MAX_SECONDS="${MAX_SECONDS:-240}"
OPENING="${OPENING:-Hi, this is Nick's assistant. I'd like to book a table for two at 7:30 this Friday.}"
export OTACON_AUDIO_HOST OPENAI_API_KEY

RUN="runs/$(date -u +%Y%m%dT%H%M%SZ)-$SCENARIO"
mkdir -p "$RUN"
LOG="$RUN/transcript.jsonl"

hang_up_all() {
  for p in "$BUSINESS_PHONE" "$HUMAN_PHONE"; do
    NODE_NO_WARNINGS=1 otacon --phone "$p" call hangup >/dev/null 2>&1 || true
  done
}
trap hang_up_all EXIT

agent() { # phone host-id persona extra-args...
  local phone=$1 host=$2 persona=$3; shift 3
  timeout $((MAX_SECONDS + 120)) uv run -q phone_agent.py --phone "$phone" --host-id "$host" \
    --persona "$persona" --max-seconds "$MAX_SECONDS" --log "$LOG" "$@" > "$RUN/$persona.log" 2>&1
}

pids=()
if [ "$SCENARIO" = noanswer ]; then
  agent "$BUSINESS_PHONE" "$BUSINESS_HOST_ID" business --voice marin --hangup-on-goodbye \
    --arm-goodbye-on "can.?t join|cannot join|unavailable|not available|didn.?t pick up" & pids+=($!)
else
  agent "$BUSINESS_PHONE" "$BUSINESS_HOST_ID" business --voice marin & pids+=($!)
  agent "$HUMAN_PHONE" "$HUMAN_HOST_ID" human --voice cedar --hangup-on-goodbye & pids+=($!)
fi
sleep 5

params=$(python3 -c 'import json,sys;print(json.dumps({"to":sys.argv[1],"mode":"conversation","message":sys.argv[2]}))' \
  "$BUSINESS_NUMBER" "$OPENING")
$GATEWAY_CLI gateway call voicecall.start --params "$params" --json > "$RUN/start.json" 2>&1 \
  || { echo "voicecall.start failed:"; cat "$RUN/start.json"; exit 1; }
echo "call placed; run dir $RUN"

for pid in "${pids[@]}"; do wait "$pid" || true; done
hang_up_all

python3 - "$LOG" "$SCENARIO" <<'PY'
import json, sys
path, scenario = sys.argv[1], sys.argv[2]
events = [json.loads(l) for l in open(path)] if open(path).read().strip() else []
t0 = events[0]["t"] if events else 0
for e in events:
    if e["kind"] in ("answered", "heard", "said", "hung-up", "call-ended", "model-error", "gave-up"):
        print(f"{e['t'] - t0:6.1f} {e['who']:8s} {e['kind']:10s} {e['text'][:150]}")
heard = " ".join(e["text"].lower() for e in events if e["who"] == "business" and e["kind"] == "heard")
human_spoke = any(e["who"] == "human" and e["kind"] == "said" for e in events)
if scenario == "noanswer":
    ok = any(k in heard for k in ("can't join", "cannot join", "unavailable", "isn't available", "not available"))
    why = "business heard that the person can't join"
else:
    ok = "joining now" in heard and human_spoke
    why = "business heard the join announcement and the human spoke"
print(("PASS: " if ok else "FAIL: expected ") + why)
sys.exit(0 if ok else 1)
PY
