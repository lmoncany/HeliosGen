import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";

export async function getAzureKeyForUser(userId: string): Promise<string | null> {
  if (GUEST_MODE) {
    const { getAzureApiKey } = await import("./guest/db");
    return getAzureApiKey();
  }
  const { data } = await supabaseAdmin
    .from("user_settings")
    .select("azure_api_key")
    .eq("user_id", userId)
    .single();
  return data?.azure_api_key ?? null;
}
