// Urbakasa · Función «resolver-mapa» (Supabase Edge Function) · 9 nov 2026
// Abre un enlace corto de Google Maps (maps.app.goo.gl) y devuelve el enlace completo, que trae las coordenadas.
// Solo acepta enlaces de Google Maps y solo responde a usuarios con sesión iniciada en el CRM (verificación JWT activa).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const permitido = (h: string) =>
  h === "maps.app.goo.gl" || h === "goo.gl" || /(^|\.)google\.[a-z.]+$/.test(h) || /(^|\.)consent\.google\.[a-z.]+$/.test(h);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { url } = await req.json();
    let u = new URL(String(url || ""));
    if (!permitido(u.hostname)) return json({ error: "Solo enlaces de Google Maps" }, 400);
    for (let i = 0; i < 8; i++) {
      const r = await fetch(u.toString(), { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (Macintosh)" } });
      const loc = r.headers.get("location");
      if (!loc) {
        // sin más redirecciones: si la página trae coordenadas, se devuelven en «texto»
        let texto = "";
        if (r.status === 200) {
          const html = (await r.text()).slice(0, 400000);
          const m = html.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) || html.match(/center=(-?\d{1,2}\.\d+)%2C(-?\d{1,3}\.\d+)/) ||
                    html.match(/\[null,null,(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)\]/);
          if (m) texto = m[1] + ", " + m[2];
        }
        return json({ url: u.toString(), texto });
      }
      const sig = new URL(loc, u);
      // la página de consentimiento trae el destino en «continue»
      const cont = sig.searchParams.get("continue");
      u = cont && /consent\./.test(sig.hostname) ? new URL(cont) : sig;
      if (!permitido(u.hostname)) return json({ error: "El enlace salió de Google Maps" }, 400);
    }
    return json({ url: u.toString(), texto: "" });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
