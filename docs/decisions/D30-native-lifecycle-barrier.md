# D30: synchronous desktop clock and lifecycle barrier

Electron power notifications may be delivered after a protected callback. The host therefore
samples a native sleep generation on every `Clock` read and at IPC/render delivery boundaries.
It does not infer sleep from a tolerated difference between separately read clocks.

## Qualified native implementation

The native Node-API addon calls public `mach_approximate_time` and
`mach_continuous_approximate_time` in the order `c1,a1,c2,a2`. A sample is accepted only if
`c1 == c2`, `a1 == a2`, and `c2 >= a2`; its exact integer generation is `c2 - a2`.
Sixteen unsuccessful attempts fail closed. A 32-sample startup canary must also succeed.
The addon brackets exact continuous/wall readings with generation samples, rejects a
transition during them, and returns safe integer milliseconds plus a BigInt generation.

In the inspected macOS implementation, both approximate clocks use the same cached awake
timestamp; the continuous clock adds cumulative sleep. Both values are monotonic, so the
equality checks reject intervening changes without a skew threshold or an ABA before wrap.
The XNU wake path updates the sleep base before userspace notifications. A fresh post-wake
read therefore detects sleep even while the Electron main thread has not dispatched events.
An accepted authorization linearizes at the final native sample; B05's existing allowance
for transit after authorization is unchanged. Already delivered pixels or copies cannot be recalled.

This composition is **implementation-qualified**, not a documented promise of atomic pairing
across all Apple releases. The allowlist is exactly macOS 26.5, Darwin 25.5.0, build 25F71,
arm64. The installed universal runtime was disassembled and the public SDK declarations and
XNU source inspected. Five million native sandwiches produced no false epoch changes;
547 unstable samples were rejected in that run. x86_64 compilation succeeds but is not
enabled. Other builds/platforms and failed native loading/canaries keep real mode closed.
Changing the allowlist requires renewed source/runtime inspection and wake validation.

Primary implementation evidence:

- [Apple cached approximate clock](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/mach_approximate_time.c#L28-L37)
- [Apple continuous approximate clock](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/mach_continuous_time.c#L132-L140)
- [Kernel wake clock update](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/clock.c#L1185-L1218)
- [Power-management wake caller](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/iokit/Kernel/IOPMrootDomain.cpp#L3106-L3113)

## Closing and recovery

`LifecycleClock` latches closed on changed generation, native failure, or wall/monotonic
rollback. Subsequent successful samples cannot reopen it. The synchronous callback closes
every core, advances its lifecycle generation, clears protected views, and invalidates work.
The core never reads the closing Clock to enumerate spaces. A throwing Clock also closes
the authority gate, and a late AI result cannot become a draft.

The serialized host recovery repeats durable cancellation outside the interrupted writer
transaction because its rollback may have undone the first invalidation. It then validates
a new native baseline without resetting time high-water marks and calls `resume(true)`.
Core repeats cancellation, discards outstanding authority requests and stales participant
caches before reopening. Each participant still needs a fresh direct authority response.
Renewal cannot revive old reviews, summaries or unsent deliveries. Screen lock prevents
automatic recovery until unlock. Delayed/duplicate power events conservatively close again;
native detection and a later tick can recover without depending on notification ordering.

AppPort replies are checked after asynchronous operations. Pairing commands additionally
capture an authority lifecycle generation around their awaited selection, preventing a
rejected old command from committing after recovery. Native dialogs and peer-file publication
also recheck before side effects. No public command can set clock trust.

The sandboxed preload uses a fixed, read-only synchronous IPC epoch check after async replies
and before animation frames. It discards replies from older epochs and synchronously clears
protected DOM on invalidation. The renderer receives no native handle, Node API, arbitrary
channel or new permission command. The shared DesktopInfo enum adds `native`; AppPort,
Clock, CoreLifecyclePort, wire v1 and pnpm setup retain their existing contracts.

## Build and validation

`node-api-headers@1.9.0` is an exact desktop development dependency from the Node.js project
(MIT). The C addon is original KURO integration code using public APIs and the cited source
as behavioral evidence. `build-clock.mjs` uses the installed public macOS SDK and clang;
Node-API version 8 loads in Node 24 and Electron 44 without an Electron-specific ABI rebuild.
`desktop:build` stages `host/clock.node` beside host chunks; it remains inside the relocated
distribution. There are no new database migrations or wire fixtures.

The automated suites cover a native epoch change before a power callback, both Clock
getters, rollback, failed durable cancellation, duplicate events, lock, another sleep during
resume, old IPC/frame replies, old authority responses, pending dispatch, late valid AI
output, and all four delayed pairing mutations. Actual Electron UI tests verify protected
content clears through the production preload.

The relocated packaged `--probe=lifecycle` passed on Electron 44.3.0 / Node 24.20.0 with
10,000 actual native samples (2.99 ms), two actual SQLite cores, discarded pending replies,
required fresh authority synchronization and recovered authorized evidence. AI/transport
and power events in this probe are explicitly simulated; it does not prove physical sleep.

`--probe=lifecycle-sleep` provides the remaining physical check. It prints `ready-for-sleep`,
then blocks JavaScript event dispatch for at most 90 seconds while polling the native Clock.
Suspend and wake the Mac during that interval. Success requires an actual changed native
sleep generation, a closed gate before any JavaScript power callback, discarded pending
evidence, and fresh authority synchronization before evidence becomes readable again.
It creates only temporary synthetic state and does not initiate sleep itself.
Physical sleep validation is pending; no such result is claimed by the injected probe.
