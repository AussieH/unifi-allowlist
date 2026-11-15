/** Reads the Worker's environment into one plain object. */

export function config(env) {
  const providers = String(env.AUTH_PROVIDERS || 'token')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    siteName: env.SITE_NAME || 'Game Servers',
    ttlDays: Math.max(1, parseInt(env.TTL_DAYS || '30', 10) || 30),
    allowIpv6: bool(env.ALLOW_IPV6),
    providers,
    tokenEnabled: providers.includes('token'),
    discordEnabled: providers.includes('discord'),

    discord: {
      clientId: env.DISCORD_CLIENT_ID || '',
      clientSecret: env.DISCORD_CLIENT_SECRET || '',
      // Restrict sign-in to members of one guild (server). Strongly recommended:
      // without it, anyone with a Discord account can claim a slot.
      guildId: env.DISCORD_GUILD_ID || '',
      // Optional: additionally require one of these role IDs in that guild.
      roleIds: String(env.DISCORD_ROLE_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },

    // Two-letter country codes (ISO 3166-1) allowed to reach the pages and the admin API; empty = everyone.
    // Cloudflare's own geolocation of the connecting address is used. /healthz and /agent/state are never blocked.
    allowedCountries: String(env.ALLOWED_COUNTRIES || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s)),

    // Optional IPv4 probe (docs/IPV6.md): an IPv4-only endpoint, not behind Cloudflare, that signs the
    // address a browser reaches it from. Lets a player whose browser prefers IPv6 still claim their IPv4.
    ip4Probe: {
      url: env.IP4_PROBE_URL || '',
      key: env.IP4_PROBE_KEY || '',
    },
    ip4ProbeEnabled: !!(env.IP4_PROBE_URL && env.IP4_PROBE_KEY),

    sessionSecret: env.SESSION_SECRET || '',
    sessionTtl: Math.max(300, parseInt(env.SESSION_TTL_SECONDS || '86400', 10) || 86400),
  };
}

const bool = (v) => String(v == null ? '' : v).toLowerCase() === 'true';
