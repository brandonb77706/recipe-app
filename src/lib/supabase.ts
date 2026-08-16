import "server-only";

import { createClient } from "@supabase/supabase-js";

// Service role key — bypasses RLS entirely. The `server-only` import above
// turns any client-component import of this file into a build error.
export const supabase = createClient(
  (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  process.env.SUPABASE_SERVICE_KEY!
);
