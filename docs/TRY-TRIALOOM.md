# Try Trialoom locally

PRACTICE-01 · 2026-10-30 · Prepared sample, real workspace screens.

## Open the sample

After the [first-run setup](DEVELOPMENT.md), with Docker running:

```sh
npm run db:up
npm run browser:install  # first time only
npm run build           # after application changes
npm run playground
```

The launcher opens a visible Chromium window with three tabs: a guide, a controlled invitation app, and Trialoom already signed in as a practice owner. It chooses available loopback ports and prints the workspace address. Use the opened window: another browser will not have its sign-in session or the invitation fixture's access header.

The workspace is **Practice workspace — sample data**, with **Canopy — sample invitation app** selected. Leave the command running while you explore. No real owner account or invitation is needed.

## Your first test

1. In the **Trialoom invitation fixture** tab, send an invitation to `teammate@example.test`. You should see **Invitation created.** Then try `teammate+qa@example.test`. It incorrectly says **Enter a valid email address.** This is the sample bug; no emails are sent. Reusing an already successful address reports that it was already invited.
2. In the **Trialoom** tab, find **Test teammate invitations — sample findings**. Under **Execution and evidence**, inspect the product failure and open a redacted report.
3. Under **Reports and decisions**, find **practice-submitter · execution not decided**. Keep **Accept the execution** selected, enter a reason such as “Practice review of the supplied sample,” and click **Record decision**. The decision appears in the history and survives reloading the page and reopening Canopy. The sample 2.00 USDC fee becomes owed; payment stays blocked because there is no payout wallet.
4. Click **Export this brief** to download its ZIP. Explore **What's waiting** in the sidebar and the other seeded briefs when ready.

The manual invitation test and the seeded workspace reports are separate. Your manual clicks are **not automatically submitted as agent evidence**. This walkthrough checks the review workflow; it does not establish acceptance of real operator work.

## What is real and what is prepared

The running application uses its normal sign-in, authorization, database, review decisions, redaction, ledger, and export routes. The invitation fixture really executes requests and contains a deliberate plus-address validation bug.

The accounts, reports, independent-operator identities, repair results, resource receipts, and financial amounts in the practice workspace are seeded examples. Binary trace files are placeholders used by the existing evidence tests; the app withholds them from review/export. The example target URLs are metadata, not live customer targets. No hosted agent executes a campaign, no external resource is purchased, and no real payment is sent. This is not evidence of independent human verification or hackathon eligibility.

The launcher creates a separate, randomly named test database and private files under ignored `artifacts/playground/`. It uses a fresh authentication secret, clears inherited signer/payment-recipient settings, starts no worker, and restricts browser requests to its two loopback servers. It does not change the existing `trialoom_dev` records, owner invitation, or `.env`.

Closing the practice browser or pressing Ctrl-C stops its servers and removes its disposable database and temporary files. A forced process kill or machine crash cannot run cleanup. Downloads use Chromium's temporary storage; copy an export somewhere you want to keep it before ending the session. Run `npm run playground` again for a fresh sample. If you sign out, restart the session to be signed in automatically again.

## Repeatable verification

```sh
npm run playground -- --smoke
```

This uses the same launcher headlessly, verifies the actual invitation fixture's 201/400 responses, reads redacted evidence, records a practice execution decision, reloads to verify persistence, checks the blocked payable, downloads and inspects the ZIP, and removes its disposable database/files. On 2026-10-30 this passed; the existing desktop evidence suite also passed all ten checks. No production application routes were added for practice access.

On 2026-10-31 the user reported completing the prepared walkthrough and that things worked. No specific failing steps were reported. This records user feedback on the sample; it does not establish real agent execution, independent verification, or payment readiness.
