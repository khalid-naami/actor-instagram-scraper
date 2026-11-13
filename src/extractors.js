/**
 * Instagram Ultimate All-in-One Extractors
 * Supports high-speed API fetching (X-IG-App-ID), Playwright Stealth DOM extraction,
 * and passive GraphQL/REST API JSON interception.
 */

export const IG_APP_ID = '936619743392459';

export function sanitizeRecord(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => sanitizeRecord(item))
            .filter((item) => item !== null && item !== undefined && !(typeof item === 'number' && !Number.isFinite(item)));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (v === null || v === undefined) continue;
            if (typeof v === 'number' && !Number.isFinite(v)) continue;
            if (Array.isArray(v)) {
                out[k] = sanitizeRecord(v);
            } else if (typeof v === 'object') {
                out[k] = sanitizeRecord(v);
            } else {
                out[k] = v;
            }
        }
        return out;
    }
    return value;
}

/**
 * Normalizes input targets (handles plain usernames like 'nike' or '@nike' -> 'https://www.instagram.com/nike/').
 */
export function normalizeInstagramUrl(input) {
    if (!input) return '';
    let url = String(input).trim();
    if (!url.startsWith('http')) {
        if (url.startsWith('#')) {
            url = `https://www.instagram.com/explore/tags/${encodeURIComponent(url.slice(1))}/`;
        } else {
            const cleanHandle = url.replace(/^@/, '');
            url = `https://www.instagram.com/${encodeURIComponent(cleanHandle)}/`;
        }
    }
    return url;
}

/**
 * Detects Instagram URL type structurally first, respecting explicit mode when applicable.
 */
export function detectInstagramUrlType(url, explicitMode = 'AUTO_DETECT') {
    if (!url) return explicitMode && explicitMode !== 'AUTO_DETECT' ? explicitMode : 'PROFILES';
    const lower = url.toLowerCase();

    if (lower.includes('/p/')) return explicitMode === 'COMMENTS' ? 'COMMENTS' : 'POSTS_AND_CAROUSELS';
    if (lower.includes('/reel/') || lower.includes('/reels/')) return explicitMode === 'COMMENTS' ? 'COMMENTS' : 'REELS';
    if (lower.includes('/explore/tags/') || lower.includes('/tags/')) return 'HASHTAGS';
    if (lower.includes('/explore/locations/') || lower.includes('/locations/')) return 'PLACES';
    if (lower.includes('/tagged/')) return 'TAGGED_POSTS';
    if (lower.includes('/audio/')) return 'AUDIO_MUSIC';

    if (explicitMode === 'TAGGED_POSTS') return 'TAGGED_POSTS';
    return 'PROFILES';
}

/**
 * Extracts username from profile URL.
 */
export function extractUsername(url) {
    const match = String(url || '').match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
    if (!match) return '';
    const clean = match[1];
    if (['p', 'reel', 'reels', 'explore', 'stories', 'direct', 'accounts', 'audio'].includes(clean.toLowerCase())) {
        return '';
    }
    return clean;
}

/**
 * Parses numeric strings with K, M, B abbreviations. Returns integer or undefined (never null).
 */
export function parseNumericCount(val) {
    if (val === null || val === undefined || val === '') return undefined;
    if (typeof val === 'number') {
        return Number.isFinite(val) ? Math.trunc(val) : undefined;
    }
    const clean = String(val).replace(/,/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return undefined;
    const match = clean.match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return undefined;

    let num = Number.parseFloat(match[1]);
    if (!Number.isFinite(num)) return undefined;
    const multiplier = match[2]?.toUpperCase();

    if (multiplier === 'K') num *= 1_000;
    else if (multiplier === 'M') num *= 1_000_000;
    else if (multiplier === 'B') num *= 1_000_000_000;

    return Math.round(num);
}

/**
 * Extracts business email and phone from text biography.
 */
export function extractLeadsFromText(text) {
    if (!text || typeof text !== 'string') return { email: undefined, phone: undefined };

    let email;
    const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/);
    if (emailMatch && !emailMatch[0].toLowerCase().includes('instagram.com') && !emailMatch[0].toLowerCase().includes('facebook.com')) {
        email = emailMatch[0].toLowerCase();
    }

    let phone;
    const phoneMatch = text.match(/(?:\+?\d{1,4}[ -]?)?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,5}/);
    if (phoneMatch) {
        const digits = phoneMatch[0].replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) {
            phone = phoneMatch[0].trim();
        }
    }

    return { email, phone };
}

