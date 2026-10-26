export function GET() {
  return Response.json(
    { status: 'ok', service: 'trialoom', mode: 'invited-alpha' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
