import { createClient } from "@supabase/supabase-js";

const BUCKET = "sacs-payroll-store";

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let ensureBucketPromise = null;

async function ensureBucket(supabase) {
  // Memoize across requests in the same Lambda instance — the bucket is created
  // once and the existence check is a network round-trip we can skip thereafter.
  if (!ensureBucketPromise) {
    ensureBucketPromise = (async () => {
      const { data: existing } = await supabase.storage.getBucket(BUCKET);
      if (existing) return;
      await supabase.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: 104857600,
      });
      // Ignore error — bucket may have been created by a concurrent request or migration.
    })().catch(() => {
      // If the check itself failed, clear the cache so the next call can retry.
      ensureBucketPromise = null;
    });
  }
  return ensureBucketPromise;
}

export async function storageReadJson(filename, defaultValue = {}) {
  const supabase = getClient();
  if (!supabase) return defaultValue;

  try {
    await ensureBucket(supabase);
    const { data, error } = await supabase.storage.from(BUCKET).download(filename);
    if (error || !data) return defaultValue;
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return defaultValue;
  }
}

export async function storageWriteJson(filename, value) {
  const supabase = getClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  await ensureBucket(supabase);

  const json = JSON.stringify(value, null, 2);
  const { error } = await supabase.storage.from(BUCKET).upload(filename, json, {
    contentType: "application/json",
    upsert: true,
  });

  if (error) throw new Error(`Supabase Storage write failed: ${error.message}`);
}
