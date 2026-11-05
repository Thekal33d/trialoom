/** The current hosted browser is a bounded read-only executor, not arbitrary agent code. */
export const homepageAction = 'Load the approved homepage with GET/HEAD';
export function supportsHostedTest(terms: { service: string; allowedActions: string[] }) {
  return (
    terms.service === 'test' &&
    terms.allowedActions.length === 1 &&
    terms.allowedActions[0] === homepageAction
  );
}
