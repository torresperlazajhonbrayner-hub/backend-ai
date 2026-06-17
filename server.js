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

// Agrega esto después de tus importaciones
const chatSchema = z.object({
  userId: z.string(),
  message: z.string(),
  lang: z.string().optional(),
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

app.use(express.static(path.join(__dirname, 'public')));

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("🔥 STRIPE EVENT RECIBIDO:", event.type);

  // 1. SESIÓN COMPLETADA (Activación Inicial)
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id;
    
    // --- DIAGNÓSTICO PROFUNDO ---
    console.log("------------------------------------------");
    console.log("🔍 DETECTIVE DE ERRORES INICIADO");
    console.log("➡️ ID recibido de Stripe (client_reference_id):", userId);
    
    // Verificamos qué hay en la tabla antes de hacer nada
    const { data: checkData, error: checkError } = await supabase
      .from("user_usage")
      .select("user_id, plan")
      .eq("user_id", userId);

    console.log("🔍 ¿Existe este ID en la tabla?", checkData);
    console.log("🔍 Error de consulta (si lo hay):", checkError);
    console.log("------------------------------------------");
    // ----------------------------
    
    const customerId = session.customer;

    if (userId) {
      const { error } = await supabase
        .from("user_usage")
        .upsert(
          {
            user_id: userId,
            plan: "premium",
            subscription_status: "active",
            stripe_customer_id: customerId,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'user_id' }
        );

      if (error) console.error("❌ ERROR AL ACTIVAR PREMIUM:", error);
      else console.log("✅ ÉXITO: Usuario activado como premium.");
    }
  }

  // 2. PAGO EXITOSO (Renovación)
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;

    const { error } = await supabase
      .from("user_usage")
      .update({
        subscription_status: "active",
        stripe_subscription_id: subscriptionId,
        updated_at: new Date().toISOString()
      })
      .eq("stripe_customer_id", customerId);

    if (error) console.error("❌ ERROR AL RENOVAR:", error);
    else console.log("✅ ÉXITO: Suscripción actualizada.");
  }

  // 3. CANCELACIÓN
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    const { error } = await supabase
      .from("user_usage")
      .update({
        plan: "free",
        subscription_status: "canceled",
        updated_at: new Date().toISOString()
      })
      .eq("stripe_customer_id", "cus_Uh266YTe5BVT1t");

    if (error) console.error(`❌ ERROR AL CANCELAR ${customerId}:`, error.message);
    else console.log(`ℹ️ Suscripción cancelada para: ${customerId}`);
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());

// ==========================
// CONFIGURACIÓN DE SEGURIDAD (PONLO AQUÍ)
// ==========================
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

// Wrapper para evitar try/catch manual en todas las rutas
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ==========================
// SUPABASE
// ==========================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ==========================
// GROQ - INICIALIZACIÓN SEGURA
// ==========================
let groq = null;

if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
} else {
  console.warn("⚠️ ADVERTENCIA: GROQ_API_KEY no detectada. Las funciones de IA estarán desactivadas.");
}

// ==========================
// STRIPE
// ==========================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

// =========================================================
// RESPUESTAS
// =========================================================