function normalizeIgUserNode(user, includeLeads = true) {
    if (!user || typeof user !== 'object' || !user.username) return null;
    const bio = user.biography || '';
    const leads = includeLeads ? extractLeadsFromText(bio) : { email: undefined, phone: undefined };

    return sanitizeRecord({
        type: 'PROFILE',
        url: `https://www.instagram.com/${user.username}/`,
        id: user.id || user.pk ? String(user.id || user.pk) : user.username,
        username: user.username,
        fullName: user.full_name || user.username,
        biography: bio || undefined,
        externalUrl: user.external_url || user.bio_links?.[0]?.url || undefined,
        followersCount: parseNumericCount(user.edge_followed_by?.count ?? user.follower_count),
        followsCount: parseNumericCount(user.edge_follow?.count ?? user.following_count),
        postsCount: parseNumericCount(user.edge_owner_to_timeline_media?.count ?? user.media_count),
        isVerified: Boolean(user.is_verified),
        isPrivate: Boolean(user.is_private),
        isBusiness: Boolean(user.is_business_account || user.is_professional_account),
        businessCategory: user.category_name || user.business_category_name || undefined,
        email: includeLeads ? (user.business_email || leads.email) : undefined,
        phone: includeLeads ? (user.business_phone_number || leads.phone) : undefined,
        businessEmail: includeLeads ? (user.business_email || leads.email) : undefined,
        businessPhone: includeLeads ? (user.business_phone_number || leads.phone) : undefined,
        profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || undefined,
    });
}

function normalizeIgMediaNode(node, fallbackUsername = undefined) {
    if (!node || typeof node !== 'object') return null;
    const shortcode = node.shortcode || node.code;
    const id = node.id || node.pk ? String(node.id || node.pk) : shortcode;
    if (!id && !shortcode) return null;

    const isVideo = Boolean(node.is_video || node.media_type === 2 || node.video_url || node.video_versions?.length);
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text
        || node.caption?.text
        || (typeof node.caption === 'string' ? node.caption : '')
        || '';

    const carouselImages = [];
    if (Array.isArray(node.edge_sidecar_to_children?.edges)) {
        for (const c of node.edge_sidecar_to_children.edges) {
            if (c?.node?.display_url) carouselImages.push(c.node.display_url);
        }
    } else if (Array.isArray(node.carousel_media)) {
        for (const c of node.carousel_media) {
            const imgUrl = c?.image_versions2?.candidates?.[0]?.url;
            if (imgUrl) carouselImages.push(imgUrl);
        }
    }

    const displayUrl = node.display_url
        || node.image_versions2?.candidates?.[0]?.url
        || carouselImages[0]
        || undefined;
    const videoUrl = node.video_url || node.video_versions?.[0]?.url || undefined;

    const username = node.owner?.username || node.user?.username || fallbackUsername;
    const isReel = Boolean(node.product_type === 'clips' || (isVideo && node.video_duration));
    const url = shortcode
        ? `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`
        : undefined;

    const hashtags = caption.match(/#[a-zA-Z0-9_]+/g) || [];
    const mentions = caption.match(/@[a-zA-Z0-9_.]+/g) || [];
    const tsSec = node.taken_at_timestamp || node.taken_at;

    return sanitizeRecord({
        type: isReel ? 'REEL' : 'POST',
        id: id || shortcode,
        shortcode,
        url,
        username,
        caption: caption || undefined,
        likesCount: parseNumericCount(node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? node.like_count) ?? 0,
        commentsCount: parseNumericCount(node.edge_media_to_comment?.count ?? node.comment_count) ?? 0,
        videoViewCount: parseNumericCount(node.video_view_count ?? node.view_count),
        videoPlayCount: parseNumericCount(node.play_count),
        isVideo,
        displayUrl,
        videoUrl,
        images: carouselImages.length > 0 ? carouselImages : (displayUrl ? [displayUrl] : undefined),
        hashtags: hashtags.length > 0 ? [...new Set(hashtags)] : undefined,
        mentions: mentions.length > 0 ? [...new Set(mentions)] : undefined,
        timestamp: tsSec ? new Date(Number(tsSec) * 1000).toISOString() : undefined,
    });
}

/**
 * Passively extracts Instagram users and posts from intercepted JSON/GraphQL responses.
 */
export function extractIgJsonEntities(payload, bag = { users: new Map(), media: new Map() }) {
    if (!payload || typeof payload !== 'object') return bag;

    if (Array.isArray(payload)) {
        for (const item of payload) extractIgJsonEntities(item, bag);
        return bag;
    }

    // web_profile_info or graphql user object
    if (payload.username && (payload.edge_followed_by || payload.follower_count !== undefined || payload.edge_owner_to_timeline_media)) {
        const normUser = normalizeIgUserNode(payload);
        if (normUser?.username) {
            const key = normUser.username.toLowerCase();
            const prev = bag.users.get(key);
            bag.users.set(key, prev ? sanitizeRecord({ ...prev, ...normUser }) : normUser);
        }
    }

    // Post / Reel media object
    if ((payload.shortcode || payload.code) && (payload.display_url || payload.image_versions2 || payload.edge_media_to_caption || payload.caption)) {
        const normMedia = normalizeIgMediaNode(payload);
        if (normMedia?.id) {
            bag.media.set(normMedia.id, normMedia);
        }
    }

    for (const val of Object.values(payload)) {
        if (val && typeof val === 'object') {
            extractIgJsonEntities(val, bag);
        }
    }
    return bag;
}

/**
 * Dismisses Instagram's login modal banner on browser page.
 */
export async function dismissInstagramLoginModal(page) {
    try {
        await page.evaluate(() => {
            const modals = document.querySelectorAll('div[role="dialog"], [data-bloks-name="bk.components.Flexbox"]');
            modals.forEach((m) => {
                const text = m.innerText || '';
                if (text.includes('Log In') || text.includes('Log in') || text.includes('Sign Up') || text.includes('Se connecter') || text.includes('تسجيل الدخول')) {
                    m.remove();
                }
            });
            document.body.style.overflow = 'auto';
            document.documentElement.style.overflow = 'auto';
        });

        const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="Fermer"], svg[aria-label="إغلاق"]').first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            await closeBtn.click().catch(() => {});
        }
    } catch {
        // Silently continue
    }
}

