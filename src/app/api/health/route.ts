export function GET() {
  return Response.json(
    { status: 'ok', service: 'trialoom', mode: 'demo' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
