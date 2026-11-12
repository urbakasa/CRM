// Urbakasa · Función «agente-whatsapp» (Supabase Edge Function) · 11 nov 2026
// Recibe una conversación y devuelve lo que el agente contestaría, a qué ruta pertenece y si hay que escalar.
// Los textos NO se editan aquí: viven en instrucciones.ts.
//
// Modo de uso actual: pruebas desde agente-prueba.html del CRM. Todavía no está conectado a WhatsApp;
// cuando haya credenciales de la Cloud API se agrega el webhook que llama a esta misma función.
//
// Secretos que necesita (Supabase → Project Settings → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   la llave de la API, creada en console.anthropic.com
//
// Desplegar:  supabase functions deploy agente-whatsapp

import { INSTRUCCIONES, MODELO, PROHIBIDAS, MOTIVOS } from "./instrucciones.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Mensaje con el que se sustituye cualquier respuesta que no pase el filtro.
const ENTREGA = "Eso lo vemos directamente contigo. Alguien del equipo te contesta por aquí.";

// Red de seguridad: busca vocabulario prohibido y secuencias que parezcan datos bancarios.
// Si algo aparece, la respuesta del modelo se descarta y la conversación se escala.
// Es lo que garantiza las reglas de cumplimiento aunque el modelo falle.
function revisar(texto: string): string[] {
  const t = texto.toLowerCase();
  const hallazgos = PROHIBIDAS.filter((p) => t.includes(p));
  // 10 dígitos o más seguidos (cuenta, CLABE), ignorando los separadores de miles de un precio
  if (/\d[\d\s-]{9,}\d/.test(texto.replace(/\$[\d,]+/g, ""))) hallazgos.push("posible dato bancario");
  return hallazgos;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);

  const llave = Deno.env.get("ANTHROPIC_API_KEY");
  if (!llave) return json({ error: "Falta el secreto ANTHROPIC_API_KEY en Supabase" }, 500);

  try {
    const cuerpo = await req.json();
    // «mensajes»: [{ de: "cliente" | "urbakasa", texto: "..." }] en orden cronológico.
    // También se acepta «mensaje» suelto, para la página de pruebas.
    const mensajes: { de: string; texto: string }[] = Array.isArray(cuerpo.mensajes)
      ? cuerpo.mensajes
      : [{ de: "cliente", texto: String(cuerpo.mensaje || "") }];

    if (!mensajes.length || !mensajes.some((m) => (m.texto || "").trim()))
      return json({ error: "No llegó ningún mensaje" }, 400);

    const turnos = mensajes
      .filter((m) => (m.texto || "").trim())
      .map((m) => ({
        role: m.de === "urbakasa" ? "assistant" : "user",
        content: String(m.texto),
      }));
    // La API pide que el primer turno sea del cliente.
    while (turnos.length && turnos[0].role === "assistant") turnos.shift();

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": llave,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cuerpo.modelo || MODELO,
        max_tokens: 1200,
        system: INSTRUCCIONES,
        messages: turnos,
      }),
    });

    if (!r.ok) return json({ error: "La API respondió " + r.status, detalle: await r.text() }, 502);

    const data = await r.json();
    const crudo = (data?.content?.[0]?.text || "").trim();

    let salida: Record<string, unknown>;
    try {
      // Por si el modelo envuelve el JSON en un bloque de código
      salida = JSON.parse(crudo.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return json({ error: "El agente no devolvió un JSON válido", crudo }, 502);
    }

    let respuesta = String(salida.respuesta || "").trim();
    let escalar = salida.escalar === true;
    let motivo = String(salida.motivo || "");
    const hallazgos = revisar(respuesta);

    // Si la respuesta trae algo prohibido, no se envía: se sustituye y se escala.
    if (hallazgos.length) {
      respuesta = ENTREGA;
      escalar = true;
      motivo = "Fuera de guion";
    }
    // Un motivo que no esté en la lista no sirve para clasificar ni para etiquetar.
    if (escalar && !MOTIVOS.includes(motivo as typeof MOTIVOS[number])) motivo = "Fuera de guion";
    if (!escalar) motivo = "";

    return json({
      respuesta,
      ruta: String(salida.ruta || "otro"),
      escalar,
      motivo,
      nombre: String(salida.nombre || ""),
      datos: salida.datos || {},
      filtro: hallazgos,          // vacío cuando la respuesta pasó limpia
      uso: data?.usage || null,   // para medir el costo real por conversación
    });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
