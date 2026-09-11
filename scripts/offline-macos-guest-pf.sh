#!/bin/sh
# Run inside one disposable macOS validation guest as root via sudo.
# The anchor blocks every outbound path except the isolated virtual-LAN peers.
set -eu

anchor='com.kuro.offline'
anchor_file="/etc/pf.anchors/$anchor"
pf_conf='/etc/pf.conf'
state_root='/var/db/kuro-offline-pf'
usage() { printf '%s\n' 'usage: sudo offline-macos-guest-pf.sh install PEER_IP[,PEER_IP...] [MANAGEMENT_IP[,MANAGEMENT_IP...]] | commit | remove | assert' >&2; exit 64; }
need_root() { [ "$(id -u)" -eq 0 ] || { printf '%s\n' 'Run this command through sudo inside the disposable guest.' >&2; exit 77; }; }

install() {
  peers=$1
  management=${2:-}
  [ -n "$peers" ] || usage
  case "$peers,$management" in *[!0-9.,]* | *..* | ,*) usage;; esac
  need_root
  [ ! -e "$state_root/pf.conf.before-kuro" ] || { printf '%s\n' 'KURO offline PF gate is already installed.' >&2; exit 1; }
  mkdir -p "$state_root"
  chmod 700 "$state_root"
  cp -p "$pf_conf" "$state_root/pf.conf.before-kuro"
  printf '%s\n' "$peers" >"$state_root/peers"
  printf '%s\n' "$management" >"$state_root/management"
  cat >"$anchor_file" <<EOF
table <kuro_offline_peers> persist { $peers }
$(if [ -n "$management" ]; then printf 'table <kuro_offline_management> persist { %s }\n' "$management"; fi)
# Playwright's local Electron inspector requires TCP over both loopback directions.
pass quick on lo0 all
pass out quick inet proto udp from any to <kuro_offline_peers>
$(if [ -n "$management" ]; then printf 'pass out quick inet proto tcp from any port 22 to <kuro_offline_management> port 1024:65535 flags any keep state\n'; fi)
block drop out quick all
EOF
  chmod 600 "$anchor_file"
  printf '\n# KURO offline validation anchor (disposable guest only)\nanchor "%s"\n' "$anchor" >>"$pf_conf"

  # Arm this before loading any PF rule.  A malformed rule or an unexpected
  # control-plane match must restore this disposable guest without waiting for
  # a surviving SSH connection.
  cat >"$state_root/rollback.sh" <<EOF
#!/bin/sh
sleep 45
[ -f "$state_root/rollback.pending" ] || exit 0
cp -p "$state_root/pf.conf.before-kuro" "$pf_conf"
pfctl -n -f "$pf_conf" && pfctl -f "$pf_conf"
pfctl -a "$anchor" -F all || true
token=\$(cat "$state_root/token" 2>/dev/null || true)
[ -z "\$token" ] || pfctl -X "\$token" || true
rm -f "$anchor_file"
rm -rf "$state_root"
EOF
  chmod 700 "$state_root/rollback.sh"
  : >"$state_root/rollback.pending"
  nohup "$state_root/rollback.sh" >/dev/null 2>&1 &
  printf '%s\n' "$!" >"$state_root/rollback.pid"

  pfctl -n -f "$pf_conf"
  pfctl -f "$pf_conf"
  pfctl -a "$anchor" -f "$anchor_file"
  token=$(pfctl -E 2>&1 | awk '/Token/{print $NF}' | tail -1 || true)
  printf '%s\n' "$token" >"$state_root/token"
  pfctl -a "$anchor" -sr
}

commit_gate() {
  need_root
  [ -f "$state_root/rollback.pending" ] || { printf '%s\n' 'No pending KURO PF rollback exists.' >&2; exit 1; }
  # Keep a guest-side deadline after the SSH control process is gone.  A host
  # SIGKILL cannot run coordinator cleanup, but normal `remove` cancels this.
  cat >"$state_root/recovery.sh" <<EOF
#!/bin/sh
sleep 1800
[ -f "$state_root/recovery.pending" ] || exit 0
cp -p "$state_root/pf.conf.before-kuro" "$pf_conf"
pfctl -n -f "$pf_conf" && pfctl -f "$pf_conf"
pfctl -a "$anchor" -F all || true
token=\$(cat "$state_root/token" 2>/dev/null || true)
[ -z "\$token" ] || pfctl -X "\$token" || true
rm -f "$anchor_file"
rm -rf "$state_root"
EOF
  chmod 700 "$state_root/recovery.sh"
  : >"$state_root/recovery.pending"
  nohup "$state_root/recovery.sh" >/dev/null 2>&1 &
  printf '%s\n' "$!" >"$state_root/recovery.pid"
  rm -f "$state_root/rollback.pending"
  rollback=$(cat "$state_root/rollback.pid" 2>/dev/null || true)
  [ -z "$rollback" ] || kill "$rollback" 2>/dev/null || true
  rm -f "$state_root/rollback.pid" "$state_root/rollback.sh"
  printf '%s\n' 'KURO PF egress gate committed after external verification; 30-minute guest recovery is armed.'
}

remove() {
  need_root
  [ -f "$state_root/pf.conf.before-kuro" ] || { printf '%s\n' 'No KURO offline PF backup exists.' >&2; exit 1; }
  rm -f "$state_root/rollback.pending" "$state_root/recovery.pending"
  for timer in rollback recovery; do
    pid=$(cat "$state_root/$timer.pid" 2>/dev/null || true)
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  cp -p "$state_root/pf.conf.before-kuro" "$pf_conf"
  pfctl -n -f "$pf_conf"
  pfctl -f "$pf_conf"
  pfctl -a "$anchor" -F all || true
  token=$(cat "$state_root/token" 2>/dev/null || true)
  [ -z "$token" ] || pfctl -X "$token" || true
  rm -f "$anchor_file"
  rm -rf "$state_root"
}

assert_gate() {
  need_root
  pfctl -s info | grep -q 'Status: Enabled' || { printf '%s\n' 'PF is not enabled.' >&2; exit 1; }
  pfctl -a "$anchor" -sr | grep -q 'block drop out quick all' || { printf '%s\n' 'KURO PF egress gate is absent.' >&2; exit 1; }
  if /usr/bin/curl --noproxy '*' --connect-timeout 3 --max-time 3 -I https://1.1.1.1 >/dev/null 2>&1; then
    printf '%s\n' 'External TCP unexpectedly succeeded.' >&2; exit 1
  fi
  printf '%s\n' 'Guest egress gate active; external TCP control failed as required.'
}

case ${1:-} in
  install) [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage; install "$2" "${3:-}" ;;
  commit) [ "$#" -eq 1 ] || usage; commit_gate ;;
  remove) [ "$#" -eq 1 ] || usage; remove ;;
  assert) [ "$#" -eq 1 ] || usage; assert_gate ;;
  *) usage ;;
esac
