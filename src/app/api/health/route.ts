import { freeTestsEnabled } from '@/server/free-tests';
import { signupEnabled } from '@/server/signup';

// Liveness only: an orchestrator uses this to decide whether to restart the
// process, so it must not touch the database. /api/ready is the traffic gate.
//
// The mode is read from this deployment's configuration rather than written
// down here. A hardcoded label is a claim about the release that a container
// started with different settings would quietly make false.
export function GET() {
  return Response.json(
    {
      status: 'ok',
      service: 'trialoom',
      mode: signupEnabled() ? 'public-beta' : 'invited-alpha',
      testing: freeTestsEnabled() ? 'enabled' : 'unavailable',
      // Reported so the claim is checkable from outside rather than trusted.
      // A host that mounts storage as root may start this process privileged;
      // the container entrypoint drops back, and this says whether it did.
      privileged: process.getuid?.() === 0,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
