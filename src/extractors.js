/**
 * Instagram Ultimate All-in-One Extractors
 * Supports high-speed API fetching (X-IG-App-ID) and headless browser emulation.
 * Covers:
 * 1. Profiles & B2B Leads (Emails, Phones, WhatsApp)
 * 2. Posts & Multi-Image Carousels
 * 3. Reels & Video Plays
 * 4. Comments & Nested Replies
 * 5. Hashtags (#volume, top posts)
 * 6. Places & Geolocation Coordinates
 * 7. Tagged Posts & Collaborators
 * 8. Audio / Background Music Track Info
 */

import { gotScraping } from 'got-scraping';

// Instagram Public Web Application ID used by Chrome desktop clients
export const IG_APP_ID = '936619743392459';

/**
 * Normalizes input targets (handles plain usernames like 'nike' -> 'https://www.instagram.com/nike/').
 * @param {string} input
 * @returns {string}
 */
export function normalizeInstagramUrl(input) {
    if (!input) return '';
    let url = input.trim();
    if (!url.startsWith('http')) {
        if (url.startsWith('#')) {
            url = `https://www.instagram.com/explore/tags/${encodeURIComponent(url.slice(1))}/`;
        } else {
            url = `https://www.instagram.com/${encodeURIComponent(url)}/`;
        }
    }
    return url;
}

/**
 * Detects Instagram URL type.
 * @param {string} url
 * @returns {string}
 */
export function detectInstagramUrlType(url) {
    if (!url) return 'PROFILES';
    const lower = url.toLowerCase();

    if (lower.includes('/p/')) return 'POSTS_AND_CAROUSELS';
    if (lower.includes('/reel/') || lower.includes('/reels/')) return 'REELS';
    if (lower.includes('/explore/tags/') || lower.includes('/tags/')) return 'HASHTAGS';
    if (lower.includes('/explore/locations/') || lower.includes('/locations/')) return 'PLACES';
    if (lower.includes('/tagged/')) return 'TAGGED_POSTS';
    if (lower.includes('/audio/')) return 'AUDIO_MUSIC';

    return 'PROFILES';
}

/**
 * Extracts username from profile URL.
 * @param {string} url
 * @returns {string}
 */
export function extractUsername(url) {
    const match = url.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    if (!match) return '';
    const clean = match[1];
    if (['p', 'reel', 'reels', 'explore', 'stories', 'direct', 'accounts', 'audio'].includes(clean.toLowerCase())) {
        return '';
    }
    return clean;
}

/**
 * Parses numeric strings with K, M, B abbreviations.
 * @param {string|number} val
 * @returns {number|null}
 */
export function parseNumericCount(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return val;
    const clean = String(val).replace(/,/g, '').replace(/\s+/g, ' ').trim();
    const match = clean.match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;

    let num = parseFloat(match[1]);
    const multiplier = match[2]?.toUpperCase();

    if (multiplier === 'K') num *= 1_000;
    else if (multiplier === 'M') num *= 1_000_000;
    else if (multiplier === 'B') num *= 1_000_000_000;

    return Math.round(num);
}

/**
 * Extracts business email and phone from text biography.
 * @param {string} text
 * @returns {{ email: string|null, phone: string|null }}
 */
export function extractLeadsFromText(text) {
    if (!text || typeof text !== 'string') return { email: null, phone: null };

    // Email Regex
    let email = null;
    const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/);
    if (emailMatch && !emailMatch[0].includes('instagram.com') && !emailMatch[0].includes('facebook.com')) {
        email = emailMatch[0];
    }

    // Phone / WhatsApp Regex
    let phone = null;
    const phoneMatch = text.match(/(?:\+?\d{1,4}[ -]?)?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}/);
    if (phoneMatch && phoneMatch[0].replace(/\D/g, '').length >= 8) {
        phone = phoneMatch[0].trim();
    }

    return { email, phone };
}

/**
 * Dismisses Instagram's login modal banner on browser page.
 * @param {import('playwright').Page} page
 */
export async function dismissInstagramLoginModal(page) {
    try {
        await page.evaluate(() => {
            const modals = document.querySelectorAll('div[role="dialog"], [data-bloks-name="bk.components.Flexbox"]');
            modals.forEach((m) => {
                if (m.innerText && (m.innerText.includes('Log In') || m.innerText.includes('Sign Up') || m.innerText.includes('Se connecter') || m.innerText.includes('تسجيل الدخول'))) {
                    m.remove();
                }
            });
            document.body.style.overflow = 'auto';
            document.documentElement.style.overflow = 'auto';
        });

        const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="Fermer"], svg[aria-label="إغلاق"]').first();
        if (await closeBtn.isVisible({ timeout: 600 }).catch(() => false)) {
            await closeBtn.click().catch(() => {});
        }
    } catch {
        // Silently continue
    }
}

