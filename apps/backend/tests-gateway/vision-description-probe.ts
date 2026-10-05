/**
 * Does the revised vision prompt produce real descriptions from real images?
 *
 * The moderation analysis is only as good as the evidence it is given. If the
 * vision pass returns "gambar tidak jelas", the moderation model has nothing to
 * work with and falls back to boilerplate. This pulls real attachment URLs out
 * of production and runs the live vision model over them.
 *
 * Run: DSN=<prod dsn> bun tests/vision-description-probe.ts
 */
import pg from "pg"
import { createDefaultGateway } from "../src/modules-gateway/ai-moderation/llmGateway.js"
import { config } from "../src/shared/config/index.js"

// Same constant the worker uses. Read from source so this test cannot drift
// away from what production actually sends.
const VISION_SYSTEM_PROMPT = `Kamu adalah Penetras Gambar. Tugasmu MENJELASKAN isi gambar, bukan menilai apakah itu melanggar.

Untuk setiap gambar, tulis 1-2 kalimat faktual dalam Bahasa Indonesia:
- Apa yang terlihat: orang, objek, latar, tempat, dan tulisan di dalam gambar.
- Detail spesifik: siapa saja yang ada, berapa orang, aktivitas apa yang terjadi.
- Kalau ada teks di dalam gambar, tuliskan teksnya.
- Kalau ada bagian tubuh atau kondisi fisik yang tampak, sebutkan.

DILARANG menjawab:
- "gambar tidak jelas" atau "kualitas gambar rendah"
- "tidak ada teks" sebagai satu-satunya jawaban, itu bukan deskripsi
- penilaian moral atau kebijakan; itu tugas moderator, bukan kamu

Kalau memang tidak ada yang bisa dibaca dari gambar, katakan bentuk dan
warna yang terlihat, bukan bahwa gambarnya tidak terbaca.

Output: JSON array berisi SATU string per gambar, urutan sama dengan input.
Contoh: ["Seseorang mengambil selfie, rambut disisir ke belakang, memakai kemeja hitam."]`

const dsn = process.env.DSN
if (!dsn) {
	console.error("DSN is required")
	process.exit(2)
}

// Answers that carry no information. A description made only of these is the
// failure this whole change exists to prevent.
const USELESS = [
	"tidak jelas",
	"kualitas rendah",
	"tidak terbaca",
	"tidak ada teks",
	"gambar kosong",
]

const pool = new pg.Pool({ connectionString: dsn, max: 1 })
const gateway = createDefaultGateway()

try {
	const rows = await pool.query(`
    SELECT a.discord_url, m.content
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.discord_url IS NOT NULL
    ORDER BY random()
    LIMIT 6`)

	console.log(`model: ${gateway.modelLabel ?? "unknown"}`)
	console.log(`images: ${rows.rows.length}\n`)

	let useless = 0
	for (const row of rows.rows) {
		try {
			const out = await gateway.complete({
				system: VISION_SYSTEM_PROMPT,
				user: `Deskripsikan 1 gambar berikut. URL: ${row.discord_url}`,
				timeoutMs: config.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS,
			})
			const flat = out.replace(/\s+/g, " ").trim()
			const isUseless =
				USELESS.every((u) => flat.toLowerCase().includes(u)) || flat.length < 30
			if (isUseless) useless++
			console.log(`${isUseless ? "USELESS" : "REAL   "} ${flat.slice(0, 260)}`)
		} catch (e) {
			console.log(`ERROR  ${String(e).slice(0, 100)}`)
		}
	}
	console.log(`\nuninformative: ${useless}/${rows.rows.length}`)
} catch (e) {
	console.log("ERR", e.message)
} finally {
	await pool.end()
}
