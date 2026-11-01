# Dedicated local gVisor environment

This is a development environment for RUN-03, created on 2026-11-01. It is separate from the existing macOS Docker context, PostgreSQL and visible browser demos. It has no customer credentials, workspace data or payment keys. It is not a deployed customer runner.

## Setup

The following machine was created through the installed OrbStack CLI:

```sh
orb create --isolated --isolate-network --memory 2G --cpus 2 --disk 12G --user runner ubuntu:24.04 trialoom-runner
orb -m trialoom-runner -u root -w /root bash -s < runners/setup-local-gvisor.sh
orb -m trialoom-runner -u root -w /root docker pull node:24-bookworm-slim
```

Do not repeat `orb create` over an existing machine. The bootstrap refuses a different hostname, distribution, Mac mount or forwarded SSH agent. It installs Ubuntu's Docker package and gVisor from its official signed apt repository, then explicitly registers `runsc` without overwriting an existing runtime entry or downloading additional helper binaries outside the signed package. Only the dedicated machine's Docker daemon is restarted. Its Docker storage uses VFS with the containerd snapshotter disabled: nested overlayfs returned `Invalid cross-device link` during package-directory replacement. The bootstrap refuses to hide an existing overlay image store; during this setup the public Node image was explicitly saved, loaded into VFS and rebound to its original registry digest. VFS uses more disk space and is a local compatibility choice, not the production storage recommendation.

Observed configuration: Ubuntu 24.04/arm64; isolated integration and network isolation enabled; SSH forwarding disabled; CPU limit 2; memory limit 2048 MiB; disk quota 12 GiB. Memory and CPU caps were also read from the guest's cgroup. `/mnt/mac` was absent and `SSH_AUTH_SOCK` was unset. gVisor version `release-20261026.0`, Docker `29.1.3`, and the default systrap platform were installed. A non-root, read-only, network-disabled, resource-bounded container successfully returned Node `v24.22.2` under `runsc` and was removed afterward.

OrbStack isolated machines still share its Linux kernel. gVisor provides the additional syscall boundary being evaluated here. Neither installing a runtime nor passing a compatibility check establishes production readiness.

## Owned browser compatibility check

```sh
orb start trialoom-runner
npm run runner:gvisor-check
```

The harness resolves the cached official Node image to its registry digest and copies only the pinned Playwright 1.64.1 package, the existing owned invitation fixture, and the reviewed browser check into a fresh disposable build context. It does not copy the repository or `.env`. A Chromium-headless-shell toolchain is installed from Playwright's supported installer, with public package access during **toolchain construction only**. Test execution then uses an immutable local image ID and explicitly requires `runsc`; it cannot fall back to `runc`.

Each run has no external network, a read-only root and an explicit read-only 1 MiB `/tmp`, UID/GID 65534, no capabilities, no-new-privileges, fresh 128 MiB scratch and 64 MiB shared memory, 1 GiB memory/no additional swap, one CPU, host and guest process limits, file/descriptor bounds, a 45-second internal deadline and a 50-second controller timeout. Results are capped at 64 KiB. The only website is the existing invitation fixture in that same isolated namespace. Chromium's own sandbox is disabled for this compatibility harness; `runsc` is the required outer boundary.

The check passed two fresh runs with Chromium `156.0.8078.4`: actual invitation responses 201 and 400, empty storage, a failed direct external connection, rejected writes to both the root filesystem and `/tmp`, bounded traces and verified container removal. Host-side inspection also confirmed the selected runtime, memory/swap, CPU, process and privilege configuration. This verifies applied settings and browser compatibility, not adversarial exhaustion of each limit under gVisor. [Recorded evidence](evidence/RUN-03-gvisor.json). Traces remain ephemeral in the sandbox; only their digest and size leave it. No evidence is submitted to the workspace, no witness host is registered, and no work is accepted or paid. The production proxy, live grant dispatch, resource enforcement under adversarial guest workloads and crash-resistant host watchdog remain open.

An attempted full Playwright image download was stopped after slow progress; this check uses the smaller Chromium-only toolchain. The first Node image download was interrupted by the dedicated daemon restart and was resumed successfully. Two Chromium-toolchain attempts also failed on nested overlayfs directory renames; the VFS retry addresses that observed error. The first browser run then caught an implicit writable `/tmp` added by gVisor despite the read-only root; explicitly mounting `/tmp` read-only fixed the observed failure. The check continues to require actual EROFS refusals rather than relying only on configuration. These failed attempts do not count as passing isolation evidence.

## Stop and resume

```sh
orb stop trialoom-runner
orb start trialoom-runner
```

Stopping the machine releases its running resources while preserving installed tooling. These commands affect only the dedicated test machine. The offline `runner:check` and `runner:doctor` commands still inspect the original macOS Docker context; they do not silently switch to this environment. An abrupt controller death may leave stopped containers in the dedicated daemon; production recovery is not established by this harness.

The dedicated machine was stopped after final validation on 2026-11-01; tooling and the verified image remain available. No test containers remained, and the temporary public-image migration archive was removed.

Official sources checked on 2026-11-01: [gVisor installation](https://gvisor.dev/docs/user_guide/install/), [gVisor platforms](https://gvisor.dev/docs/user_guide/platforms/), [OrbStack isolated machines](https://docs.orbstack.dev/machines/isolated), [Docker VFS](https://docs.docker.com/engine/storage/drivers/vfs-driver/), [Docker image-store switching](https://docs.docker.com/engine/storage/containerd/), [gVisor temporary-directory behavior](https://github.com/google/gvisor/issues/14474), and [Playwright headless-shell installation](https://playwright.dev/docs/browsers#chromium-headless-shell).
