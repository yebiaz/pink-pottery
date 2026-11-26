// ─────────────────────────────────────────────────────────────
// The only file you need to edit to go live.
// Supabase: Project URL is on Project Settings → Data API (looks like https://abcd1234.supabase.co).
// Key: Project Settings → API Keys → the "Publishable key" (sb_publishable_…).
// (The anon key is meant to be public — the database only lets it read masked
//  bids and call place_bid. NEVER put a secret key (sb_secret_…) here.)
// Leave them empty to run the site in DEMO mode (bids stay in your browser only).
// ─────────────────────────────────────────────────────────────
window.AUCTION_CONFIG = {
  supabaseUrl: "https://bxxtacvpgpulvnikruaa.supabase.co",
  supabaseAnonKey: "sb_publishable_rc6P1KZDZweCwSdjMmB3Cg_AH1IjGb9",

  // Must match v_deadline in supabase/setup.sql
  deadline: "2026-11-29T19:00:00+08:00", // Sunday Nov 29, 7 PM (China time)

  boothText: "Outside the Performance Cafe · 10 AM – 7 PM · Wed Nov 25 · Fri Nov 27 · Sun Nov 29", // first part = place, the rest = times/days
  contactEmail: "", // e.g. "medicmindset@dukekunshan.edu.cn" — shown in the footer if set
  refreshSeconds: 30
};
