# Transport harness

Run `pnpm --filter @kuro/transport-harness smoke` after workspace dependencies are installed. It starts a loopback HyperDHT bootstrapper and a persistent routing node, then two separate Node processes with fixed synthetic seeds. The shared transport conformance helper sends an authenticated D25 request to the authority, sends a correlated structurally valid `SPACE_STATE_RESPONSE ACTIVE` with the processes' actual keys and recomputed projection digest, verifies sender-key provenance and unknown-peer rejection, holds receiver observation until after send acceptance to prove that acceptance is not a durable receipt, relaunches both peers with their same seeds, repeats the fresh fetch, and checks an immutable response replay.

The macOS local-only run below passed on September 10, 2026. Its sandbox denies network egress except `localhost`; it proves the Node harness can operate against its loopback isolated bootstrap/router under that policy. It does not prove a physical LAN.

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))' node --import tsx harnesses/transport/src/real-smoke.ts
```

For the next physical-LAN check, install the workspace on both devices and run the remaining commands from `harnesses/transport/` so that package imports resolve. Replace `192.168.1.20` with the stable bootstrap host's LAN address. Run a bootstrapper on that host and leave it running:

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
