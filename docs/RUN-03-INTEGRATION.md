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

`npm run browser:preview -- --smoke` checks the external host timer, real HTTP ingestion, replay, pending review, zero payables, and active interruption on abandonment, release, expiry and host revocation. `--blokaz` selects the user's authorized `https://www.blokaz.xyz/` homepage through normal public project/build admission. It permits no account, wallet, staking or form action. The user approved Google Fonts stylesheet/font loading on 2026-11-01: this fixture now pins `https://fonts.googleapis.com` and `https://fonts.gstatic.com` as read-only dependencies in its immutable terms. Other origins remain refused. Denied requests produce a blocked result, not a product defect. There is no arbitrary URL option.

## Trust and limits

The trusted controller holds the run grant and independent host credential. Neither enters the browser, proxy, image, page traffic or trace. The proxy gets only the server-issued target/address pins and an ephemeral TLS identity. The browser gets the target, fixed journey, time/navigation bounds and public certificate pin. The controller compares the host view with the run manifest, polls both every 500 ms with a 3-second request timeout, stops on refusal/outage, and rechecks before each write.

The browser uses `runsc-preview`, no external network, read-only root, non-root UID, dropped capabilities and one read-only socket channel. Memory is 1 GiB without extra swap, processes 256, CPU one core, scratch 128 MiB, shared memory 64 MiB, open files 1024 and individual files 16 MiB. The browser journey is at most 45 seconds and respects shorter manifest/lease limits. A root-owned systemd timer outside both containers removes the browser, broker and channel by the supervisor deadline (at most 55 seconds for application dispatch). The 70-second in-container timeout remains a fallback. The timer is independent of the Mac process; whole-machine/daemon failure and reboot reconciliation are still production gates. [Official systemd-run timer documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), checked 2026-11-01.

The owned broker is network-disabled and serves a closed HTTPS fixture on loopback. Its logical TLS name and real `127.0.0.1` admission address are recorded under `offline-owned-proxy-fixture-v1` in a disposable database. It never passes a fake public address through normal target admission. The public broker has outbound networking, revalidates all DNS addresses against the manifest, connects to checked IP literals and verifies upstream TLS. Only the isolated browser receives target scripts. The proxy preserves an incoming CORS Origin only when it exactly matches the manifest’s primary page origin; arbitrary origins and credentials are not forwarded. Both modes permit GET/HEAD only, omit request cookies/authorization and strip response cookies. Each response including headers is capped at 2 MiB, total response bytes at 8 MiB, connections at 64 total / 8 simultaneous, requests at 100 and request metadata at 2 MiB. The proxy records the first exhausted limit and its numeric maximum/observed values; replay separates resource limits from scope denials.

The browser returns JSON and a trace through a pipe capped at 12 MiB. No archive is extracted and no path is taken from sandbox output. The controller validates the report, enforces the app's 8 MiB per-artifact and 32 MiB total bounds, freezes the separate proxy, and reads its private snapshot. A batch receipt must be acknowledged before evidence submission; identical retries are safe and changed batches fail. Unknown denied destinations remain anonymous. A blocked run may report zero contacted origins with a host receipt; executed/product-failure reports may not.

The initial Blokaz check loaded HTTP 200 but encountered the old response cap and two font denials. After the explicit font approval and reviewed cap, the dependency checkpoint forwarded 24 responses across the three approved origins, including all three font stylesheets and two font files, with no budget exhaustion. Its replay contains five browser actions and 42 request records, including 18 with no HTTP response. There were 21 denied CONNECT attempts to additional backend/auth/RPC services; connection counts and browser request counts are different measurements. The homepage step passed, overall scope remains blocked, and the deployed revision is unconfirmed. [Dependency checkpoint](evidence/RUN-03-dependencies.json).

Raw traces stay in the private evidence store. The existing sanitizer rebuilds supported traces into metadata-only downloads. Replay displays the actual steps, assertions and sanitized actions/HTTP statuses. Submission remains pending review, retains its accounting reservation and creates no payable. This is not independent reproduction or acceptance.

## Approving dependencies

The brief editor accepts up to seven exact HTTPS dependency origins, separately from its testing target, and requires witnessed isolation. They are supporting GET/HEAD resources; this does not authorize account actions or another top-level test journey. The approved list participates in the immutable terms content hash. A later scope revision does not modify an existing claim.

Before issuing a run, Trialoom resolves every approved dependency and rejects all private/reserved/mixed DNS answers. The run manifest pins each dependency's addresses and GET/HEAD methods. The controller checks the full list against the manifest; the broker admits exactly that list, rechecks DNS against the pins and verifies upstream TLS for each hostname. The browser reports responses from all admitted origins, and the separate witness checks them during ingestion. The primary target's redirect and revision checks remain separate.

The initial Blokaz blocks were two Google Fonts stylesheets and a first-party script measuring 1,310,116 bytes by a bounded HEAD read. That script exceeds the previous 1 MiB cap and fits the reviewed 2 MiB envelope. Font permission was explicitly requested and granted separately. The driver now waits for page load and font readiness within the same run deadline. This still proves only the bounded homepage journey, not login, gameplay, wallet or staking behavior.

Remaining attempts include Web3Auth GET, a Supabase backend GET and POSTs to `forno.celo.org` / `1rpc.io`. None is approved by the font permission. A later private review resolved the `_file` body resources and identified `eth_call` in all 16 recorded RPC requests. Any future RPC adapter still needs approved methods/parameters with the same DNS, TLS and resource controls. No blanket POST/origin expansion follows from this result.

## Exact API reads and excluded services

The brief editor now also accepts exact API GET URLs and explicitly blocked service origins. Exact reads require the literal path/query and forbid redirects; the combined supporting-origin bound is unchanged. Declared excluded services are blocked without DNS or upstream contact, recorded anonymously and reported as untested. They do not invalidate a completed journey within its approved scope. Any unexpected denial, failed assertion or exhausted budget still blocks the result. Earlier runs retain their original scope and outcome. The [public ladder journey](RUN-03-LADDER.md) is approved and has passed local controls. Live submission remains blocked by a required first-party script failing upstream; a subsequent startup failure also remains unresolved. The API contract and CORS forwarding were corrected, but no browser count agreement is claimed. [Live evidence](evidence/RUN-03-ladder-live.json).

## Remaining gates

- Operate a durable dispatcher, per-run recovery records and reboot/daemon-failure reconciliation; transient timers do not survive every infrastructure failure.
- Exercise adversarial resource exhaustion under this full gVisor/proxy topology, beyond the earlier offline controls and current applied-limit checks.
- Add explicitly authorized journeys, dependencies and authentication fixtures; never silently broaden the origin/method allowlist.
- Obtain a verifiable deployed revision for a real target. A missing revision header remains visibly unconfirmed.
- Complete PILOT-01 operations/privacy/security, independent participants and separate funded-payment authorization before a production pilot.
