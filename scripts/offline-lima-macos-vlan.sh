#!/bin/sh
# Creates only the private Lima definitions for the KURO offline desktop check.
# It never starts a VM, downloads an image, mounts a host directory, or changes
# host networking.  `limactl start` is deliberately a separate operator step.
set -eu

expected_sha='fbaa50395763009b93af4125cad7fe87722b91d8b2576498c0d341a7a5171899'
validation_home=${KURO_VALIDATION_HOME:?Set KURO_VALIDATION_HOME to a private validation directory.}
image=${KURO_MACOS_IPSW:-"$validation_home/macos-ipsw/UniversalMac_26.5_25F71_Restore.ipsw"}
lima_home=${LIMA_HOME:-"$validation_home/lima-offline-macos"}
network_name=${KURO_OFFLINE_NETWORK:-ko}
gateway=${KURO_OFFLINE_GATEWAY:-192.168.241.1/24}
config_dir="$validation_home/offline/lima"

die() { printf '%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die 'This topology requires a macOS VZ host.'
[ -r "$image" ] || die "Missing exact 25F71 IPSW: $image"
actual_sha=$(shasum -a 256 "$image" | awk '{print $1}')
[ "$actual_sha" = "$expected_sha" ] || die 'The IPSW SHA-256 does not match Apple CDN metadata.'

umask 077
mkdir -p "$config_dir" "$lima_home"

cat >"$config_dir/offline-macos-owner.yaml" <<EOF
minimumLimaVersion: 2.2.0
images:
  - location: "$image"
    arch: aarch64
    digest: "sha256:$expected_sha"
os: Darwin
arch: aarch64
vmType: vz
cpus: 4
memory: 12GiB
disk: 80GiB
plain: true
mounts: []
networks:
  - lima: $network_name
video:
  display: default
EOF

cp "$config_dir/offline-macos-owner.yaml" "$config_dir/offline-macos-requester.yaml"

cat >"$config_dir/offline-router.yaml" <<EOF
minimumLimaVersion: 2.2.0
images:
  - location: "https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-arm64.img"
    arch: aarch64
    digest: "sha256:7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc"
arch: aarch64
vmType: vz
cpus: 2
memory: 2GiB
disk: 12GiB
plain: true
mounts: []
containerd:
  user: false
  system: false
networks:
  - lima: $network_name
EOF

printf '%s\n' "Definitions written to $config_dir"
printf '%s\n' "Create the dedicated user-v2 network: LIMA_HOME=$lima_home limactl network create $network_name --gateway $gateway"
printf '%s\n' "Then start router, owner, and requester as ko-r, ko-o, and ko-q. Short names keep Lima's SSH socket below macOS UNIX_PATH_MAX."
printf '%s\n' 'Do not attach any other network or host mount. Apply the guest PF gate only after copying cached models and the package.'
