import { canonicalDomain } from '../core/urls.ts';
import type { Fetcher } from '../core/http.ts';
import { cleanLine } from '../core/hebrew.ts';
import { type Db, J } from '../db/index.ts';
import { detect, type Detection } from './detect.ts';
import { scoreStore, type Score } from './score.ts';
import { addToFrontier, type Candidate } from './sources.ts';
import { markSeen, saveLead, seen } from './store.ts';

// One discovery run: candidates in, leads out.
//
// For each candidate: canonical domain -> already seen? skip (seen is permanent:
// a domain rejected once is never fetched again) -> detect -> score -> a store is
// saved as a lead (qualified or not, with its reasons); anything else is remembered
// as rejected. A qualified store's outbound links join the crawl frontier.
//
// Candidates run a few at a time; the fetcher keeps each host to one request at a
// time, so concurrency only overlaps different stores.

export type RunStats = { candidates: number; skipped: number; leads: number; qualified: number; merged: number; rejected: number; failed: number; byReason: Record<string, number> };
export type RunResult = { stats: RunStats; leads: { id: number; domain: string; score: number; qualified: boolean; reject: string | null }[] };

export async function discover(
  db: Db,
  candidates: AsyncIterable<Candidate>,
  { fetcher, render, limit = 50, concurrency = 4, log = () => {}, crawlDepth = 1 }: { fetcher: Fetcher; render?: (url: string) => Promise<string | null>; limit?: number; concurrency?: number; log?: (m: string) => void; crawlDepth?: number },
  source = 'mixed',
): Promise<RunResult> {
  const run = await db.one<{ id: number }>('INSERT INTO discovery_runs (source) VALUES ($1) RETURNING id', [source]);
  const stats: RunStats = { candidates: 0, skipped: 0, leads: 0, qualified: 0, merged: 0, rejected: 0, failed: 0, byReason: {} };
  const leads: RunResult['leads'] = [];
  const inFlight = new Set<string>();
  const workers = new Set<Promise<void>>();
  const reason = (r: string) => (stats.byReason[r] = (stats.byReason[r] || 0) + 1);

  async function one(c: Candidate, domain: string) {
    let d: Detection;
    try {
      d = await detect(c.url, { fetcher, render });
    } catch (e: any) {
      stats.failed++;
      reason(`fetch: ${e.code || 'error'}`);
      await markSeen(db, domain, 'failed', cleanLine(e.message, 200));
      log(`  ✗ ${domain}: ${e.code || e.message}`);
      return;
    }
    // A redirect can land on a domain we already have (a brand's second domain).
    if (d.domain !== domain && (await seen(db, d.domain))) {
      stats.skipped++;
      await markSeen(db, domain, 'rejected', `redirects to ${d.domain}`);
      return;
    }
    const s: Score = scoreStore(d);
    // Only Israeli stores become leads; a foreign site the crawl wandered to is remembered as rejected, not listed.
    const isStore = (d.platform !== 'unknown' || (d.productCount ?? 0) > 0) && s.reject !== 'not an Israeli Hebrew store';
    if (!isStore) {
      stats.rejected++;
      reason(s.reject || 'not a store');
      await markSeen(db, domain, 'rejected', s.reject);
      log(`  · ${domain}: ${s.reject}`);
      return;
    }
    const saved = await saveLead(db, d, s, c.source, c.detail);
    if (!saved.created) stats.merged++;
    else stats.leads++;
    if (s.qualified) stats.qualified++;
    else reason(s.reject || `score under the bar`);
    leads.push({ id: saved.id, domain: d.domain, score: s.score, qualified: s.qualified, reject: s.reject });
    if (s.qualified && crawlDepth > 0) await addToFrontier(db, d.domain, d.home.externalLinks, Number(c.detail.depth || 0) + 1);
    log(`  ${s.qualified ? '✓' : '–'} ${d.domain} ${d.platform} ${s.score}${s.reject ? ` (${s.reject})` : ''}${saved.created ? '' : ` [merged by ${saved.mergedBy}]`}`);
  }

  for await (const c of candidates) {
    if (stats.leads + stats.merged >= limit) break;
    stats.candidates++;
    const domain = canonicalDomain(c.url);
    if (!domain || inFlight.has(domain) || (await seen(db, domain))) {
      stats.skipped++;
      continue;
    }
    inFlight.add(domain);
    const w: Promise<void> = one(c, domain).finally(() => workers.delete(w));
    workers.add(w);
    if (workers.size >= concurrency) await Promise.race(workers);
  }
  await Promise.all(workers);
  await db.query('UPDATE discovery_runs SET finished_at = now(), stats = $2::jsonb WHERE id = $1', [run!.id, J(stats)]);
  return { stats, leads };
}