const RESPUESTAS = {

  free: {

    SEGURO: [

      "✔ El enlace se ve tranquilo y no muestra señales de alerta.\n\n🧩 No se detectan indicios comunes de páginas que intenten engañar o generar desconfianza, en general todo parece normal.",

      "🛡 El enlace se ve normal y no parece peligroso a simple vista.\n\n🧩 No se ven cosas raras ni señales típicas de páginas que intentan engañar o confundir.",
      
      "✔ Revisé el enlace y no parece peligroso ni fuera de lo común.\n\n🧩 No hay cosas raras ni señales de que pueda ser un enlace engañoso.",
    ],

    SOSPECHOSO: [

      "⚠️ Este enlace tiene algunos detalles que llaman la atención y conviene revisarlo con cuidado.\n\n🧩 No es necesariamente peligroso, pero sí puede ser un enlace que intenta confundir o hacerte caer en algo sin darte cuenta.",

      "🧩 Este enlace tiene algunos detalles que no se ven del todo normales.\n\n⚠️ Puede ser una página real, pero es mejor revisarlo con cuidado antes de confiar en él o ingresar información.",

      "⚠️ Este enlace genera algunas dudas y es mejor revisarlo con cuidado antes de usarlo.\n\n🧩 No termina de verse completamente confiable, así que vale la pena ir con precaución.",
    ],

    PELIGROSO: [

      "❌ Este enlace tiene cosas raras y no se ve del todo claro.\n\n🧩 Hay detalles que no encajan con lo que normalmente verías en un enlace confiable, así que es mejor tener cuidado.",

      "🧩 Este enlace no termina de dar confianza del todo.\n\n❌ Tiene algunos detalles que hacen que sea mejor no usarlo sin revisarlo antes.",

      "❌ Este enlace tiene detalles que no terminan de verse del todo normales.\n\n🧩 No se siente igual de confiable que una página habitual, así que vale la pena tener cuidado antes de interactuar con él.",
    ]
  },

  premium: {

    SEGURO: [

      "✔ El enlace no muestra nada fuera de lo común y mantiene una estructura consistente.\n\n🧩 No hay señales de comportamiento sospechoso ni indicios de que esté ocultando información inusual.\n\n👀 Su nombre y formato coinciden con lo que normalmente se espera en una página legítima.\n\n⚠️ Aun así, es recomendable confirmar que sea la página correcta antes de ingresar datos importantes.",

      "🛡 Este enlace se ve confiable en esta revisión y no muestra nada fuera de lo habitual.\n\n🧩 No aparecen señales típicas de páginas engañosas o diseñadas para confundir.\n\n👀 Todo se ve estable y coherente por ahora.\n\n⚠️ Si este enlace te llegó por mensaje o desde una fuente desconocida, es mejor revisarlo con cuidado antes de interactuar.",

      "✔ Este enlace se ve tranquilo y sin cosas raras.\n\n🧩 No hay señales que hagan pensar que sea un enlace falso o sospechoso.\n\n👀 A simple vista parece una página normal y confiable.\n\n⚠️ Aun así, es mejor revisarlo con calma antes de poner datos importantes.",
    ],

    SOSPECHOSO: [

      "⚠️ Este enlace tiene varios detalles que no se ven del todo naturales.\n\n🧩 Algunas partes parecen buscar generar confianza muy rápido, algo que suele verse en enlaces engañosos.\n\n👀 No significa que sea peligroso, pero sí es mejor revisarlo con calma antes de ingresar información importante.\n\n⚠️ Ten  cuidado si te pide iniciar sesión, contraseñas o datos personales.",
      
      "🧩 Este enlace tiene varios detalles que llaman la atención.\n\n⚠️ No parece completamente falso, pero tampoco genera total confianza.\n\n👀 Hay pequeñas señales que hacen recomendable revisarlo con más cuidado antes de confiar del todo.\n\n⚠️ Ten cuidado Especialmente si te llegó por mensajes, correo o redes sociales.",
      
      "⚠️ Algo en este enlace se siente raro.\n\n🧩 Hay detalles poco comunes que hacen difícil confiar totalmente sin revisar mejor.\n\n👀 A veces este tipo de enlaces buscan que la persona actúe rápido sin pensar demasiado.\n\n⚠️ Lo mejor es tomarse un momento antes de abrirlo o escribir información importante."
    ],

    PELIGROSO: [

      "❌ Este enlace genera dudas y no se ve confiable, así que es mejor revisarlo con cuidado antes de usarlo.\n\n🧩 Hay varios detalles que hacen pensar que intenta verse más confiable de lo que realmente es.\n\n👀 Algunas partes se parecen a cosas usadas para hacer que las personas entren sin revisar demasiado.\n\n⚠️ Yo tendría mucho cuidado antes de abrirlo o escribir información importante aquí.",

      "🧩 Este enlace tiene detalles que hacen que no sea del todo confiable y es mejor revisarlo antes de interactuar con él.\n\n❌ Hay cosas que se sienten poco naturales y que hacen difícil confiar completamente.\n\n👀 Este tipo de enlaces normalmente buscan generar confianza rápida o hacer que la persona actúe sin pensar demasiado.\n\n⚠️ Lo más recomendable es actuar con bastante precaución.",

      "❌ Hay varias cosas raras en este enlace.\n\n🧩 No parece una página completamente natural y algunos detalles generan bastantes dudas.\n\n👀 Yo evitaría poner contraseñas, códigos o información importante hasta estar totalmente seguro.\n\n⚠️ Si tienes dudas, entrar manualmente desde la página oficial suele ser mucho más seguro."
    ]
  }
};

