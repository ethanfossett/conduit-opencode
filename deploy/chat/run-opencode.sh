#!/usr/bin/env bash
set -euo pipefail

: "${NODECODE_API_KEY:?Set the Chat provider key}"
: "${CONDUIT_CHAT_OPENCODE_PASSWORD:?Set a separate Chat server password}"
chat_port="${CONDUIT_CHAT_OPENCODE_PORT:-4197}"
if [[ ! "$chat_port" =~ ^[0-9]{4,5}$ ]] || (( 10#$chat_port < 1024 || 10#$chat_port > 65535 )); then
  echo "Set CONDUIT_CHAT_OPENCODE_PORT to a dedicated port from 1024 to 65535." >&2
  exit 1
fi

chat_binary="$(realpath "${CONDUIT_CHAT_OPENCODE_BINARY:-$(command -v opencode)}")"
chat_config="$(dirname "$(realpath "$0")")/opencode.json"
chat_socat="$(command -v socat)"
chat_bridge="$(mktemp -d /tmp/conduit-chat-XXXXXXXX)"
chat_pids=()
cleanup() {
  if (("${#chat_pids[@]}")); then
    kill "${chat_pids[@]}" 2>/dev/null || true
    wait "${chat_pids[@]}" 2>/dev/null || true
  fi
  rm -rf -- "$chat_bridge"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

chat_mounts=()
for chat_path in /bin /sbin /lib /lib64; do
  if [[ -L "$chat_path" ]]; then
    chat_mounts+=(--symlink "$(readlink "$chat_path")" "$chat_path")
  elif [[ -d "$chat_path" ]]; then
    chat_mounts+=(--ro-bind "$chat_path" "$chat_path")
  fi
done
for chat_path in /etc/ssl /etc/ca-certificates; do
  if [[ -e "$chat_path" ]]; then
    chat_mounts+=(--ro-bind "$(realpath "$chat_path")" "$chat_path")
  fi
done
printf '127.0.0.1 localhost\n127.0.0.2 api.nodecode.ai\n' > "$chat_bridge/hosts"
printf 'hosts: files\n' > "$chat_bridge/nsswitch.conf"

# The isolated namespace can reach only this fixed TLS destination. OpenCode
# verifies the provider certificate using the original hostname.
env -u NODECODE_API_KEY -u CONDUIT_CHAT_OPENCODE_PASSWORD "$chat_socat" "UNIX-LISTEN:$chat_bridge/model.sock,mode=0600,fork" "TCP4:api.nodecode.ai:443,connect-timeout=10" &
chat_pids+=("$!")
env -u NODECODE_API_KEY -u CONDUIT_CHAT_OPENCODE_PASSWORD "$chat_socat" "TCP4-LISTEN:$chat_port,bind=127.0.0.1,reuseaddr,fork" "UNIX-CONNECT:$chat_bridge/chat.sock" &
chat_pids+=("$!")

# Pass secrets on stdin to keep them off the command line.
bwrap --unshare-all --die-with-parent --new-session --clearenv \
  --ro-bind /usr /usr "${chat_mounts[@]}" \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home \
  --dir /home/chat --dir /workspace --chdir /workspace \
  --bind "$chat_bridge" /bridge \
  --ro-bind "$chat_bridge/hosts" /etc/hosts \
  --ro-bind "$chat_bridge/nsswitch.conf" /etc/nsswitch.conf \
  --ro-bind "$chat_binary" /opencode \
  --ro-bind "$chat_config" /chat-opencode.json \
  --setenv HOME /home/chat --setenv PATH /usr/bin:/bin \
  --setenv OPENCODE_CONFIG /chat-opencode.json \
  --setenv OPENCODE_DISABLE_CLAUDE_CODE 1 \
  --setenv OPENCODE_DISABLE_MODELS_FETCH 1 \
  --setenv NODE_EXTRA_CA_CERTS /etc/ssl/certs/ca-certificates.crt \
  -- /bin/sh -eu -c '
    IFS= read -r NODECODE_API_KEY
    IFS= read -r OPENCODE_SERVER_PASSWORD
    socat "TCP4-LISTEN:8443,bind=127.0.0.2,reuseaddr,fork" "UNIX-CONNECT:/bridge/model.sock" &
    socat "UNIX-LISTEN:/bridge/chat.sock,mode=0600,fork" "TCP4:127.0.0.1:$1" &
    export NODECODE_API_KEY OPENCODE_SERVER_PASSWORD
    exec /opencode serve --hostname 127.0.0.1 --port "$1" </dev/null
  ' chat-opencode "$chat_port" < <(printf '%s\n' "$NODECODE_API_KEY" "$CONDUIT_CHAT_OPENCODE_PASSWORD") &
chat_pids+=("$!")

wait -n "${chat_pids[@]}"
