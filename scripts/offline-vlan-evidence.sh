#!/bin/sh
# Run in each macOS validation guest after configuring its fixed local UDP port.
# Captures only headers for the named virtual peer/router addresses.
set -eu

usage() { printf '%s\n' 'usage: sudo offline-vlan-evidence.sh INTERFACE PEER_IP ROUTER_IP OUTPUT_PCAP' >&2; exit 64; }
[ "$#" -eq 4 ] || usage
[ "$(id -u)" -eq 0 ] || { printf '%s\n' 'Run through sudo inside a disposable validation guest.' >&2; exit 77; }
interface=$1
peer=$2
router=$3
pcap=$4
case "$interface,$peer,$router" in *[!A-Za-z0-9._,-]* | *..* | ,*) usage;; esac

mkdir -p "$(dirname "$pcap")"
route -n get "$peer"
netstat -rn -f inet
# Ethernet (14) plus IPv4 (20) plus UDP (8) retains the tuple with no payload.
exec tcpdump -ni "$interface" -s 42 -c 80 -w "$pcap" "udp and (host $peer or host $router)"
