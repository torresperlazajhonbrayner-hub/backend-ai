import express from "express";
import cors from "cors";
import { rateLimit } from 'express-rate-limit';
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import Stripe from "stripe";
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bodyParser from 'body-parser'; 
import { z } from 'zod';


// =========================================================
// BLOQUE DE DIAGNÓSTICO (Ponlo justo aquí)
// =========================================================
console.log("--- DEBUG ---");
console.log("Directorio actual:", process.cwd());
console.log("Archivos encontrados:", fs.readdirSync(process.cwd()));
console.log("-------------------");


// Definición del esquema que faltaba
const chatSchema = z.object({
  userId: z.string(),
  message: z.string(),
  lang: z.string().optional()
});


// =========================================================
// SEGURIDAD FATAL (Poner al inicio de todo)
// =========================================================
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ UNHANDLED REJECTION! El proceso no se cerrará.');
  console.error('Detalle:', reason);
  // Aquí podrías enviar una alerta a Sentry o Slack
});

process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION! Cerrando proceso...');
  console.error(err.name, err.message);
  // Para errores críticos, lo mejor es reiniciar el proceso de forma limpia
  process.exit(1);
});


const __dirname = path.dirname(fileURLToPath(import.meta.url));


// Esto imprimirá en tu terminal la ruta exacta donde Express está buscando
console.log("--- DEBUG ---");
console.log("Directorio actual:", __dirname);
// Cambia la línea del log por esta:
console.log("Archivos encontrados:", fs.readdirSync(__dirname));


dotenv.config();


const app = express();


// Asegúrate de que esta sea la ruta exacta donde está tu index.html
app.use(express.static('C:\\Users\\usuario\\Documents\\chat_nuevo'));




app.use(cors());
app.use(express.json());


// =================================================================
// CONFIGURACIÓN DE SEGURIDAD
// =================================================================
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 10, 
  message: {
    success: false,
    message: "Has superado el límite de peticiones. Intenta de nuevo en un minuto."
  },
  standardHeaders: true,
  legacyHeaders: false,
});


// =================================================================
// CLASE DE MANEJO DE ERRORES
// =================================================================
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    // Esto ayuda a distinguir si es un error que "tú esperabas" (operacional)
    // o un error de programación imprevisto.
    this.isOperational = true; 
    
    Error.captureStackTrace(this, this.constructor);
  }
}


// =================================================================
// UTILIDAD DE MANEJO DE RUTAS ASÍNCRONAS
// =================================================================
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};


// ==========================
// INICIALIZACIÓN DE SERVICIOS
// ==========================

// Supabase
let supabase;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
} else {
    console.error("⚠️ ADVERTENCIA: Variables de Supabase no cargadas.");
}

// Groq
let groq;
if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
} else {
    console.error("⚠️ ADVERTENCIA: GROQ_API_KEY no cargada.");
}

// Stripe
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
} else {
    console.error("⚠️ ADVERTENCIA: STRIPE_SECRET_KEY no cargada.");
}


// =================================================================
// CAPA DE VARIEDAD (Global)
// =================================================================
function getAIParams() {
    return {
        temperature: 0.75,         // Equilibrio perfecto entre creatividad y lógica
        frequency_penalty: 0.4,    // Evita que la IA repita las mismas palabras
        presence_penalty: 0.3      // Fomenta que explore nuevas ideas
    };
}

// =========================================================
// CONFIG
// =========================================================

const PALABRAS_SOSPECHOSAS = [
  "login",
  "verify",
  "bank",
  "paypal",
  "password",
  "urgent",
  "free",
  "winner",
  "prize",
  "secure",
  "update",
  "account",
  "suspended",
  "confirm",
  "verification"
];

const DOMINIOS_CONFIABLES = [
  "google.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "whatsapp.com",
  "x.com",
  "paypal.com",
  "nequi.com.co",
  "bancolombia.com",
  "microsoft.com",
  "apple.com"
];


// =================================================================
// FUNCIÓN DE UTILIDAD ALEATORIA
// =================================================================
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}


// =================================================================
// FUNCIÓN DE MEZCLA DE ARREGLOS
// =================================================================
function shuffleArray(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}


// =================================================================
// FUNCIÓN DE LIMPIEZA DE DOMINIO
// =================================================================
function limpiarDominio(dominio) {
  return dominio
    .toLowerCase()
    .replace("www.", "")
    .trim();
}


// =================================================================
// FUNCIÓN DE EXTRACCIÓN DE DOMINIO
// =================================================================
function extraerDominio(url) {
  try {
    if (
      !url.startsWith("http://") &&
      !url.startsWith("https://")
    ) {
      url = "http://" + url;
    }

    const parsed = new URL(url);

    return limpiarDominio(parsed.hostname);
  } catch {
    return "";
  }
}


