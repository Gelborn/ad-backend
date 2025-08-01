// functions/_lib/invite.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supaAdmin = createClient(Deno.env.get("SUPABASE_URL")!,
                               Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

export async function inviteUser(email: string, redirectTo: string) {
  const { data, error } = await supaAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });
  if (error) throw error;
  return data!;
}
