# Transport harness

Run `pnpm --filter @kuro/transport-harness smoke` after workspace dependencies are installed. It starts a loopback HyperDHT bootstrapper and a persistent routing node, then two separate Node processes with synthetic seeds. The shared transport conformance helper sends an authenticated D25 request to the authority, sends a correlated structurally valid `SPACE_STATE_RESPONSE ACTIVE` with the processes' actual keys and recomputed projection digest, verifies sender-key provenance and unknown-peer rejection, holds receiver observation until after send acceptance to prove that acceptance is not a durable receipt, relaunches the recipient with its same seed while the authority stays running, repeats the fresh fetch, and checks an immutable response replay.

The macOS local-only run below passed on September 10, 2026. Its sandbox denies network egress except `localhost`; it proves the Node harness can operate against its loopback isolated bootstrap/router under that policy. It does not prove a physical LAN.

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))' node --import tsx harnesses/transport/src/real-smoke.ts
```

## Virtual network custody workflow

`src/virtual-core.ts` drives two independent persistent cores through their public ports. Run it on a Linux owner VM; it starts the owner core, an isolated bootstrap and persistent router there, and starts the requester core over SSH in a second VM. Install the frozen workspace on both VMs first. Use a dedicated test SSH key, verify the requester's host key through the trusted VM console, and disable SSH forwarding. Keep keys, source archives and state outside Git.

Example configuration, run from the owner VM's repository root:

```sh
KURO_VM_TEST_CONFIG='{"bootstrapHost":"192.168.104.1","sshConfig":"/home/test/.ssh/kuro-test.config","sshHost":"kuro-requester","guestRepository":"/home/test/kuro","guestStateRoot":"/home/test/kuro-runs","hostStateRoot":"/home/test/kuro-runs","guestPort":49747}' node --import tsx harnesses/transport/src/virtual-core.ts
```

Replace addresses, users and paths with the actual VM values. `bootstrapHost` must be the owner VM's address, reachable directly from the requester. The SSH configuration identifies the requester. The runner preserves each peer's SQLite directory and uses fresh synthetic transport seeds for each run; the requester relaunch within that run reuses its seed and database. These in-memory test secret stores do not validate production OS secret storage.

The automated fixture prints the exact synthetic review and explicitly calls approval with its stored revision/digest. It rejects both a wrong revision and a wrong digest before approving the unchanged view. It checks restricted/cross-space exclusion, durable evidence, dropped ACK, same-identity process relaunch, identical response retries with one inbox effect, model-free reading, no summary calls on receipt, explicit preparation/execution, revoke-before-dispatch and a correlated DENIED authority projection. It does not replace the [manual human-review harness](../core/README.md). AI defaults to explicitly simulated `FakeAiPort`; selecting `ai: "qvac"` uses actual local QVAC. HyperDHT authentication, framing, network traffic and SQLite are real in both modes.

For a fully isolated VM run, install dependencies before applying firewall rules. Use a dedicated nftables `inet` output chain with a default-drop policy on **each test VM**, allowing loopback, UDP to the two test VM addresses, owner-to-requester SSH port 22, and SSH replies to the management host. The management source may differ from the VM LAN gateway; inspect `$SSH_CONNECTION` first. Cover IPv4 and IPv6. Do not replace unrelated host firewall rules. Check the rules with `nft -c -f`, apply them, prove that an external TCP connection fails, then launch fresh peers. Remove only the dedicated test table afterward. The runner does not change any firewall itself.

Virtual machines provide separate operating systems, addresses and network stacks on one physical Mac. This is virtual-network evidence; a physical two-device LAN remains a separate deployment check.

The September 10 environment uses Lima 2.2.0 with two VZ Ubuntu 24.04.4 arm64 guests, each with two virtual CPUs, 2 GiB RAM, a 12 GiB sparse disk, `plain: true`, `mounts: []`, and containerd disabled. Both attach to Lima's [rootless `user-v2` network](https://lima-vm.io/docs/config/network/user-v2/). VZ NAT alone is [host-accessible but guest-isolated](https://lima-vm.io/docs/config/network/). The two-guest full custody profile did not pass: clean runs failed initial authority synchronization or post-relaunch refresh, although a synchronized direct UDP echo passed. Do not infer a generic UDP outage or a successful two-VM run from those controls. The one-VM namespace profile below passed the complete workflow with the clean committed worker. The observed shared addresses are owner `192.168.104.1`, requester `192.168.104.3`, management source `192.168.104.2`; discover them again when reproducing the environment.

The owner VM's tested firewall file is:

```nft
table inet kuro_validation {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    ip daddr 192.168.104.3 meta l4proto udp accept
    ip daddr 192.168.104.3 tcp dport 22 accept
    ip daddr 192.168.104.2 tcp sport 22 accept
    counter drop
  }
}
```

The requester uses the same chain with UDP allowed only to `192.168.104.1`, no outbound SSH initiation, and SSH replies (`tcp sport 22`) allowed to `{ 192.168.104.1, 192.168.104.2 }`. Check an initially absent table with `sudo nft -c -f offline.nft`, then apply with `sudo nft -f offline.nft`. To replace an existing test table atomically, prepend `delete table inet kuro_validation` to that file. An external control is `curl --noproxy '*' --connect-timeout 3 --max-time 3 -I https://1.1.1.1`; it must fail after the rules are applied. Remove the test gate with `sudo nft delete table inet kuro_validation`. These rules apply only inside the disposable test VMs and are not installed as startup services.