// =================================================================
// FUNCIÓN DE DETECCIÓN DE FLAGS
// =================================================================
function detectarFlags(dominio, url) {

  const flags = [];
  const urlLower = url.toLowerCase();

  for (const palabra of PALABRAS_SOSPECHOSAS) {
    if (urlLower.includes(palabra)) {
      flags.push(palabra);
    }
  }

  for (const real of DOMINIOS_CONFIABLES) {
    if (
      dominio.includes(real) &&
      dominio !== real
    ) {
      flags.push("suplantacion");
      break;
    }
  }

  return [...new Set(flags)];
}


// =================================================================
// FUNCIÓN DE EVALUACIÓN DE SEGURIDAD
// =================================================================
function evaluar(flags) {

  let score = 0;

  for (const flag of flags) {
    if (flag === "suplantacion") {
      score += 4;
    } else {
      score += 2;
    }
  }

  if (score >= 6) {
    return "PELIGROSO";
  }

  if (score >= 2) {
    return "SOSPECHOSO";
  }

  return "SEGURO";
}


// =================================================================
// FUNCIÓN PRINCIPAL DE ANÁLISIS
// =================================================================
function analyzeLink(link, modo = "free") {
  modo = modo.toLowerCase().trim();
  
  // Aseguramos que el modo sea válido
  if (modo !== "free" && modo !== "premium") {
    modo = "free";
  }

  const dominio = extraerDominio(link);
  const flags = detectarFlags(dominio, link);
  const resultado = evaluar(flags); // Esto devuelve: SEGURO, SOSPECHOSO o PELIGROSO

  return {
    link,
    dominio,
    modo,
    nivel: resultado, // La IA ahora usará este nivel para redactar la respuesta
    flags
  };
}


// Variable para llevar el control del día de la última limpieza
let lastCleanupDate = null;

// Función que ejecuta la limpieza de forma segura y profesional
async function runDailyCleanup() {
  const today = new Date().toISOString().split('T')[0]; // Obtiene la fecha actual en formato YYYY-MM-DD
  
  // Solo se ejecuta una vez al día
  if (lastCleanupDate !== today) {
    console.log("🧹 Iniciando limpieza automática de historial de hace más de 30 días...");
    
    // Llamamos a la función que creamos en Supabase
    const { error } = await supabase.rpc('delete_old_conversations');
    
    if (error) {
      console.error("❌ Error en la limpieza automática:", error);
    } else {
      console.log("✅ Limpieza de base de datos completada con éxito.");
      lastCleanupDate = today; // Marcamos que hoy ya se realizó la limpieza
    }
  }
}


// =================================================================
// RUTA: CHAT (SELECTOR INTELIGENTE)
// =================================================================
app.post("/api/v1/chat", apiLimiter, catchAsync(async (req, res, next) => {

  // 1. VALIDACIÓN CON ZOD
  const result = chatSchema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ success: false, message: "Datos inválidos", errors: result.error.errors });

  const { userId, message, lang } = result.data;
  const userLang = (lang || "es").toLowerCase();
  
  // 2. LÓGICA DE NEGOCIO
  await ensureUserExists(userId);
  const isPremium = await checkPremiumAccess(userId);
  const plan = isPremium ? "premium" : "free";

  // 3. SELECTOR INTELIGENTE
  const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
  const foundLinks = message.match(linkRegex);

  // CAMINO 1: ANÁLISIS DE ENLACES (IA GENERATIVA)
  if (foundLinks && foundLinks.length > 0) {
    console.log("🛡️ [Selector] Enlace detectado. Consultando IA Estratega...");
    const link = foundLinks[0];
    const analisisTecnico = analyzeLink(link, plan); 

    const prompt = `Analiza este enlace: ${link}. 
    Datos técnicos encontrados: ${JSON.stringify(analisisTecnico)}. 
    
    Tu tarea: Actúa como el experto estratega ScanlynX. Redacta una respuesta única, 
    profesional y muy útil. 
    - NO uses plantillas ni frases prefabricadas. 
    - Varía tu estilo y estructura en cada análisis. 
    - Enfócate en el valor de negocio y la seguridad del usuario.`;

    const completion = await groq.chat.completions.create({
        messages: [
            { role: "system", content: "Eres ScanlynX, una IA estratega de negocios experta en ciberseguridad." },
            { role: "user", content: prompt }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.85
    });

    const respuestaUnica = completion.choices[0].message.content;

    await supabase.from("conversations").insert({
        user_id: userId,
        user_message: message,
        ai_response: respuestaUnica
    });

    return res.json({ reply: respuestaUnica });
  }

  // CAMINO 2: IA ESTRATEGA (Texto normal)
  console.log("🧠 [Selector] Texto detectado. Usando IA Estratega.");

  if (!isPremium) {
    const { data: usageData } = await supabase.from("chat_usage").select("usage_count").eq("chat_id", userId).maybeSingle();
    if ((usageData?.usage_count || 0) >= 10) {
      return res.status(403).json({ success: false, code: "FREE_LIMIT_REACHED", message: userLang === "en" ? "Limit reached." : "Has alcanzado el límite." });
    }
  }

  const isEnglish = userLang === "en";
  const { data: history } = await supabase.from("conversations").select("user_message, ai_response").eq("user_id", userId).order("created_at", { ascending: true }).limit(5);

  let messages = [{
    role: "system",
    content: isEnglish ? "Expert business strategist..." : "Eres un estratega de negocios digitales..."
  }];

  if (history) history.forEach(row => { messages.push({ role: "user", content: row.user_message }, { role: "assistant", content: row.ai_response }); });
  messages.push({ role: "user", content: message });

  const completion = await groq.chat.completions.create({ messages, model: "llama-3.3-70b-versatile", ...getAIParams() });
  const reply = completion?.choices?.[0]?.message?.content || "Sin respuesta";

  await supabase.from("conversations").insert({ user_id: userId, user_message: message, ai_response: reply });
  await supabase.from("chat_usage").upsert({ chat_id: userId, user_id: userId, usage_count: (await supabase.from("chat_usage").select("usage_count").eq("chat_id", userId).maybeSingle()).data?.usage_count + 1 || 1 });

  return res.json({ reply });
}));


