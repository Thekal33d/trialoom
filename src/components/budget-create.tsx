'use client';
import { useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Hex,
  parseEventLogs,
  parseUnits,
} from 'viem';
import { celo } from 'viem/chains';
import { allowanceCreateAbi, erc20ApproveAbi, remessoAllowance } from '@/domain/remesso-allowance';
import { settlementCurrency } from '@/domain/values';

type Step = 'idle' | 'connecting' | 'approving' | 'creating' | 'reading' | 'done';

const labels: Record<Step, string> = {
  idle: '',
  connecting: 'Waiting for your wallet…',
  approving: 'Approving the spending limit — confirm in your wallet',
  creating: 'Creating the budget — confirm in your wallet',
  reading: 'Reading the budget back from Celo…',
  done: 'Budget created.',
};

/**
 * Creates the builder's spending policy from their own wallet, in this page,
 * so setting a budget is not a trip to another product.
 *
 * Two transactions, both signed by the builder: an approval to the allowance
 * contract and the policy itself. Nothing is custodied and nothing is signed
 * on their behalf; this component only builds the calls and reads the result.
 */
export function BudgetCreate({
  agentAddress,
  onCreated,
}: {
  agentAddress: string;
  onCreated: (policyId: string) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState('');
  const [perPayment, setPerPayment] = useState('5');
  const [perDay, setPerDay] = useState('20');
  const [budget, setBudget] = useState('50');
  const [days, setDays] = useState('30');

  const busy = step !== 'idle' && step !== 'done';

  async function create() {
    setError('');
    try {
      const provider = (window as Window & { ethereum?: unknown }).ethereum;
      if (!provider) throw new Error('No wallet was found in this browser.');
      const amounts = {
        perPayment: parseUnits(perPayment, settlementCurrency.decimals),
        perDay: parseUnits(perDay, settlementCurrency.decimals),
        budget: parseUnits(budget, settlementCurrency.decimals),
      };
      if (amounts.perPayment <= 0n || amounts.perDay < amounts.perPayment)
        throw new Error('The daily limit has to be at least one payment.');
      if (amounts.budget < amounts.perDay)
        throw new Error('The total budget has to be at least one day.');
      const length = Number(days);
      if (!Number.isInteger(length) || length < 1 || length > 365)
        throw new Error('Choose between 1 and 365 days.');

      setStep('connecting');
      const wallet = createWalletClient({ chain: celo, transport: custom(provider as never) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error('No account was shared by the wallet.');
      if ((await wallet.getChainId()) !== celo.id) await wallet.switchChain({ id: celo.id });
      const chain = createPublicClient({ chain: celo, transport: custom(provider as never) });

      // The approval is shared by every policy this wallet has for this token,
      // so it is added to, not replaced; the policy's own caps are the limit
      // that matters per payment.
      setStep('approving');
      const approval = await wallet.writeContract({
        account,
        chain: celo,
        address: settlementCurrency.address as Hex,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [remessoAllowance.address as Hex, amounts.budget],
      });
      await chain.waitForTransactionReceipt({ hash: approval });

      setStep('creating');
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + length * 86_400);
      const created = await wallet.writeContract({
        account,
        chain: celo,
        address: remessoAllowance.address as Hex,
        abi: allowanceCreateAbi,
        functionName: 'createPolicy',
        args: [
          agentAddress as Hex,
          settlementCurrency.address as Hex,
          amounts.perPayment,
          amounts.perDay,
          expiresAt,
          false,
          [],
        ],
      });

      setStep('reading');
      const receipt = await chain.waitForTransactionReceipt({ hash: created });
      const events = parseEventLogs({
        abi: allowanceCreateAbi,
        eventName: 'PolicyCreated',
        logs: receipt.logs,
      });
      const policyId = events[0]?.args?.id;
      if (policyId === undefined)
        throw new Error('The budget was sent but its number could not be read. Check your wallet.');
      await onCreated(policyId.toString());
      setStep('done');
    } catch (cause) {
      setStep('idle');
      const message = cause instanceof Error ? cause.message : 'The budget could not be created.';
      // Wallet rejections are a choice, not a failure worth alarming language.
      setError(
        /rejected|denied|User denied/i.test(message) ? 'Cancelled in your wallet.' : message,
      );
    }
  }

  return (
    <div className="budget-create">
      <h3>Set a budget here</h3>
      <p>
        Your wallet approves a spending limit for Trialoom&rsquo;s payer. Your funds stay in your
        wallet until a test you accept is paid. You sign two transactions and pay their network
        fees; nothing else is approved.
      </p>
      <div className="budget-grid">
        <label>
          Per payment ({settlementCurrency.symbol})
          <input
            inputMode="decimal"
            value={perPayment}
            disabled={busy}
            onChange={(event) => setPerPayment(event.target.value)}
          />
        </label>
        <label>
          Per day
          <input
            inputMode="decimal"
            value={perDay}
            disabled={busy}
            onChange={(event) => setPerDay(event.target.value)}
          />
        </label>
        <label>
          Total budget
          <input
            inputMode="decimal"
            value={budget}
            disabled={busy}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        <label>
          Days
          <input
            inputMode="numeric"
            value={days}
            disabled={busy}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p className="product-note">{labels[step]}</p>}
      <button
        type="button"
        className="button primary"
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? 'Working…' : 'Create budget'}
      </button>
      <p className="product-note">
        Paid to Trialoom&rsquo;s payer {agentAddress.slice(0, 6)}…{agentAddress.slice(-4)} on Celo.
        You can revoke it at any time from your wallet.
      </p>
    </div>
  );
}