// ==================== 1. HIGH-SPEED PROFILE API FETCH ====================
export async function fetchProfileViaApi(username, proxyUrl = null, cookies = null, requester = null, includeLeads = true) {
    if (!username) return null;
    const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

    const headers = {
        'x-ig-app-id': IG_APP_ID,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': `https://www.instagram.com/${username}/`,
    };

    if (cookies) headers.cookie = cookies;

    try {
        let body;
        if (requester) {
            const response = await requester({
                url: apiUrl,
                headers,
                proxyUrl: proxyUrl || undefined,
                timeout: { request: 15000 },
                responseType: 'json',
            });
            body = response.body;
        } else {
            const res = await fetch(apiUrl, { headers });
            if (!res.ok) return null;
            body = await res.json();
        }

        const user = body?.data?.user;
        if (!user) return null;

        const baseUser = normalizeIgUserNode(user, includeLeads);
        if (!baseUser) return null;

        const edges = user.edge_owner_to_timeline_media?.edges || [];
        const latestPosts = edges
            .map((e) => normalizeIgMediaNode(e?.node, user.username))
            .filter(Boolean);

        return sanitizeRecord({
            ...baseUser,
            latestPosts: latestPosts.length > 0 ? latestPosts : undefined,
            scrapedAt: new Date().toISOString(),
        });
    } catch {
        return null;
    }
}

// ==================== 2. PROFILE BROWSER SCRAPER (FALLBACK) ====================
export async function extractProfileFromPage(page, url) {
    const raw = await page.evaluate((canonicalUrl) => {
        let fullName = '';
        let followersRaw;
        let followsRaw;
        let postsRaw;

        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        const match = metaDesc.match(/([\d.,\s]+[KkMmBb]?)\s*Followers,\s*([\d.,\s]+[KkMmBb]?)\s*Following,\s*([\d.,\s]+[KkMmBb]?)\s*Posts/i);
        if (match) {
            followersRaw = match[1].trim();
            followsRaw = match[2].trim();
            postsRaw = match[3].trim();
        }

        const h1 = document.querySelector('header h1, header h2, h1, h2');
        if (h1) fullName = (h1.innerText || '').trim();

        const isVerified = Boolean(document.querySelector('svg[aria-label*="Verified"], svg[aria-label*="Vérifié"], [aria-label*="Verified" i]'));
        const profilePic = document.querySelector('header img, [role="img"] img')?.getAttribute('src') || '';
        const bio = document.querySelector('header section div:nth-child(3)')?.innerText?.trim() || '';

        let externalUrl;
        const link = document.querySelector('header a[href*="l.instagram.com"], header a[target="_blank"]');
        if (link) externalUrl = link.innerText?.trim() || link.getAttribute('href') || undefined;

        const uMatch = canonicalUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
        const username = uMatch ? uMatch[1] : undefined;

        return {
            type: 'PROFILE',
            id: username,
            url: canonicalUrl,
            username,
            fullName: fullName || username,
            followersRaw,
            followsRaw,
            postsRaw,
            isVerified,
            profilePicUrl: profilePic || undefined,
            biography: bio || undefined,
            externalUrl,
        };
    }, url);

    return sanitizeRecord(raw);
}

