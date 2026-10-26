import { report } from '@/demo/data';
export function GET() {
  return Response.json(report, {
    headers: {
      'Content-Disposition': 'attachment; filename="trialoom-demo-report.json"',
      'Cache-Control': 'no-store',
    },
  });
}