### One VM with isolated peer network namespaces

A Linux VM can also host two independent network stacks connected by a direct virtual Ethernet pair. This exercises the same SSH runner, real HyperDHT and separate persistent core processes/databases. Both peers share the VM's kernel and filesystem; it is not a two-VM or physical-device result.

Create an unused test subnet and bring up the two ends inside their respective namespaces:

```sh
sudo ip netns add kuro-owner
sudo ip netns add kuro-requester
sudo ip link add kuro-owner-veth type veth peer name kuro-req-veth
sudo ip link set kuro-owner-veth netns kuro-owner
sudo ip link set kuro-req-veth netns kuro-requester
sudo ip -n kuro-owner addr add 10.77.0.1/24 dev kuro-owner-veth
sudo ip -n kuro-requester addr add 10.77.0.2/24 dev kuro-req-veth
sudo ip -n kuro-owner link set lo up
sudo ip -n kuro-requester link set lo up
sudo ip -n kuro-owner link set kuro-owner-veth up
sudo ip -n kuro-requester link set kuro-req-veth up
```

Do not add an external interface or default route. Apply the earlier output-default-drop nftables template **inside each namespace** with `sudo ip netns exec NAME nft -f FILE`: owner allows loopback, UDP and SSH initiation only to `10.77.0.2`; requester allows loopback, UDP and SSH replies only to `10.77.0.1`. Check `nft list ruleset` and the failed external TCP control inside both namespaces before launching fresh peers.

Run a dedicated SSH daemon in `kuro-requester`, bound to `10.77.0.2:22`, with a newly generated test host key and only the dedicated test client's public key. Use private test paths for `HostKey`, `PidFile` and `AuthorizedKeysFile`; set `AllowUsers` to the normal test user. Disable password/keyboard-interactive authentication, root login, empty passwords, forwarding, tunnels, X11, PTY and user-supplied environment. Validate its configuration with `sshd -t -f FILE`, then start it with `sudo ip netns exec kuro-requester /usr/sbin/sshd -f FILE`. Verify the generated public host key locally and put it in the owner's dedicated strict known-host file. Keep the ordinary VM management SSH service outside these namespaces.

Run as the normal user inside `kuro-owner`. `setpriv` drops root after entering the namespace without a second sudo invocation or its hostname lookup. On a VM with an unresolved local hostname, repair its local hosts entry before installing the external-egress gate so outer sudo does not wait for blocked DNS.