// =================================================================
// RUTA: TRADUCCIÓN
// =================================================================
app.post("/translate", async (req, res) => {
  try {
    const { text, lang } = req.body;

    if (!text || !lang) {
      return res.status(400).json({
        error: "Texto o idioma faltante"
      });
    }

    const prompt =
      lang === "en"
      ? `
    You are a professional translator.

    Translate the following text to English.

    IMPORTANT:
    - ONLY return the translated text
    - DO NOT explain
    - DO NOT comment
    - DO NOT add extra sentences
    - DO NOT say "already translated"

    Text:
    ${text}
    `
    : `
    Eres un traductor profesional.

    Traduce el siguiente texto al español.

    IMPORTANTE:
    - SOLO devuelve el texto traducido
    - NO expliques
    - NO agregues comentarios
    - NO digas "ya está traducido"

    Texto:
    ${text}
    `;

    const completion = await groq.chat.completions.create({
      messages: [
    {
      role: "user",
      content: prompt
    }
  ],
  model: "llama-3.3-70b-versatile",
  ...getAIParams(), 
  });

    const translated = completion?.choices?.[0]?.message?.content || text;

    res.json({
      translated
    });

  } catch (error) {
    console.log("ERROR TRANSLATE:", error);

    res.status(500).json({
      error: "Error traduciendo"
    });
  }
});


// =================================================================
// RUTA: GUARDAR IDIOMA
// =================================================================
app.post("/save-lang", async (req, res) => {
  try {
    const { userId, lang } = req.body;

    const { error } = await supabase
      .from("uso_del_usuario")
      .upsert({
        id_usuario: userId,
        lang: lang
      });

    if (error) throw error;

    res.json({ ok: true });

  } catch (error) {
    console.log("ERROR save-lang:", error);
    res.status(500).json({ error: "Error guardando idioma" });
  }
});


// =================================================================
// RUTA: WEBHOOK DE STRIPE
// =================================================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`⚠️ Webhook Error: ${err.message}`);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 1. Lógica de activación
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const customerId = session.customer;

    console.log(`✅ Sesión completada. Procesando usuario: ${userId}`);

    const { data: updateData, error: updateError } = await supabase
      .from("user_usage")
      .update({
        plan: "premium",
        subscription_status: "active",
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString()
      })
      .eq("user_id", userId);

    if (updateError || !updateData || updateData.length === 0) {
      await supabase.from("user_usage").insert({
        user_id: userId,
        plan: "premium",
        subscription_status: "active",
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString()
      });
    }
  }

  // 2. Lógica de cancelación
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    
    console.log("🔍 Buscando en Supabase el ID de Stripe:", subscription.customer);

    const { data, error } = await supabase
      .from('user_usage')
      .update({ plan: 'free', subscription_status: 'canceled' })
      .eq('stripe_customer_id', subscription.customer)
      .select();
      
    if (error) {
      console.error("❌ ERROR al actualizar Supabase:", error);
    } else if (!data || data.length === 0) {
      console.warn("⚠️ AVISO: No se encontró usuario en Supabase con ID:", subscription.customer);
    } else {
      console.log("✅ ÉXITO: Usuario actualizado correctamente a 'free'.", data);
    }
  }

  // Confirmación final para Stripe
  response.json({ received: true });
});


