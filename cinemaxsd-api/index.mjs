import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

const SOURCE_URL = process.env.MUNOPIX_API_URL || "https://85.190.254.61/munopix/browse_api.php";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-sync-token", "cache-control": "no-store" }
});
const text = (v) => typeof v === "string" ? v.trim() : v == null ? "" : String(v);
const arr = (v) => Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(",").map(x => x.trim()).filter(Boolean);
const stableId = (item) => text(item.id || item.content_id || item.movie_id || item.slug || item.stream_link || item.url) ||
  createHash("sha256").update([text(item.contentType || item.type || "movie"), text(item.title), text(item.year), text(item.poster)].join("|").toLowerCase()).digest("hex");

async function ensureDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.cinemaxsd_content (
    id BIGSERIAL PRIMARY KEY, source_id TEXT UNIQUE, title TEXT NOT NULL, description TEXT, poster TEXT, backdrop TEXT,
    content_type TEXT NOT NULL DEFAULT 'movie', year INTEGER, genres JSONB NOT NULL DEFAULT '[]'::jsonb,
    vjs JSONB NOT NULL DEFAULT '[]'::jsonb, tags JSONB NOT NULL DEFAULT '[]'::jsonb, stream_link TEXT,
    episodes JSONB NOT NULL DEFAULT '[]'::jsonb, raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_updated_at TIMESTAMPTZ, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS public.cinemaxsd_sync_runs (
    id BIGSERIAL PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
    pages_fetched INTEGER NOT NULL DEFAULT 0, items_seen INTEGER NOT NULL DEFAULT 0, items_upserted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running', error TEXT
  )`);
}

function authorized(req) {
  if (!SYNC_TOKEN) return false;
  const supplied = req.headers.get("x-sync-token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const a = Buffer.from(supplied), b = Buffer.from(SYNC_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function importItem(item) {
  const title = text(item.title || item.name);
  if (!title) return false;
  const kindRaw = text(item.contentType || item.type || "movie").toLowerCase();
  const kind = /series|show|tv|episode/.test(kindRaw) ? "series" : "movie";
  const yearNum = Number.parseInt(item.year, 10);
  const year = Number.isFinite(yearNum) && yearNum >= 1800 && yearNum <= 2200 ? yearNum : null;
  const result = await pool.query(`
    INSERT INTO public.cinemaxsd_content
      (source_id,title,description,poster,backdrop,content_type,year,genres,vjs,tags,stream_link,episodes,raw,source_updated_at,imported_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,NOW(),NOW(),NOW())
    ON CONFLICT (source_id) DO UPDATE SET
      title=EXCLUDED.title, description=EXCLUDED.description, poster=EXCLUDED.poster, backdrop=EXCLUDED.backdrop,
      content_type=EXCLUDED.content_type, year=EXCLUDED.year, genres=EXCLUDED.genres, vjs=EXCLUDED.vjs,
      tags=EXCLUDED.tags, stream_link=EXCLUDED.stream_link, episodes=EXCLUDED.episodes, raw=EXCLUDED.raw,
      source_updated_at=NOW(), updated_at=NOW()
    RETURNING id`, [
      stableId(item), title, text(item.description), text(item.poster || item.poster_url), text(item.backdrop || item.backdrop_url),
      kind, year, JSON.stringify(arr(item.genres)), JSON.stringify(arr(item.vjs || item.vj)),
      JSON.stringify(arr(item.tags)), text(item.stream_link || item.link || item.url),
      JSON.stringify(Array.isArray(item.episodes) ? item.episodes : []), JSON.stringify(item)
    ]);
  return result.rowCount > 0;
}

async function syncContent() {
  const run = await pool.query("INSERT INTO public.cinemaxsd_sync_runs(status) VALUES ('running') RETURNING id");
  const runId = run.rows[0].id;
  let page = 1, pagesFetched = 0, itemsSeen = 0, itemsUpserted = 0;
  try {
    for (; page <= 500; page++) {
      const url = new URL(SOURCE_URL);
      url.searchParams.set("page", String(page));
      url.searchParams.set("perPage", "100");
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error("Upstream returned HTTP " + response.status);
      const body = await response.json();
      if (body.success === false) throw new Error(text(body.message || "Upstream API reported failure"));
      const items = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : [];
      pagesFetched++;
      itemsSeen += items.length;
      for (const item of items) if (await importItem(item)) itemsUpserted++;
      const totalPages = Number(body.totalPages || body.total_pages || 0);
      if (!items.length || (totalPages && page >= totalPages) || (!totalPages && items.length < 100)) break;
    }
    await pool.query("UPDATE public.cinemaxsd_sync_runs SET finished_at=NOW(),pages_fetched=$1,items_seen=$2,items_upserted=$3,status='success' WHERE id=$4", [pagesFetched,itemsSeen,itemsUpserted,runId]);
    return { success: true, pagesFetched, itemsSeen, itemsUpserted };
  } catch (error) {
    await pool.query("UPDATE public.cinemaxsd_sync_runs SET finished_at=NOW(),pages_fetched=$1,items_seen=$2,items_upserted=$3,status='failed',error=$4 WHERE id=$5", [pagesFetched,itemsSeen,itemsUpserted,String(error?.message || error).slice(0,1000),runId]);
    throw error;
  }
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-sync-token" } });
    await ensureDb();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/health") {
      const db = await pool.query("SELECT NOW() AS database_time, (SELECT COUNT(*) FROM public.cinemaxsd_content) AS content_count");
      return json({ success: true, service: "CinemaxSD", database: "connected", contentCount: Number(db.rows[0].content_count), databaseTime: db.rows[0].database_time });
    }
    if (path === "/api/sync" && req.method === "POST") {
      if (!authorized(req)) return json({ success: false, error: "Unauthorized. Configure SYNC_TOKEN and send it in X-Sync-Token." }, 401);
      return json(await syncContent());
    }
    if (path === "/api/sync/status") {
      const r = await pool.query("SELECT id,started_at,finished_at,pages_fetched,items_seen,items_upserted,status,error FROM public.cinemaxsd_sync_runs ORDER BY id DESC LIMIT 1");
      return json({ success: true, lastSync: r.rows[0] || null });
    }
    if (path === "/api/content" || path.startsWith("/api/content/")) {
      const single = path.startsWith("/api/content/") ? path.slice("/api/content/".length) : "";
      if (single) {
        const r = await pool.query("SELECT * FROM public.cinemaxsd_content WHERE id=$1 OR source_id=$1 LIMIT 1", [single]);
        return r.rows[0] ? json({ success: true, item: r.rows[0] }) : json({ success: false, error: "Content not found" }, 404);
      }
      const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get("page") || "1",10) || 1));
      const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("perPage") || "20",10) || 20));
      const where = [], values = [];
      const add = (sql, value) => { values.push(value); where.push(sql.replace("?", "$" + values.length)); };
      const q = text(url.searchParams.get("q"));
      const type = text(url.searchParams.get("type"));
      const genre = text(url.searchParams.get("genre"));
      const vj = text(url.searchParams.get("vj"));
      const tag = text(url.searchParams.get("tag"));
      if (q) add("(title ILIKE '%' || ? || '%' OR description ILIKE '%' || ? || '%')", q); // replaced below for paired placeholders
      if (q) { where.pop(); values.pop(); values.push(q,q); where.push("(title ILIKE '%' || $" + (values.length-1) + " || '%' OR description ILIKE '%' || $" + values.length + " || '%')"); }
      if (type && type !== "all") add("content_type = ?", type.toLowerCase());
      if (genre) add("genres::text ILIKE '%' || ? || '%'", genre);
      if (vj) add("vjs::text ILIKE '%' || ? || '%'", vj);
      if (tag) add("tags::text ILIKE '%' || ? || '%'", tag);
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      const count = await pool.query("SELECT COUNT(*)::int AS total FROM public.cinemaxsd_content" + clause, values);
      const rows = await pool.query("SELECT id,source_id,title,description,poster,backdrop,content_type,year,genres,vjs,tags,stream_link,episodes,imported_at,updated_at FROM public.cinemaxsd_content" + clause + " ORDER BY updated_at DESC,id DESC LIMIT $" + (values.length+1) + " OFFSET $" + (values.length+2), [...values,perPage,(page-1)*perPage]);
      return json({ success: true, items: rows.rows, total: count.rows[0].total, page, perPage, totalPages: Math.ceil(count.rows[0].total/perPage) });
    }
    return json({ success: false, error: "Not found", endpoints: ["/health","/api/content","/api/content/:id","POST /api/sync","/api/sync/status"] },404);
  } catch (error) {
    return json({ success: false, error: String(error?.message || error) }, 500);
  }
}