// =========================================================
// REACCIONES
// =========================================================

const REACCIONES = {

  login: [
    "👀 Parece una página donde podrían pedirte acceso a una cuenta o información importante.",
    "🧩 Este tipo de enlaces normalmente buscan que la persona inicie sesión o escriba datos."
  ],

  verify: [
    "🧩 El enlace usa palabras que intentan generar confianza rápidamente.",
    "👀 Algunas palabras aquí buscan hacer que todo parezca urgente o importante."
  ],

  bank: [
    "🏦 Parece relacionado con dinero, cuentas o información financiera.",
    "🧩 Cuando un enlace toca temas bancarios siempre vale la pena revisarlo dos veces."
  ],

  password: [
    "🔑 El enlace parece relacionado con contraseñas o acceso a cuentas.",
    "👀 Yo tendría más cuidado si aquí te piden datos privados."
  ],

  secure: [
    "🧩 El enlace intenta verse seguro o confiable desde el nombre.",
    "👀 A veces este tipo de palabras se usan para transmitir confianza rápidamente."
  ],

  suplantacion: [
    "🧩 El nombre del enlace se parece mucho a páginas conocidas, y eso puede confundir fácilmente.",
    "⚠️ Hay partes del enlace que intentan verse familiares o reconocidas."
  ]
};