// ==================== 3. POST & CAROUSEL EXTRACTOR ====================
export async function extractPostFromPage(page, url) {
    const raw = await page.evaluate((canonicalUrl) => {
        const article = document.querySelector('article') || document.body;
        const captionElem = article.querySelector('h1, div[role="button"] + span, span[dir="auto"]');
        const metaDesc = document.querySelector('meta[property="og:description"], meta[name="description"]')?.getAttribute('content') || '';
        const caption = (captionElem?.innerText?.trim()) || metaDesc;

        const mediaImages = Array.from(article.querySelectorAll('img[src*="cdninstagram.com"], img[src*="fbcdn.net"]'))
            .map((img) => img.getAttribute('src'))
            .filter((src) => src && !src.includes('150x150'));

        const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
        if (mediaImages.length === 0 && ogImg) mediaImages.push(ogImg);

        const videoElem = article.querySelector('video');
        const isVideo = Boolean(videoElem);
        const videoSrc = videoElem ? videoElem.getAttribute('src') : undefined;

        const bodyText = document.body.innerText || '';
        const likesMatch = bodyText.match(/([\d.,\s]+[KkMm]?)\s*(?:likes|J’aime|إعجاب)/i);
        const dateElem = article.querySelector('time');
        const timestamp = dateElem ? dateElem.getAttribute('datetime') : undefined;

        const scMatch = canonicalUrl.match(/\/(?:p|reel)\/([^/?#]+)/i);
        const shortcode = scMatch ? scMatch[1] : undefined;

        const hashtags = caption.match(/#[a-zA-Z0-9_]+/g) || [];
        const mentions = caption.match(/@[a-zA-Z0-9_.]+/g) || [];

        return {
            type: 'POST',
            id: shortcode,
            shortcode,
            url: canonicalUrl,
            caption: caption || undefined,
            isVideo,
            videoUrl: videoSrc && !videoSrc.startsWith('blob:') ? videoSrc : undefined,
            displayUrl: mediaImages[0] || undefined,
            images: mediaImages.slice(0, 10),
            likesRaw: likesMatch ? likesMatch[1].trim() : '0',
            hashtags,
            mentions,
            timestamp: timestamp || undefined,
        };
    }, url);

    return sanitizeRecord(raw);
}

// ==================== 4. REELS EXTRACTOR ====================
export async function extractReelFromPage(page, url) {
    const raw = await page.evaluate((canonicalUrl) => {
        const fullText = document.body.innerText || '';
        const video = document.querySelector('video');
        const videoSrc = video ? video.getAttribute('src') : undefined;

        const playMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*(?:plays|lectures|مشاهدة)/i);
        const likesMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*(?:likes|J’aime)/i);
        const commentsMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*(?:comments|commentaires)/i);

        let audioTitle;
        let audioArtist;
        const musicElem = document.querySelector('a[href*="/audio/"]');
        if (musicElem) {
            const audioText = (musicElem.innerText || '').trim();
            const parts = audioText.split('•');
            audioTitle = parts[0]?.trim() || undefined;
            audioArtist = parts[1]?.trim() || undefined;
        }

        const captionElem = document.querySelector('h1, div[role="main"] span[dir="auto"]');
        const caption = (captionElem?.innerText?.trim()) || '';
        const scMatch = canonicalUrl.match(/\/(?:reel|reels|p)\/([^/?#]+)/i);
        const shortcode = scMatch ? scMatch[1] : undefined;

        return {
            type: 'REEL',
            id: shortcode,
            shortcode,
            url: canonicalUrl,
            caption: caption || undefined,
            isVideo: true,
            videoUrl: videoSrc && !videoSrc.startsWith('blob:') ? videoSrc : undefined,
            playCountRaw: playMatch ? playMatch[1].trim() : undefined,
            likesRaw: likesMatch ? likesMatch[1].trim() : '0',
            commentsRaw: commentsMatch ? commentsMatch[1].trim() : '0',
            audioTitle,
            audioArtist,
            hashtags: caption.match(/#[a-zA-Z0-9_]+/g) || [],
            mentions: caption.match(/@[a-zA-Z0-9_.]+/g) || [],
        };
    }, url);

    return sanitizeRecord(raw);
}

// ==================== 5. COMMENTS EXTRACTOR ====================
export async function extractCommentsFromPost(page, maxComments = 20) {
    const raw = await page.evaluate((max) => {
        const commentRows = Array.from(document.querySelectorAll('ul > ul, div[role="button"] + ul li, article li[role="menuitem"]')).slice(0, max);
        return commentRows.map((row, idx) => {
            const author = row.querySelector('h3, a[role="link"]')?.innerText?.trim() || 'User';
            const textElem = row.querySelector('span[dir="auto"], span');
            const commentText = textElem ? textElem.innerText.trim() : '';
            const likesMatch = (row.innerText || '').match(/(\d+)\s*(?:likes|like|J’aime)/i);
            const timeElem = row.querySelector('time');

            return {
                commentIndex: idx + 1,
                username: author,
                text: commentText,
                likes: likesMatch ? likesMatch[1] : '0',
                timestamp: timeElem ? timeElem.getAttribute('datetime') : undefined,
            };
        }).filter((c) => c.text && c.text.length > 0);
    }, maxComments);

    return raw.map((c) => sanitizeRecord(c));
}

// ==================== 6. HASHTAGS EXTRACTOR ====================
export async function extractHashtagPage(page, url, maxItems = 20) {
    const raw = await page.evaluate(({ canonicalUrl, max }) => {
        const bodyText = document.body.innerText || '';
        const postCountMatch = bodyText.match(/([\d.,\s]+[KkMm]?)\s*posts/i);
        const tagMatch = canonicalUrl.match(/\/tags\/([^/?#]+)/i);
        const tagName = tagMatch ? decodeURIComponent(tagMatch[1]) : undefined;

        const postCards = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).slice(0, max);
        const posts = postCards.map((card, idx) => {
            const href = card.getAttribute('href') || '';
            const img = card.querySelector('img');
            const fullHref = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
            return {
                index: idx + 1,
                url: fullHref,
                displayUrl: img?.getAttribute('src') || undefined,
                caption: img?.getAttribute('alt') || undefined,
            };
        });

        return {
            type: 'HASHTAG',
            id: tagName,
            url: canonicalUrl,
            fullName: tagName ? `#${tagName}` : undefined,
            totalPostsCount: postCountMatch ? postCountMatch[1].trim() : undefined,
            collectedPostsCount: posts.length,
            posts,
        };
    }, { canonicalUrl: url, max: maxItems });

    return sanitizeRecord(raw);
}

// ==================== 7. PLACES EXTRACTOR ====================
export async function extractPlacePage(page, url, maxItems = 20) {
    const raw = await page.evaluate(({ canonicalUrl, max }) => {
        const placeName = document.querySelector('h1')?.innerText?.trim()
            || document.title.split('•')[0]?.trim()
            || undefined;
        const fullText = document.body.innerText || '';
        const postCountMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*posts/i);
        const locMatch = canonicalUrl.match(/\/locations\/(\d+)/i);

        const postCards = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).slice(0, max);
        const posts = postCards.map((c, idx) => {
            const href = c.getAttribute('href') || '';
            const img = c.querySelector('img');
            return {
                index: idx + 1,
                url: href.startsWith('http') ? href : `https://www.instagram.com${href}`,
                displayUrl: img?.getAttribute('src') || undefined,
                caption: img?.getAttribute('alt') || undefined,
            };
        });

        return {
            type: 'PLACE',
            id: locMatch ? locMatch[1] : placeName,
            fullName: placeName,
            url: canonicalUrl,
            postsVolume: postCountMatch ? postCountMatch[1].trim() : undefined,
            posts,
        };
    }, { canonicalUrl: url, max: maxItems });

    return sanitizeRecord(raw);
}