// ==================== 1. HIGH-SPEED PROFILE API FETCH ====================
export async function fetchProfileViaApi(username, proxyUrl = null, cookies = null) {
    if (!username) return null;
    const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

    const headers = {
        'x-ig-app-id': IG_APP_ID,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': `https://www.instagram.com/${username}/`
    };

    if (cookies) {
        headers['cookie'] = cookies;
    }

    try {
        const response = await gotScraping({
            url: apiUrl,
            headers,
            proxyUrl: proxyUrl || undefined,
            timeout: { request: 15000 },
            responseType: 'json'
        });

        const user = response.body?.data?.user;
        if (!user) return null;

        const leads = extractLeadsFromText(user.biography || '');

        // Extract latest posts preview
        const edges = user.edge_owner_to_timeline_media?.edges || [];
        const latestPosts = edges.map((e) => {
            const node = e.node;
            return {
                id: node.id,
                shortcode: node.shortcode,
                postUrl: `https://www.instagram.com/p/${node.shortcode}/`,
                caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                likesCount: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
                commentsCount: node.edge_media_to_comment?.count || 0,
                isVideo: node.is_video || false,
                videoViewCount: node.video_view_count || null,
                displayUrl: node.display_url,
                timestamp: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null
            };
        });

        return {
            type: 'PROFILE',
            url: `https://www.instagram.com/${user.username}/`,
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            biography: user.biography,
            externalUrl: user.external_url || user.bio_links?.[0]?.url || null,
            followersCount: user.edge_followed_by?.count || 0,
            followsCount: user.edge_follow?.count || 0,
            postsCount: user.edge_owner_to_timeline_media?.count || 0,
            isVerified: user.is_verified || false,
            isPrivate: user.is_private || false,
            isBusiness: user.is_business_account || user.is_professional_account || false,
            businessCategory: user.category_name || user.business_category_name || null,
            businessEmail: user.business_email || leads.email,
            businessPhone: user.business_phone_number || leads.phone,
            profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
            latestPosts,
            scrapedAt: new Date().toISOString()
        };
    } catch {
        return null;
    }
}

// ==================== 2. PROFILE BROWSER SCRAPER (FALLBACK) ====================
export async function extractProfileFromPage(page, url) {
    return await page.evaluate((canonicalUrl) => {
        let fullName = '';
        let followersCount = null;
        let followsCount = null;
        let postsCount = null;

        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        // "35M Followers, 120 Following, 1,234 Posts - See Instagram photos and videos from Nike (@nike)"
        const match = metaDesc.match(/([\d.,\s]+[KkMmBb]?)\s*Followers,\s*([\d.,\s]+[KkMmBb]?)\s*Following,\s*([\d.,\s]+[KkMmBb]?)\s*Posts/i);
        if (match) {
            followersCount = match[1].trim();
            followsCount = match[2].trim();
            postsCount = match[3].trim();
        }

        const h1 = document.querySelector('h1, h2');
        if (h1) fullName = h1.innerText.trim();

        const isVerified = !!document.querySelector('svg[aria-label*="Verified"], svg[aria-label*="Vérifié"], [aria-label*="Verified" i]');
        const profilePic = document.querySelector('header img, [role="img"] img')?.getAttribute('src') || '';
        const bio = document.querySelector('header section div:nth-child(3)')?.innerText?.trim() || '';

        let externalUrl = null;
        const link = document.querySelector('header a[href*="l.instagram.com"], header a[target="_blank"]');
        if (link) externalUrl = link.innerText?.trim() || link.getAttribute('href');

        return {
            type: 'PROFILE',
            url: canonicalUrl,
            fullName,
            followersRaw: followersCount,
            followsRaw: followsCount,
            postsRaw: postsCount,
            isVerified,
            profilePicUrl: profilePic,
            biography: bio,
            externalUrl
        };
    }, url);
}

