import { createClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS. Only used server-side (API routes / middleware).
// Never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