// =================================================================
// RUTA: CREAR SESIÓN DE CHECKOUT
// =================================================================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { userId } = req.body;
    
    console.log("➡️ Intentando crear sesión para USER:", userId);
    console.log("➡️ PRICE_ID:", process.env.PRICE_ID);

    if (!process.env.PRICE_ID) {
      return res.status(500).json({ error: "PRICE_ID no está configurado en el servidor" });
    }

    if (!userId) {
      console.error("❌ ERROR: El userId está vacío o no llegó desde el frontend.");
      return res.status(400).json({ error: "No se recibió un ID de usuario válido." });
    }

    const sessionConfig = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.PRICE_ID, quantity: 1 }],
      success_url: "http://localhost:3000/index.html?success=true",
      cancel_url: "http://localhost:3000/index.html?canceled=true",
      client_reference_id: userId,
      metadata: { userId: userId },
      subscription_data: { metadata: { userId: userId } }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);

    if (!session?.url) {
      throw new Error("Stripe no generó una URL de pago válida.");
    }

    console.log("✅ Sesión creada con éxito para:", userId);
    res.json({ url: session.url });

  } catch (error) {
    console.error("🔥 DETALLE COMPLETO DEL ERROR DE STRIPE:", error.message);
    res.status(500).json({ error: error.message });
  }
});


// =================================================================
// RUTAS: GESTIÓN DE PAGO Y PORTAL
// =================================================================

app.get("/success", (req, res) => {
  res.send(`<h1>✅ Pago exitoso</h1><p>Ya puedes volver a tu chat.</p>`);
});

app.get("/cancel", (req, res) => {
  res.send(`<h1>❌ Pago cancelado</h1><p>No se realizó ningún cobro.</p>`);
});

app.post('/create-portal-session', async (req, res) => {
  const { userId } = req.body;

  try {
    const { data, error } = await supabase
      .from('user_usage')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (error || !data || !data.stripe_customer_id) {
      return res.status(400).json({ error: "No se encontró el ID de cliente en la base de datos." });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: 'http://localhost:3000/',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Error al crear portal:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});


// =================================================================
// RUTA: ANÁLISIS DE ENLACES
// =================================================================
app.post("/analyze-link", async (req, res) => {
  try {
    const { link, mode, userId } = req.body;

    if (!link) {
      return res.status(400).json({ success: false, error: "Link requerido" });
    }

    const safeMode = mode === "premium" ? "premium" : "free";
    const result = await analyzeLink(link, safeMode);

    return res.json({ reply: result.mensaje, analysis: result });

  } catch (error) {
    console.log("🔥 ANALYZE LINK ERROR:", error);
    return res.status(500).json({ success: false, error: "Error analizando link", details: error.message });
  }
});


// =================================================================
// FUNCIÓN: ASEGURAR EXISTENCIA DE USUARIO
// =================================================================
async function ensureUserExists(userId) {
  const { data, error } = await supabase
    .from("user_usage")
    .upsert(
      {
        user_id: userId,
        plan: "free",
        usage_count: 0,
        created_at: new Date().toISOString()
      },
      { onConflict: 'user_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error("❌ Error al asegurar el registro inicial:", error);
  } else {
    console.log("✅ Registro de usuario verificado/creado para:", userId);
  }
}


// =================================================================
// FUNCIÓN: VERIFICACIÓN DE ACCESO PREMIUM
// =================================================================
async function checkPremiumAccess(userId) {
  const { data: userPlanData, error } = await supabase
    .from("user_usage")
    .select("plan")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("❌ Error al verificar plan:", error);
    return false;
  }

  const currentPlan = userPlanData?.plan || "free";
  return currentPlan === "premium";
}


app.use((err, req, res, next) => {
  console.error("🔥 ERROR DETECTADO:", {
    message: err.message,
    path: req.path,
    method: req.method
  });

  // Si el error tiene un status, mantenlo. Si es 403 (límite), se respeta el mensaje.
  const statusCode = err.statusCode || 500;
  
  res.status(statusCode).json({
    success: false,
    // Si el error viene de tu validación de límite, se muestra ese mensaje.
    // Si es un error desconocido, lanzamos el genérico.
    message: err.message || "Error interno del servidor"
  });
});


// =================================================================
// INICIO DEL SERVIDOR
// =================================================================
app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});



