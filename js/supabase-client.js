(function () {
  const cfg = window.TEAOFRPM_CONFIG;
  if (!cfg || cfg.SUPABASE_URL.includes("YOUR-PROJECT-ID")) {
    console.warn(
      "[teaofrpm] Supabase is not configured yet "
    );
  }
  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "teaofrpm-auth",
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  });
})();



function toast(msg, ms = 2600) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function escapeHTML(str) {
  if (str == null) return "";
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Deterministic gold/red/aqua-family avatar color from a name string,
// so the same person always gets the same avatar color.
function colorFromName(name) {
  const palette = ["#d8a53d", "#b52a3a", "#1fb6ad", "#c8863c", "#8f1e2b", "#3fa79d"];
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

async function requireSession(redirectTo = "index.html") {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    window.location.href = redirectTo;
    return null;
  }
  return data.session;
}

async function getMyProfile() {
  const { data: sess } = await sb.auth.getSession();
  if (!sess.session) return null;
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", sess.session.user.id)
    .single();
  if (error) {
    console.error(error);
    return null;
  }
  return data;
}

const MAX_IMAGE_DIMENSION = 1600; // longest side, in px
const JPEG_QUALITY = 0.82;

// Re-encodes any photo the user picks (HEIC from iPhones, huge raw camera
// files, etc.) into a resized JPEG, using the browser's own decoder.
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      let { width, height } = img;
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        if (width >= height) {
          height = Math.round(height * (MAX_IMAGE_DIMENSION / width));
          width = MAX_IMAGE_DIMENSION;
        } else {
          width = Math.round(width * (MAX_IMAGE_DIMENSION / height));
          height = MAX_IMAGE_DIMENSION;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);

      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Could not process this image."));
          resolve(blob);
        },
        "image/jpeg",
        JPEG_QUALITY
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This photo's format isn't supported by your browser."));
    };

    img.src = objectUrl;
  });
}

async function getProfileByUsername(username) {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("username", username.toLowerCase())
    .maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  return data;
}

const profileCache = new Map(); // user_id -> profile (avoids refetching per message)

async function getProfile(userId) {
  if (profileCache.has(userId)) return profileCache.get(userId);
  const { data } = await sb.from("profiles").select("*").eq("id", userId).single();
  if (data) profileCache.set(userId, data);
  return data;
}
