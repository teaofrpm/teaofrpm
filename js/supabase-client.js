
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
