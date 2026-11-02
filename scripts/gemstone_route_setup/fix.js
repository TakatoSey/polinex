/// <reference path="../polinex.d.ts" />
// Dynamic Route Fix: the scripting API has no dedicated call for it, but scripts can read and change any
// module/macro setting. This probes the likely owners for a "fix" setting and drives it when it is a toggle
// or dropdown. When nothing usable is found the caller falls back to asking for one manual click.

const OWNER_MACROS = ["Gemstone Macro"];
const OWNER_MODULES = ["Dynamic Route Fix", "Route Status", "Route Rendering", "Gemstone Routes", "Gemstone Route", "Routes"];
const FIX_NAME = /(dynamic.*fix|route.*fix|fix.*route|auto.?fix|lobby.?fix)/i;

function ownerByName(name) {
  let o = null;
  try { o = macro.get(name); } catch (e) { o = null; }
  if (!o) { try { o = module.get(name); } catch (e) { o = null; } }
  return o;
}

function settingNames(owner) {
  try { return Array.from(owner.settings()).map(String); } catch (e) { return []; }
}

// Returns { label, kind: "setting" | "module", ref } or null.
function probe(override) {
  if (override) {
    const parts = override.split(">").map((s) => s.trim());
    const owner = ownerByName(parts[0]);
    if (!owner) return null;
    if (parts.length < 2) return owner.setEnabled ? { label: parts[0], kind: "module", ref: owner } : null;
    const ref = owner.getSetting(parts[1]);
    return ref ? { label: parts[0] + " > " + parts[1], kind: "setting", ref: ref } : null;
  }
  for (let i = 0; i < OWNER_MODULES.length; i++) {
    let mod = null;
    try { mod = module.get(OWNER_MODULES[i]); } catch (e) { mod = null; }
    if (mod && FIX_NAME.test(OWNER_MODULES[i])) return { label: OWNER_MODULES[i], kind: "module", ref: mod };
  }
  const owners = [];
  OWNER_MACROS.forEach((n) => { try { const o = macro.get(n); if (o) owners.push([n, o]); } catch (e) { /* none */ } });
  OWNER_MODULES.forEach((n) => { try { const o = module.get(n); if (o) owners.push([n, o]); } catch (e) { /* none */ } });
  for (let i = 0; i < owners.length; i++) {
    const names = settingNames(owners[i][1]);
    for (let j = 0; j < names.length; j++) {
      if (!FIX_NAME.test(names[j])) continue;
      const ref = owners[i][1].getSetting(names[j]);
      if (ref) return { label: owners[i][0] + " > " + names[j], kind: "setting", ref: ref };
    }
  }
  return null;
}

// Tries to switch the fix on. Returns "enabled" | "already" | "unsupported".
function apply(fix) {
  if (!fix) return "unsupported";
  if (fix.kind === "module") {
    if (fix.ref.isEnabled()) return "already";
    fix.ref.setEnabled(true);
    return "enabled";
  }
  const ref = fix.ref;
  const value = ref.getValue();
  if (typeof value === "boolean") {
    if (value) return "already";
    ref.setValue(true);
    return "enabled";
  }
  const options = Array.from(ref.options ? ref.options() : []).map(String);
  if (options.length) {
    const want = options.find((o) => /auto|apply|on|enabled|always/i.test(o) && !/off|never|disabled/i.test(o));
    if (!want) return "unsupported";
    if (String(value) === want) return "already";
    ref.setValue(want);
    return "enabled";
  }
  return "unsupported";
}

module.exports = { probe: probe, apply: apply };