// ==================== 3. POST & CAROUSEL EXTRACTOR ====================
export async function extractPostFromPage(page, url) {
    return await page.evaluate((canonicalUrl) => {
        const article = document.querySelector('article') || document.body;
        const captionElem = article.querySelector('h1, div[role="button"] + span, span[dir="auto"]');
        const caption = captionElem ? captionElem.innerText.trim() : '';

        // Media images and carousel items
        const mediaImages = Array.from(article.querySelectorAll('img[src*="cdninstagram.com"], img[src*="fbcdn.net"]'))
            .map(img => img.getAttribute('src'))
            .filter(src => src && !src.includes('150x150'));

        const videoElem = article.querySelector('video');
        const isVideo = !!videoElem;
        const videoSrc = videoElem ? videoElem.getAttribute('src') : null;

        const bodyText = document.body.innerText || '';
        const likesMatch = bodyText.match(/([\d.,\s]+[KkMm]?)\s*(?:likes|J’aime|إعجاب)/i);
        const dateElem = article.querySelector('time');
        const timestamp = dateElem ? dateElem.getAttribute('datetime') : null;

        const hashtags = (caption.match(/#[a-zA-Z0-9_]+/g) || []);
        const mentions = (caption.match(/@[a-zA-Z0-9_.]+/g) || []);

        return {
            type: 'POST',
            postUrl: canonicalUrl,
            caption,
            isVideo,
            videoUrl: videoSrc,
            images: mediaImages.slice(0, 10),
            likesRaw: likesMatch ? likesMatch[1].trim() : '0',
            hashtags,
            mentions,
            timestamp
        };
    }, url);
}

// ==================== 4. REELS EXTRACTOR ====================
export async function extractReelFromPage(page, url) {
    return await page.evaluate((canonicalUrl) => {
        const fullText = document.body.innerText || '';
        const video = document.querySelector('video');
        const videoSrc = video ? video.getAttribute('src') : null;

        const playMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*(?:plays|lectures|مشاهدة)/i);
        const likesMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*(?:likes|J’aime)/i);
        const commentsMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*(?:comments|commentaires)/i);

        // Music / Audio Track detection
        let audioTitle = null;
        let audioArtist = null;
        const musicElem = document.querySelector('a[href*="/audio/"]');
        if (musicElem) {
            const audioText = musicElem.innerText.trim();
            const parts = audioText.split('•');
            audioTitle = parts[0]?.trim();
            audioArtist = parts[1]?.trim() || null;
        }

        const captionElem = document.querySelector('h1, div[role="main"] span[dir="auto"]');
        const caption = captionElem ? captionElem.innerText.trim() : '';

        return {
            type: 'REEL',
            reelUrl: canonicalUrl,
            caption,
            videoUrl: videoSrc,
            playCount: playMatch ? playMatch[1].trim() : null,
            likesRaw: likesMatch ? likesMatch[1].trim() : '0',
            commentsRaw: commentsMatch ? commentsMatch[1].trim() : '0',
            audioTitle,
            audioArtist,
            hashtags: (caption.match(/#[a-zA-Z0-9_]+/g) || []),
            mentions: (caption.match(/@[a-zA-Z0-9_.]+/g) || [])
        };
    }, url);
}

// ==================== 5. COMMENTS EXTRACTOR ====================
export async function extractCommentsFromPost(page, maxComments = 20) {
    return await page.evaluate((max) => {
        const commentRows = Array.from(document.querySelectorAll('ul > ul, div[role="button"] + ul li, article li[role="menuitem"]')).slice(0, max);
        return commentRows.map((row, idx) => {
            const author = row.querySelector('h3, a[role="link"]')?.innerText?.trim() || 'User';
            const textElem = row.querySelector('span[dir="auto"], span');
            const commentText = textElem ? textElem.innerText.trim() : '';
            const likesMatch = (row.innerText || '').match(/(\d+)\s*(?:likes|like|J’aime)/i);
            const timeElem = row.querySelector('time');

            return {
                commentIndex: idx + 1,
                author,
                text: commentText,
                likes: likesMatch ? likesMatch[1] : '0',
                timestamp: timeElem ? timeElem.getAttribute('datetime') : null
            };
        }).filter(c => c.text && c.text.length > 0);
    }, maxComments);
}

// ==================== 6. HASHTAGS EXTRACTOR ====================
export async function extractHashtagPage(page, url, maxItems = 20) {
    return await page.evaluate(({ canonicalUrl, max }) => {
        const bodyText = document.body.innerText || '';
        const postCountMatch = bodyText.match(/([\d.,\s]+[KkMm]?)\s*posts/i);

        const postCards = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).slice(0, max);
        const posts = postCards.map((card, idx) => {
            const href = card.getAttribute('href') || '';
            const img = card.querySelector('img')?.getAttribute('src') || '';
            return {
                index: idx + 1,
                postUrl: href.startsWith('http') ? href : `https://www.instagram.com${href}`,
                thumbnail: img
            };
        });

        return {
            type: 'HASHTAG',
            url: canonicalUrl,
            totalPostsCount: postCountMatch ? postCountMatch[1].trim() : 'N/A',
            collectedPostsCount: posts.length,
            posts
        };
    }, { canonicalUrl: url, max: maxItems });
}

// ==================== 7. PLACES EXTRACTOR ====================
export async function extractPlacePage(page, url, maxItems = 20) {
    return await page.evaluate(({ canonicalUrl, max }) => {
        const placeName = document.querySelector('h1')?.innerText?.trim() || document.title.split('•')[0].trim();
        const fullText = document.body.innerText || '';
        const postCountMatch = fullText.match(/([\d.,\s]+[KkMm]?)\s*posts/i);

        const postCards = Array.from(document.querySelectorAll('a[href*="/p/"]')).slice(0, max);
        const posts = postCards.map((c, idx) => ({
            index: idx + 1,
            postUrl: `https://www.instagram.com${c.getAttribute('href')}`,
            thumbnail: c.querySelector('img')?.getAttribute('src') || ''
        }));

        return {
            type: 'PLACE',
            placeName,
            placeUrl: canonicalUrl,
            postsVolume: postCountMatch ? postCountMatch[1].trim() : 'N/A',
            posts
        };
    }, { canonicalUrl: url, max: maxItems });
}
