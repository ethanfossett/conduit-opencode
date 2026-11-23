#!/usr/bin/env bash
set -euo pipefail

: "${NODECODE_API_KEY:?Set the Chat provider key}"
: "${CONDUIT_CHAT_OPENCODE_PASSWORD:?Set a separate Chat server password}"
chat_port="${CONDUIT_CHAT_OPENCODE_PORT:-4097}"
if [[ ! "$chat_port" =~ ^[0-9]{4,5}$ ]] || (( 10#$chat_port < 1024 || 10#$chat_port > 65535 )); then
  echo "Set CONDUIT_CHAT_OPENCODE_PORT to a dedicated port from 1024 to 65535." >&2
  exit 1
fi
chat_binary="$(realpath "${CONDUIT_CHAT_OPENCODE_BINARY:-$(command -v opencode)}")"
chat_config="$(dirname "$(realpath "$0")")/opencode.json"
chat_mounts=()
for chat_path in /bin /sbin /lib /lib64; do
  if [[ -L "$chat_path" ]]; then
    chat_mounts+=(--symlink "$(readlink "$chat_path")" "$chat_path")
  elif [[ -d "$chat_path" ]]; then
    chat_mounts+=(--ro-bind "$chat_path" "$chat_path")
  fi
done
for chat_path in /etc/resolv.conf /etc/nsswitch.conf /etc/ssl /etc/ca-certificates; do
  if [[ -e "$chat_path" ]]; then
    chat_mounts+=(--ro-bind "$(realpath "$chat_path")" "$chat_path")
  fi
done

# Pass secrets on stdin so the launcher doesn't put their values in argv.
printf '%s\n' "$NODECODE_API_KEY" "$CONDUIT_CHAT_OPENCODE_PASSWORD" |
  bwrap --unshare-all --share-net --die-with-parent --new-session --clearenv \
    --ro-bind /usr /usr "${chat_mounts[@]}" \
    --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home \
    --dir /home/chat --dir /workspace --chdir /workspace \
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
      export NODECODE_API_KEY OPENCODE_SERVER_PASSWORD
      exec /opencode serve --hostname 127.0.0.1 --port "$1" </dev/null
    ' chat-opencode "$chat_port"
