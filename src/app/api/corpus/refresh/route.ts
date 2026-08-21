import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { corpusStatus, refreshCorpus, processMemoryMb } from "@/lib/corpus";

/**
 * Force a corpus reload.
 *
 * The corpus refreshes on a 30-minute timer, which is fine for normal use — it
 * only changes when a crawl runs. This exists so the seed and enrichment
 * scripts can make new recipes appear immediately instead of waiting for the
 * timer or a redeploy.
 *
 * Auth-guarded like everything else: it's cheap, but it's a database sweep and
 * shouldn't be a free lever for anyone with the URL.
 */
export async function POST() {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;

  const started = Date.now();
  const ok = await refreshCorpus();

  return NextResponse.json(
    {
      ok,
      tookMs: Date.now() - started,
      corpus: corpusStatus(),
      rssMb: processMemoryMb(),
    },
    { status: ok ? 200 : 503 }
  );
}

/** Status without triggering work — useful while testing. */
export async function GET() {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  return NextResponse.json({ corpus: corpusStatus(), rssMb: processMemoryMb() });
}
