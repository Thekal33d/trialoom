# Local preview recovery

The trusted controller journals one execution identity per issued run in PostgreSQL. Its container names are recorded before dispatch, and it persists a private capture before uploading any witness or evidence. A fresh controller reconciles the existing delivery; it does not start a second browser for an uncertain run.

## State and recovery

| Journal phase | Meaning | Restart behavior |
| --- | --- | --- |
| prepared | Identity recorded; dispatch has not begun | Check live permissions, then record dispatch intent before creating host resources |
| dispatching | Browser may have started; complete capture is not recorded | Remove the exact recorded containers/channel and mark interrupted; require explicit operator handling for another run |
| captured | Browser output and frozen independent witness are durably saved | Remove any remaining host resources, validate the capture hash and reconcile delivery |
| delivered | Application submission is confirmed | Return its original delivery receipt after checking the stored submission hash; no new execution or write |
| interrupted | Execution ended without a complete saved capture | Keep the record and commitment; refuse redispatch of that run |

The journal fixes the image, mode, journey and application origin with a configuration hash. A database session advisory lock excludes competing controllers. Losing that connection aborts the active controller. Database constraints and transition guards keep the run identity, capture hash and completed receipt immutable and prevent progress from moving backwards. Each update also checks its expected phase.

Container and volume cleanup uses the recorded generated prefix and checks the ownership policy label. Recovery does not sweep unrelated runs. Once armed, the existing host-owned timer remains independent of the controller. Cleanup never accepts evidence, abandons an assignment, releases a commitment or creates a payable.

## Capture and delivery

The capture holds the validated run view, browser output and frozen witness. A bounded private file is written with mode 0600 under a 0700 directory, synced, renamed to its content hash and followed by a directory sync before the database records the reference. Reads reject symlinks, excessive size and hash mismatch. A crash before the database reference commits may leave an unreferenced private file; it cannot be used to claim a completed capture. Raw captures remain outside Git and product downloads.

Run/host credentials and the ephemeral TLS key are never written to this journal. A recovery caller must supply its credentials again through the trusted controller. The browser and proxy still receive neither application credential.

Delivery uses the original frozen witness batch and identical artifact bytes. Authoritative application records are read before retrying: an already uploaded artifact must match its name, kind, media type, length and hash. An existing submission must match the canonical evidence hash. Otherwise recovery refuses. All new witness/artifact/evidence writes still use the existing authenticated HTTP routes and live run/host checks. Expired or revoked permission cannot authorize a new delivery. A completed submission can be recognized after its grant closes without reopening it; the delivery receipt does not assert the current review or payment decision.

## Run the controlled check

With the local database, dedicated runner and an existing application build available:

```sh
npm run runner:recovery-check
```

The check uses only the network-disabled owned ladder fixture and disposable databases. It sends real SIGKILL to the controller at dispatch intent, active browser execution, durable capture, witness acknowledgement, first artifact acknowledgement and submission acknowledgement. Additional cases corrupt a capture, create a conflicting artifact, expire the grant or revoke the host after capture. Each restart is a fresh Node process; the test checks cleanup, exact submission/artifact/batch counts, unchanged reserved units and zero decisions/payables. It also attempts a competing controller while the original still owns the run. The raw child streams and credentials are not logged.

The existing `browser:preview` launcher also uses the journal. Its normal disposable-session cleanup deletes that session's database, private evidence and captures. The crash check preserves a small ignored summary and removes its test database and raw data.

On 2026-11-01 all ten crash cases passed with fresh-process recovery or the expected refusal, verified container/channel cleanup, unchanged 2,000,000-unit fixture commitments and no decisions/payables. Fifty focused database tests passed, including loss of the journal-owning connection, competing controllers and immutable capture/progress checks. The owned replay/ladder controls and existing timer/active permission checks passed. A separate command regression proves that a host CLI ignoring SIGTERM is killed at its deadline: an earlier validation cleanup exposed Orb hanging past its timeout, so synchronous host commands now use SIGKILL on expiry. The full rerun exited successfully after cleanup. See the [checkpoint](evidence/RUN-03-recovery.json). Application source and the isolated browser/proxy image are unchanged; the existing production build is reused.

## Boundaries

This is local controller recovery with PostgreSQL and the same private filesystem available. It is not a durable scheduler, an automatic restart service or a remotely hosted worker. The controller uses trusted local database access for journal ownership and delivery reconciliation; production service roles and remote recovery APIs remain to be designed. A new application origin or image requires deliberate handling rather than silently rebinding the old run.

Whole-machine power loss, database/storage loss, Docker daemon failure/reboot, automated orphan-file retention and recovery after credential loss remain separate gates. Captures whose permissions have expired remain private and undeliverable; there is no extension of a grant. Adversarial resource testing, PILOT-01 and independent participants also remain open.
