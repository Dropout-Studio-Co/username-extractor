/**
 * Profile-URL unwrapping — the pre-cleaning step that runs BEFORE the
 * benchmark-frozen cleaners (`cleanUsername` / the per-platform `cleanHandle`s).
 *
 * Why this exists as a SEPARATE step:
 *   `cleanUsername` is a verbatim port of the Python CLI's `_clean_username`
 *   (extract_usernames.py:723-745) and its documented rules — lowercase, strip
 *   whitespace, strip everything outside `[A-Za-z0-9_.]` — are what the recorded
 *   Kimi K2.6 accuracy benchmark (docs/benchmark.md) measured. Those rules are
 *   correct for a bare handle, but they DELETE URL syntax: given
 *   `https://instagram.com/rahi.khan` they produce `httpsinstagramcomrahi.khan`,
 *   a mangled string that still passes `isValidInstagramFormat` and would be
 *   stored and scored as a HIGH-confidence lead.
 *
 *   So the URL is unwrapped first and the frozen cleaner only ever sees the
 *   path segment. Do NOT fold this logic into `cleanUsername`: that would change
 *   its benchmarked output for URL-shaped input and re-open the frozen contract.
 *
 * Vision models and OCR legitimately emit profile URLs, so this is a real input
 * class, not a hypothetical one.
 */

/** Hosts the app supports, without any `www.` / `m.` / `mobile.` prefix. */
export const KNOWN_PROFILE_HOSTS = ["instagram.com", "facebook.com", "fb.com", "tiktok.com", "youtube.com"] as const;

/** Host → platform id (mirrors `$lib/social/platform`'s registry). */
const HOST_PLATFORM: Record<string, string> = {
    "instagram.com": "instagram",
    "facebook.com": "facebook",
    "fb.com": "facebook",
    "tiktok.com": "tiktok",
    "youtube.com": "youtube"
};

const SCHEME_RE = /^https?:\/\//i;
/** Public-site subdomains that still address the same profile (`m.instagram.com`). */
const SUBDOMAIN_PREFIX_RE = /^(?:www|m|mobile|web|touch)\./i;
/** Wrapping punctuation OCR/prose puts around a pasted link: `(url)`, `<url>`, `"url",`. */
const WRAP_OPEN_RE = /^[<([{"'`]+/;
const WRAP_CLOSE_RE = /[>)\]}"'`,.;:]+$/;

/** Routes that introduce the handle in the FOLLOWING segment (YouTube's legacy URLs). */
const PREFIXED_PROFILE_ROUTES: Record<string, readonly string[]> = {
    youtube: ["channel", "c", "user"]
};

/** Routes that are site chrome, never a profile — return null instead of guessing. */
const NON_PROFILE_ROUTES: Record<string, readonly string[]> = {
    instagram: ["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "legal", "developer"],
    tiktok: ["video", "tag", "discover", "search", "foryou", "music", "trending", "upload", "login"],
    facebook: [
        "watch",
        "groups",
        "events",
        "marketplace",
        "gaming",
        "reel",
        "stories",
        "photo",
        "story",
        "share",
        "login"
    ],
    youtube: ["watch", "shorts", "playlist", "results", "feed", "about", "premium", "music", "login"]
};

/** Lowercased + de-prefixed host → platform id, or `null` when it is not a supported host. */
function platformForAuthority(authority: string): string | null {
    let host = authority.toLowerCase();
    // Drop `user:pass@` and an explicit `:port`.
    const at = host.lastIndexOf("@");
    if (at !== -1) {
        host = host.slice(at + 1);
    }
    host = host.replace(/:\d+$/, "").replace(/\.$/, "");
    // Strip any run of public-site subdomains: `www.m.instagram.com` is instagram.
    for (;;) {
        const next = host.replace(SUBDOMAIN_PREFIX_RE, "");
        if (next === host) {
            break;
        }
        host = next;
    }
    return HOST_PLATFORM[host] ?? null;
}

/** Decode the segment, strip a leading `@`, and reject empty values. */
function finalizeSegment(segment: string): string | null {
    // A raw space ends the URL — OCR often continues with page text ("…/rahi.khan 1.2k followers").
    const head = segment.split(/\s+/, 1)[0] ?? "";
    let decoded: string;
    try {
        decoded = decodeURIComponent(head);
    } catch {
        // Malformed percent-encoding: keep the raw segment rather than dropping it.
        decoded = head;
    }
    const handle = decoded.replace(/^@+/, "").trim();
    return handle.length > 0 ? handle : null;
}

/**
 * Extract the profile handle from a supported profile URL, or `null` when the
 * text is not a supported profile URL (callers then fall back to the frozen
 * cleaner's original behaviour).
 *
 * Recognised: `http(s)://…`, `www.…`, or a bare known host, optionally behind
 * `m.` / `mobile.` / `web.` / `touch.`. Query strings and fragments are dropped
 * (`?igsh=…`, `?si=…`, `#…`), percent-encoding is decoded, a leading `@` is
 * stripped, and trailing slashes are ignored. `null` is also returned for URLs
 * with no usable segment (`https://instagram.com/`) and for site-chrome routes
 * (`/p/…`, `/watch`).
 *
 * The returned value is NOT lowercased or format-validated — the platform
 * cleaner still owns that, exactly as before.
 */
export function extractHandleFromUrl(text: string | null | undefined): string | null {
    if (typeof text !== "string") {
        return null;
    }

    const trimmed = text.trim().replace(WRAP_OPEN_RE, "").replace(WRAP_CLOSE_RE, "");
    if (!trimmed) {
        return null;
    }

    const hasScheme = SCHEME_RE.test(trimmed);
    const rest = hasScheme ? trimmed.replace(SCHEME_RE, "") : trimmed;

    // Split the authority (userinfo/host/port) from everything after it.
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const remainder = authorityEnd === -1 ? "" : rest.slice(authorityEnd);

    const platform = platformForAuthority(authority);
    if (!platform) {
        return null;
    }

    // Query/hash are never part of the handle.
    const pathname = remainder.split(/[?#]/, 1)[0] ?? "";
    const segments = pathname
        .split("/")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

    const first = segments[0];
    if (!first) {
        return null;
    }

    let candidate = first;
    if (!first.startsWith("@")) {
        const route = first.toLowerCase();
        if ((PREFIXED_PROFILE_ROUTES[platform] ?? []).includes(route)) {
            // `/channel/UC…`, `/c/name`, `/user/name` — the handle is the next segment.
            const next = segments[1];
            if (!next) {
                return null;
            }
            candidate = next;
        } else if ((NON_PROFILE_ROUTES[platform] ?? []).includes(route)) {
            return null;
        }
    }

    return finalizeSegment(candidate);
}
