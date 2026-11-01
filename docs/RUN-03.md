# Operated runner: isolation checkpoints

RUN-03 is in progress. Two checkpoints were verified on 2026-11-01: **offline owned Node fixtures** under OS-enforced container controls, followed by **two owned Chromium journeys under gVisor** in a separate isolated Linux environment. Neither runs customer code or preview websites. See the [dedicated host guide](RUN-03-HOST.md) and [browser evidence](evidence/RUN-03-gvisor.json). RUN-01's visible browser demo still uses its existing controlled local driver.

## First checkpoint

`runners/offline-host.ts` supervises a fresh container for one reviewed probe. The CLI resolves the locally cached official `node:22` image to its immutable image ID, refuses image-declared volumes, and never pulls an image. The Linux fixture uses Node 22; the application and supervisor remain Node 24. No repository, host directory, Docker socket, database connection, run grant, host credential, or payment key is mounted or passed into the container. Only the closed probe names can be dispatched; there is no caller-provided script or target URL.

The fixed `offline-runner-v1` policy enforces:

| Control | Bound |
| --- | --- |
| Network | `none`: only the container's own loopback namespace, no external interface or route |
| Process identity | UID/GID 65534, all capabilities dropped, no-new-privileges, Docker builtin seccomp |
| Root filesystem | Read-only, no bind mounts or persistent volumes |
| Writable scratch | Fresh 8 MiB tmpfs, noexec/nosuid/nodev; 1 MiB private shared memory |
| Memory / swap | 128 MiB cgroup limit; no additional swap |
| CPU | 0.5 CPU quota and four CPU seconds per process |
| Processes / descriptors | 32 tasks and 128 descriptors per process |
| Files / core dumps | 1 MiB per file, no core dumps |
| Duration | Ten-second PID 1 watchdog, plus a host timer and cancellation |
| Input / output | 32 KiB fixed source; 64 KiB combined stdout/stderr before termination; no Docker log persistence |

The workload starts from an empty environment with explicit PATH, HOME, TMPDIR, XDG_CACHE_HOME, LANG, and `UV_USE_IO_URING=0`. The latter prevents Node's runtime initialization from changing the expected setting. Only the trusted Docker client reads its local user's Docker context.

The supervisor kills interrupted work, removes its container, and confirms deletion with a successful daemon listing before reporting cleanup as verified. A lost daemon connection is a cleanup failure, not success. A separate recovery command removes only this policy's named containers with elapsed host deadlines. The in-container watchdog stops hung work if the controller disappears; removal after an abrupt controller death still needs recovery. A malicious workload killing its own watchdog is outside this **owned-probe** checkpoint and requires an external production watchdog.

## Run the checks

Requires Node 24, a running local Linux Docker engine with cgroup v2 and builtin seccomp, and a previously available trusted `node:22` image. No `.env` is loaded by these commands.

```sh
npm run runner:doctor
npm run runner:check
npm run runner:cleanup
node --test tests/offline-host.test.ts
```

`runner:doctor` intentionally exits **2** while any customer runner gate is open. It prints only selected capabilities and gate codes, not daemon details or credentials. `runner:cleanup` only reaps expired offline containers; it does not prune Docker, touch PostgreSQL, or close browser demos.

The live check exercises actual denied TCP/UDP/IPv6/metadata-address connections inside a namespace with no route, a successful owned loopback exchange, cgroup limits and privilege restrictions, a real disk refusal, process refusal, OOM kill, file-size refusal, CPU throttling, fresh scratch across runs, host timeout, cancellation, output overflow and a detached hung fixture stopped by the independent timeout. The connection probes cannot send traffic to deployed services. All containers are removed after each check. Unit checks cover refusal paths and cleanup uncertainty. [Evidence](evidence/RUN-03.json).

## Remaining gates

The original macOS Docker engine offers `runc`; the dedicated Ubuntu development environment now has `runsc` and passes owned Chromium compatibility checks. OrbStack machines share a Linux kernel; the additional gVisor syscall boundary is exercised, but no customer host is registered and the complete `runner-host-v1` contract is not yet satisfied.

Before RUN-03 can be complete:

1. Extend the verified local gVisor/Chromium compatibility checkpoint with adversarial resource checks, an external watchdog and crash recovery. The two owned browser runs do not prove those production properties.
2. Make a host-controlled, origin-restricted proxy the browser's only egress path. Pin admitted IP addresses on actual connections, deny internal/metadata destinations and revalidate redirects. Retain an independent witness; no network assertion from the page can establish enforcement.
3. Bind dispatch, cancellation and expiry to the actual run grant/host contract, publish applicable resource limits, and safely collect bounded evidence after shutdown.
4. Run the owned invitation journey through this host and the existing evidence/replay workflow. Only then admit one explicitly authorized real preview and bounded journey.

No customer execution mode exists in this checkpoint. The doctor remains unready even if a runtime called `runsc` is registered: registration alone is not verification. Existing application admission, review and payment behavior is unchanged.

## Official references checked on 2026-11-01

- [Docker run](https://docs.docker.com/engine/containers/run/) documents container resource and privilege controls.
- [Docker none networking](https://docs.docker.com/engine/network/drivers/none/) documents a loopback-only network stack.
- [gVisor Docker integration](https://gvisor.dev/docs/user_guide/quick_start/docker/) documents explicit `runsc` runtime configuration.
- [Playwright Docker](https://playwright.dev/docs/docker) documents browser image setup and the separate Playwright package requirement. No browser image was installed for the offline checkpoint.