// =========================================================
// UTILIDAD
// =========================================================

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleArray(array) {

  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {

    const j = Math.floor(Math.random() * (i + 1));

    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function limpiarDominio(dominio) {
  return dominio
    .toLowerCase()
    .replace("www.", "")
    .trim();
}

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

// =========================================================
// DETECCIÓN
// =========================================================

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

// =========================================================
// EVALUACIÓN
// =========================================================

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

// =========================================================
// GENERADOR
// =========================================================

function generarRespuesta(resultado, flags, modo) {

  const bloques = [];

  const base =
    randomChoice(
      RESPUESTAS[modo][resultado]
    );

  bloques.push(base);

  const usadas = [];

  const flagsMezclados =
    shuffleArray(flags);

  const limite =
    modo === "free" ? 1 : 2;

  for (const flag of flagsMezclados.slice(0, limite)) {

    if (REACCIONES[flag]) {

      const reaccion =
        randomChoice(
          REACCIONES[flag]
        );

      if (!usadas.includes(reaccion)) {

        bloques.push(reaccion);

        usadas.push(reaccion);
      }
    }
  }

  return bloques.join("\n\n").trim();
}

// =========================================================
// FUNCIÓN PRINCIPAL
// =========================================================

function analyzeLink(link, modo = "free") {

  modo = modo.toLowerCase().trim();

  if (
    modo !== "free" &&
    modo !== "premium"
  ) {
    modo = "free";
  }

  const dominio =
    extraerDominio(link);

  const flags =
    detectarFlags(
      dominio,
      link
    );

  const resultado =
    evaluar(flags);

  const mensaje =
    generarRespuesta(
      resultado,
      flags,
      modo
    );

  return {

    link,

    dominio,

    modo,

    resultado,

    flags,

    mensaje
  };
}

// =========================================================
// CHAT - RUTA PROTEGIDA
// =========================================================
app.post("/api/v1/chat", apiLimiter, catchAsync(async (req, res, next) => {
  
  // 1. VALIDACIÓN CON ZOD
  const result = chatSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      success: false,
      message: "Datos inválidos",
      errors: result.error.errors
    });
  }

  // 2. EXTRAEMOS DATOS
  const { userId, message, lang } = result.data;
  const chatId = userId;

  // 3. LÓGICA DE NEGOCIO
  await ensureUserExists(userId);
  const isPremium = await checkPremiumAccess(userId);
  const plan = isPremium ? "premium" : "free";

  let userLang = (lang || "es").toLowerCase();
  const validLangs = ["en", "es"];
  if (!validLangs.includes(userLang)) userLang = "es";

  const LIMIT_FREE = 2;
  let currentUsage = 0;

  if (!isPremium) {
    const { data: usageData } = await supabase
      .from("chat_usage")
      .select("usage_count")
      .eq("chat_id", chatId)
      .maybeSingle();
      
    currentUsage = usageData?.usage_count || 0;

    if (currentUsage >= LIMIT_FREE) {
      return res.status(403).json({
        code: "FREE_LIMIT_REACHED",
        message: userLang === "en" 
          ? "You have reached the limit. Upgrade to Premium." 
          : "Has alcanzado el límite. Actualiza a Premium."
      });
    }
  }

  // 4. DETECTAR LINKS
  const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
  const foundLinks = message.match(linkRegex);

  if (foundLinks && foundLinks.length > 0) {
    const detectedLink = foundLinks[0];
    const result = analyzeLink(detectedLink, plan);
    return res.json({
      reply: result.mensaje,
      analysis: result,
      titles: { es: "Análisis de enlace", en: "Link analysis" }
    });
  }

  // 5. PROCESAMIENTO IA (LLAMA)
  const isEnglish = userLang === "en";
  
  if (!groq) {
    return res.status(500).json({ success: false, message: "Servicio de IA no disponible" });
  }

  const completion = await groq.chat.completions.create({
    messages: [
      { role: "system", content: isEnglish ? "You are an assistant. Always respond ONLY in English." : "Eres un asistente. Siempre responde SOLO en español." },
      { role: "user", content: message }
    ],
    model: "llama-3.3-70b-versatile",
  });

  const reply = completion?.choices?.[0]?.message?.content || "Sin respuesta";

  // 6. GUARDAR Y LOGEAR
  await supabase.from("conversations").insert({
    user_id: userId,
    user_message: message,
    ai_response: reply
  });

  await supabase.from("chat_usage").upsert({
    chat_id: chatId,
    user_id: userId,
    usage_count: currentUsage + 1,
    created_at: new Date().toISOString()
  });

  // 7. TÍTULOS PROTEGIDOS
  let titleEs = "Nuevo Chat";
  let titleEn = "New Chat";

  if (groq) {
    try {
      const titleCompletion = await groq.chat.completions.create({
        messages: [{ role: "system", content: `Devuelve formato ES: ... EN: ... para: ${message}` }],
        model: "llama-3.3-70b-versatile",
      });
      
      const raw = titleCompletion?.choices?.[0]?.message?.content || "";
      titleEs = raw.match(/ES:\s*(.*)/)?.[1] || "Nuevo Chat";
      titleEn = raw.match(/EN:\s*(.*)/)?.[1] || "New Chat";
    } catch (error) {
      console.error("Error al generar títulos:", error);
    }
  }

  res.json({
    reply,
    titles: { es: titleEs, en: titleEn }
  });
}));

// =========================================================
// OTRAS RUTAS Y CONFIGURACIONES
// =========================================================
app.post("/translate", async (req, res) => {
  try {
    const { text, lang } = req.body;
    if (!text || !lang) return res.status(400).json({ error: "Texto o idioma faltante" });

    const prompt = lang === "en" 
      ? `Translate to English: ${text}` 
      : `Traduce al español: ${text}`;

    if (!groq) {
      return res.status(500).json({ error: "Servicio de traducción no disponible" });
    }

    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
    });

    res.json({ translated: completion?.choices?.[0]?.message?.content || text });
  } catch (error) {
    console.error("ERROR TRANSLATE:", error);
    res.status(500).json({ error: "Error traduciendo" });
  }
});

// ... [Aquí irían tus rutas de save-lang, webhook, checkout, etc.] ...

// ==========================
// INICIO DEL SERVIDOR
// ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