```sh
KURO_TEST_UID=$(id -u)
KURO_TEST_GID=$(id -g)
sudo ip netns exec kuro-owner setpriv --reuid="$KURO_TEST_UID" --regid="$KURO_TEST_GID" --init-groups --reset-env \
  env PATH="$PATH" KURO_VM_TEST_CONFIG='{"bootstrapHost":"10.77.0.1","sshConfig":"/absolute/test/requester-ssh.config","sshHost":"kuro-requester-netns","guestRepository":"/absolute/kuro","guestStateRoot":"/absolute/test/requester-state","hostStateRoot":"/absolute/test/owner-state","guestPort":49747}' \
  node --import tsx harnesses/transport/src/virtual-core.ts
```

The SSH alias must point to `10.77.0.2`; the repository path may be shared, but the two state roots must differ. The receiver must signal that it has bound its UDP port before a control sender starts. Synchronized Python `sendto` and `sendmsg` echo controls at 64, 512 and 1,200 bytes passed on this link. Sequential shell calls with short-lived receivers are not reliable packet-loss evidence.

After all peers and the dedicated SSH daemon have stopped, remove only the fixture namespaces with `sudo ip netns del kuro-owner` and `sudo ip netns del kuro-requester`; this removes their veth link and namespace-local firewall state. Preserve or explicitly remove the synthetic state/keys separately. Stopping the disposable VM also ends its remaining test processes.

## Physical LAN transport procedure

Install the workspace on both devices and run the remaining commands from `harnesses/transport/` so that package imports resolve. Replace `192.168.1.20` with the stable bootstrap host's LAN address. Run a bootstrapper on that host and leave it running:

```sh
KURO_LAN_IP=192.168.1.20 node --input-type=module -e 'import DHT from "hyperdht"; const node = DHT.bootstrapper(49737, process.env.KURO_LAN_IP); await node.fullyBootstrapped(); await new Promise(() => {});'
```

On that same host, run one persistent router for the isolated network:

```sh
KURO_LAN_IP=192.168.1.20 node --input-type=module -e 'import DHT from "hyperdht"; const bootstrap = [{ host: process.env.KURO_LAN_IP, port: 49737 }]; const node = new DHT({ bootstrap, ephemeral: false, host: process.env.KURO_LAN_IP, firewalled: false }); await node.fullyBootstrapped(); await new Promise(() => {});'
```

For this diagnostic only, generate two synthetic ephemeral seeds and derive their peer keys. Do not use this in production; production composition supplies an OS-protected `SecretStore`.

```sh
SEED_A=$(openssl rand -hex 32)
SEED_B=$(openssl rand -hex 32)
KEY_A=$(KURO_SEED="$SEED_A" node --input-type=module -e 'import DHT from "hyperdht"; console.log(Buffer.from(DHT.keyPair(Buffer.from(process.env.KURO_SEED, "hex")).publicKey).toString("hex"));')
KEY_B=$(KURO_SEED="$SEED_B" node --input-type=module -e 'import DHT from "hyperdht"; console.log(Buffer.from(DHT.keyPair(Buffer.from(process.env.KURO_SEED, "hex")).publicKey).toString("hex"));')
```

Launch this command on device A, substituting its seed and B's paired key; launch the analogous command on B with the values reversed. The child accepts JSON commands on standard input and reports authenticated message events as JSON on standard output.

```sh
KURO_TRANSPORT_CONFIG='{"bootstrap":[{"host":"192.168.1.20","port":49737}],"seedHex":"'$SEED_A'","pairedPeers":["'$KEY_B'"]}' node --import tsx src/peer-process.ts
```

In a second terminal, generate the JSON command below and paste its output into B's running peer. Set `KURO_AUTHORITY` to A's verified public key:

```sh
KURO_AUTHORITY="$KEY_A" node --import tsx --input-type=module -e 'import {spaceStateRequestBytes} from "@kuro/transport"; console.log(JSON.stringify({type:"send",peerKey:process.env.KURO_AUTHORITY,bytesHex:Buffer.from(spaceStateRequestBytes("1".repeat(32))).toString("hex")}));'
```

A must report a message whose `peerKey` equals B's verified key. Generate the correlated response command and paste it into A's running peer:

```sh
KURO_AUTHORITY="$KEY_A" KURO_RECIPIENT="$KEY_B" node --import tsx --input-type=module -e 'import {activeResponseBytes} from "@kuro/transport"; console.log(JSON.stringify({type:"send",peerKey:process.env.KURO_RECIPIENT,bytesHex:Buffer.from(activeResponseBytes(process.env.KURO_AUTHORITY,process.env.KURO_RECIPIENT,"1".repeat(32))).toString("hex")}));'
```

B must report A's authenticated key and the same exact body bytes. Enter `{"type":"stop"}` and relaunch a peer with its same seed, then repeat with a new request ID. Replay the already delivered response command and compare its bytes. These helper bytes are synthetic D25 transport fixtures; core must still validate bindings, outstanding request state, counters, leases, and durable installation. Exchange synthetic test seeds only through the controlled diagnostic setup and clear them afterward; they are never production identities.

This is real Node/HyperDHT loopback evidence. It is not a Pear/Bare packaging check and does not demonstrate a physical offline LAN. The remaining runtime check is to package `packages/transport/src/hyperdht-worker.ts` with the selected Bare/Pear host, run the same two-peer exchange against a reachable isolated bootstrap and persistent router, then repeat with the intended LAN disconnected from public Internet.

## Combined core workflow with selectable AI

The same coordinator can run the complete custody/restart scenario in two local OS
processes, using real HyperDHT and separate SQLite databases:

```sh
pnpm --filter @kuro/transport-harness core-smoke
KURO_VM_TEST_CONFIG='{"mode":"local","ai":"qvac"}' pnpm --filter @kuro/transport-harness core-smoke
```

The default explicitly uses simulated AI. `ai: "qvac"` selects the real adapter from
`@kuro/ai` in each peer process, without a fallback to simulation. Install the native
prerequisites and prepare the models using the [AI harness](../ai/README.md) first.
The coordinator checks each peer's declared provider on startup and restart. It
compares ranking candidate IDs with permitted review references, performs explicit
synthetic approval commands, drops ACKs, relaunches the requester, checks byte-identical
retry and one inbox effect, unloads AI while reading evidence, then explicitly starts
summary generation. It finally checks revoke-before-dispatch and authority denial.

The output labels automated synthetic approval and the selected model provider; it
is not a human usability test. Local mode is process-isolation evidence, not an
offline-LAN or physical-device claim. State directories and generated run IDs are
printed and retained outside Git for inspection.

Existing SSH/VM configurations retain their behavior. Add `"ai":"qvac"` to the
previous `KURO_VM_TEST_CONFIG` to use real models on both configured hosts. Preload
models independently on each host before restricting external egress. The network
peer's `tick` command returns while model computation proceeds, allowing subsequent
ticks to enforce the core's computation deadline. The coordinator waits for observable
index and summary states instead of assuming inference completes within one tick.

The actual-QVAC profile passed at `290c7cb` on macOS arm64 in local mode (run
`2b843fd6-bbc3-4fc1-bb87-5c6949d243fa`) and on Ubuntu 24.04.4 arm64 using the one-VM
namespace procedure (run `87ef0191-d073-4596-9a51-1e3e06060131`). The virtual run used
8 GiB RAM, a 20 GiB disk, Node 24.19.0, pnpm 11.19.0 and `libatomic1`. Models were
cached with the pinned checksums before the output-default-drop gates were applied.
Both external TCP controls failed before and after the complete workflow, including
actual QVAC summary generation. These are synthetic automated workflow results;
physical-device behavior and desktop composition remain unverified.
