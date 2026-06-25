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


// 1. WEBHOOK (DEBE IR AQUÍ, ANTES DEL JSON)
app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`⚠️ Webhook Error: ${err.message}`);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Lógica de actualización a premium
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id; 

    const { error } = await supabase
      .from("user_usage")
      .update({ plan: "premium", subscription_status: "active" })
      .eq("user_id", userId);

    if (error) console.error("❌ Error en Supabase:", error);
    else console.log("✅ Usuario actualizado a premium");
  }

  response.json({ received: true });
});

// 2. MIDDLEWARES GLOBALES (Después del webhook)
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
        temperature: 0.9,        
        frequency_penalty: 0.7,    
        presence_penalty:  0.6     
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

  // SE AGREGA chatId
  const { userId, message, lang, chatId } = result.data;
  const userLang = (lang || "es").toLowerCase();
  
  // 2. LÓGICA DE NEGOCIO
  await ensureUserExists(userId);
  const isPremium = await checkPremiumAccess(userId);
  const plan = isPremium ? "premium" : "free";

  // 3. VALIDACIÓN CENTRALIZADA DE LÍMITE (SE PASA chatId)
  if (!isPremium && await checkUsageLimit(userId, chatId)) {
    return res.status(403).json({ 
      success: false, 
      code: "FREE_LIMIT_REACHED", 
      message: userLang === "en" ? "Limit reached." : "Has alcanzado el límite." 
    });
  }

  // 4. SELECTOR INTELIGENTE
  const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
  const foundLinks = message.match(linkRegex);

  // CAMINO 1: ANÁLISIS DE ENLACES
  if (foundLinks && foundLinks.length > 0) {
    console.log(`🛡️ [Selector] Enlace detectado para usuario ${plan.toUpperCase()}. Consultando IA Estratega...`);
    const link = foundLinks[0];
    const analisisTecnico = analyzeLink(link, plan); 

    // Selección aleatoria de emoji según el nivel detectado
    const emojis = analisisTecnico.nivel === "SEGURO" ? ["🔒", "✅", "✨", "🛡️", "🆗"] : ["⚠️", "🤨", "🚩", "🚫", "🛑"];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

    // CONFIGURACIÓN DE LOS PROMPTS SEGÚN EL PLAN
    let systemContent;

    // ==========================================
    // BLOQUE PREMIUM
    // ==========================================
    if (plan === "premium") {
        systemContent = `Eres ScanlynX Premium, un analista forense de ciberseguridad. 
        TUS REGLAS:
        - Análisis Forense: Identifica brevemente qué hace que el sitio sea sospechoso o seguro (ej. irregularidades en el dominio o patrones de suplantación).
        - Impacto: Menciona qué riesgo corre el usuario (ej. robo de credenciales, malware).
        - Blindaje: Da una acción de seguridad proactiva inmediata.
        - Máximo 3 frases, tono analítico, experto y preciso.
        - Empieza siempre con: ${randomEmoji}.`;
    }
    // ==========================================
    // BLOQUE FREE
    // ==========================================
    else {
        systemContent = `Eres ScanlynX, un guía de seguridad experto y muy práctico.
        TUS REGLAS:
        - Tu único trabajo es darle al usuario la confianza para hacer clic o la advertencia para no hacerlo.
        - Usa solo dos frases: una que indique el estado (seguro/peligroso) y otra que sea el llamado a la acción.
        - PROHIBIDO mencionar nombres de empresas, certificados, protocolos o explicaciones técnicas.
        - Sé breve, directo y humano.
        - Empieza siempre con: ${randomEmoji}.`;
    }

    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: `Analiza este enlace: ${link}. Nivel de riesgo detectado: ${analisisTecnico.nivel}` }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.95,
      max_tokens: 70 // Valor estándar equilibrado para ambos planes
    });

    let respuestaUnica = completion.choices[0].message.content.trim();
    
    // Asegurar el emoji si la IA lo olvidó
    if (!respuestaUnica.startsWith(randomEmoji)) {
      respuestaUnica = `${randomEmoji} ${respuestaUnica}`;
    }

    // Guardar en BD (SE AGREGA chatId)
    await supabase.from("conversations").insert({ user_id: userId, chat_id: chatId, user_message: message, ai_response: respuestaUnica });
    
    // INCREMENTAR CONTADOR EN CHAT_USAGE (SE PASA chatId)
    await incrementUsage(userId, chatId);
    
    return res.json({ reply: respuestaUnica });
  }

  // CAMINO 2: IA ESTRATEGA (Texto normal)
  console.log("🧠 [Selector] Texto detectado. Usando IA Estratega.");

  // FILTRADO POR chatId
  const { data: history } = await supabase.from("conversations").select("user_message, ai_response").eq("user_id", userId).eq("chat_id", chatId).order("created_at", { ascending: true }).limit(5);

  let messages = [{ role: "system", content: userLang === "en" ? "Expert business strategist..." : "Eres un estratega de negocios digitales experto en ciberseguridad." }];
  if (history) history.forEach(row => { messages.push({ role: "user", content: row.user_message }, { role: "assistant", content: row.ai_response }); });
  messages.push({ role: "user", content: message });

  const completion = await groq.chat.completions.create({ messages, model: "llama-3.3-70b-versatile", ...getAIParams() });
  const reply = completion?.choices?.[0]?.message?.content || "Sin respuesta";

  // Guardar en BD (SE AGREGA chatId)
  await supabase.from("conversations").insert({ user_id: userId, chat_id: chatId, user_message: message, ai_response: reply });
  
  // INCREMENTAR CONTADOR EN CHAT_USAGE (SE PASA chatId)
  await incrementUsage(userId, chatId);

  return res.json({ reply });
}));


// --- Función auxiliar para sumar +1 de forma específica por chat ---
async function incrementUsage(userId, chatId) {
  // Buscamos el uso específico de este chat
  const { data: usageData } = await supabase
    .from("chat_usage")
    .select("usage_count")
    .eq("user_id", userId)
    .eq("chat_id", chatId) // Filtramos por chat
    .maybeSingle();

  const currentCount = usageData?.usage_count || 0;
  
  // Guardamos o actualizamos usando el chatId
  await supabase.from("chat_usage").upsert({ 
    chat_id: chatId, 
    user_id: userId, 
    usage_count: currentCount + 1 
  });
}

// Validamos el límite contando los registros reales de ese chat en la base de datos
async function checkUsageLimit(userId, chatId) {
  const { count, error } = await supabase
    .from("conversations")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("chat_id", chatId); // Solo contamos los mensajes de este chat

  if (error) {
    console.error("❌ Error al verificar límite:", error);
    return false; 
  }
  
  return count >= 10; // Ahora el límite de 10 es por sesión de chat
}


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



