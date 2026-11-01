# Isolated preview execution

RUN-03 now has a local controller connecting a real assignment to isolated Chromium, a separate proxy witness and the existing evidence/replay UI. This is a fixed read-only journey in a disposable workspace, with no payment authority. It is not an autonomous hosted service or a production-readiness claim.

## Try it

Start the existing local database and dedicated runner, then build the app:

```sh
npm run db:up
orb start trialoom-runner
npm run build
npm run browser:preview
```

The owned HTTPS sample opens in a fresh gVisor browser, loads its homepage and follows its navigation link. A separate signed-in local browser opens Trialoom's recorded replay. Close that window or press Ctrl-C to end the session. The test database and raw evidence are removed; the bounded result and replay screenshot remain private under ignored `artifacts/preview-runs/`.

`npm run browser:preview -- --smoke` checks the external host timer, real HTTP ingestion, replay, pending review, zero payables, and active interruption on abandonment, release, expiry and host revocation. `--blokaz` selects the user's authorized `https://www.blokaz.xyz/` homepage through normal public project/build admission. It permits no account, wallet, staking or form action. Third-party origins are refused; denied requests produce a blocked result, not a product defect. There is no arbitrary URL option.

## Trust and limits

The trusted controller holds the run grant and independent host credential. Neither enters the browser, proxy, image, page traffic or trace. The proxy gets only the server-issued target/address pins and an ephemeral TLS identity. The browser gets the target, fixed journey, time/navigation bounds and public certificate pin. The controller compares the host view with the run manifest, polls both every 500 ms with a 3-second request timeout, stops on refusal/outage, and rechecks before each write.

The browser uses `runsc-preview`, no external network, read-only root, non-root UID, dropped capabilities and one read-only socket channel. Memory is 1 GiB without extra swap, processes 256, CPU one core, scratch 128 MiB, shared memory 64 MiB, open files 1024 and individual files 16 MiB. The browser journey is at most 45 seconds and respects shorter manifest/lease limits. A root-owned systemd timer outside both containers removes the browser, broker and channel by the supervisor deadline (at most 55 seconds for application dispatch). The 70-second in-container timeout remains a fallback. The timer is independent of the Mac process; whole-machine/daemon failure and reboot reconciliation are still production gates. [Official systemd-run timer documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), checked 2026-11-01.

The owned broker is network-disabled and serves a closed HTTPS fixture on loopback. Its logical TLS name and real `127.0.0.1` admission address are recorded under `offline-owned-proxy-fixture-v1` in a disposable database. It never passes a fake public address through normal target admission. The public broker has outbound networking, revalidates all DNS addresses against the manifest, connects to checked IP literals and verifies upstream TLS. Only the isolated browser receives target scripts. The existing restricted proxy budgets and GET/HEAD-only policy apply in both modes.

The browser returns JSON and a trace through a pipe capped at 12 MiB. No archive is extracted and no path is taken from sandbox output. The controller validates the report, enforces the app's 8 MiB per-artifact and 32 MiB total bounds, freezes the separate proxy, and reads its private snapshot. A batch receipt must be acknowledged before evidence submission; identical retries are safe and changed batches fail. Unknown denied destinations remain anonymous. A blocked run may report zero contacted origins with a host receipt; executed/product-failure reports may not.

Raw traces stay in the private evidence store. The existing sanitizer rebuilds supported traces into metadata-only downloads. Replay displays the actual steps, assertions and sanitized actions/HTTP statuses. Submission remains pending review, retains its accounting reservation and creates no payable. This is not independent reproduction or acceptance.

## Remaining gates

- Operate a durable dispatcher, per-run recovery records and reboot/daemon-failure reconciliation; transient timers do not survive every infrastructure failure.
- Exercise adversarial resource exhaustion under this full gVisor/proxy topology, beyond the earlier offline controls and current applied-limit checks.
- Add explicitly authorized journeys, dependencies and authentication fixtures; never silently broaden the origin/method allowlist.
- Obtain a verifiable deployed revision for a real target. A missing revision header remains visibly unconfirmed.
- Complete PILOT-01 operations/privacy/security, independent participants and separate funded-payment authorization before a production pilot.
