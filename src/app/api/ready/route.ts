import { getPool } from '@/server/database';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const result = await getPool().query(`SELECT EXISTS (
      SELECT 1 FROM schema_migrations WHERE name = '0003_projects_terms.sql'
    ) AS ready`);
    if (!result.rows[0].ready) throw new Error('Migration required');
    return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json(
      { status: 'unavailable', code: 'DATABASE_NOT_READY' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
