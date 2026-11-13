/**
 * Apify Actor: Instagram Ultimate All-in-One Scraper (Enterprise Edition)
 * Technology: JavaScript (ES Modules), Crawlee, Playwright Stealth + API/GraphQL Interception
 */

import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';
import {
    normalizeInstagramUrl,
    detectInstagramUrlType,
    extractUsername,
    parseNumericCount,
    extractLeadsFromText,
    extractIgJsonEntities,
    dismissInstagramLoginModal,
    fetchProfileViaApi,
    extractProfileFromPage,
    extractPostFromPage,
    extractReelFromPage,
    extractCommentsFromPost,
    extractHashtagPage,
    extractPlacePage,
    sanitizeRecord,
} from './extractors.js';

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return errOrStatus === 597 || errOrStatus === 407 || /597|UPSTREAM407|407|Proxy responded with|tunneling socket/i.test(msg);
}

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        scrapeMode = 'AUTO_DETECT',
        directUrls = [{ url: 'https://www.instagram.com/nike/' }],
        searchQueries = [],
        resultsLimit = 20,
        maxCommentsPerPost = 15,
        extractEmailAndPhone = true,
        proxyConfiguration: proxyInput,
        customCookies = '',
    } = input;

    const safeResultsLimit = Math.max(1, Math.min(500, Number(resultsLimit) || 20));
    const safeMaxComments = Math.max(0, Math.min(100, Number(maxCommentsPerPost) || 15));

    log.info(`🚀 Starting Instagram Ultimate Scraper | Mode: ${scrapeMode} | Targets: ${Array.isArray(directUrls) ? directUrls.length : 0}`);

    const targets = [];
    const urlList = Array.isArray(directUrls) ? directUrls : [];
    for (const item of urlList) {
        const rawUrl = typeof item === 'string' ? item : item?.url;
        if (rawUrl) {
            const normalized = normalizeInstagramUrl(rawUrl);
            if (normalized) targets.push(normalized);
        }
    }
    const queryList = Array.isArray(searchQueries) ? searchQueries : [];
    for (const query of queryList) {
        if (query && typeof query === 'string' && query.trim()) {
            const tag = query.trim().replace(/^#/, '').replace(/\s+/g, '');
            if (tag) targets.push(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`);
        }
    }

    if (targets.length === 0) {
        targets.push('https://www.instagram.com/nike/');
    }

    let proxyConfiguration;
    try {
        if (proxyInput) {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } else {
            proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] }).catch(() => undefined);
        }
    } catch (proxyErr) {
        log.warning(`⚠️ Proxy configuration skipped (${proxyErr.message}). Continuing directly.`);
    }

    function parseCookieString(raw) {
        if (!raw || typeof raw !== 'string' || !raw.trim()) return [];
        const trimmed = raw.trim();
        let rawList = [];
        if (trimmed.startsWith('[')) {
            rawList = JSON.parse(trimmed);
        } else {
            rawList = trimmed.split(';').map((pair) => {
                const eqIdx = pair.indexOf('=');
                if (eqIdx <= 0) return null;
                return {
                    name: pair.slice(0, eqIdx).trim(),
                    value: pair.slice(eqIdx + 1).trim(),
                };
            }).filter(Boolean);
        }

        const out = [];
        for (const c of rawList) {
            if (!c?.name || c?.value === undefined) continue;
            const sameSiteRaw = String(c.sameSite || '').toLowerCase();
            const sameSite = sameSiteRaw === 'no_restriction' || sameSiteRaw === 'none'
                ? 'None'
                : (sameSiteRaw === 'strict' ? 'Strict' : 'Lax');
            out.push({
                name: String(c.name),
                value: String(c.value),
                domain: c.domain || '.instagram.com',
                path: c.path || '/',
                secure: sameSite === 'None' ? true : Boolean(c.secure ?? true),
                sameSite,
            });
        }
        return out;
    }

    const scrapedRecords = [];
    const diagnostics = [];
    const pendingBrowserTargets = [];

    async function pushClean(rec) {
        const cleaned = sanitizeRecord({
            ...rec,
            scrapedAt: rec.scrapedAt || new Date().toISOString(),
        });
        await Actor.pushData(cleaned);
        scrapedRecords.push(cleaned);
        return cleaned;
    }

    // ==================== FAST-PATH: API EXTRACTION FOR PROFILES ====================
    for (const targetUrl of targets) {
        const resolvedMode = detectInstagramUrlType(targetUrl, scrapeMode);
        if (resolvedMode === 'PROFILES') {
            const username = extractUsername(targetUrl);
            if (username) {
                log.info(`⚡ Fast API: Attempting direct profile fetch for @${username}...`);
                const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl().catch(() => null) : null;
                const apiProfile = await fetchProfileViaApi(username, proxyUrl, customCookies, gotScraping, extractEmailAndPhone);
                if (apiProfile) {
                    log.info(`✅ Fast API Success: @${username} | Followers: ${apiProfile.followersCount?.toLocaleString?.() || 0}`);
                    await pushClean(apiProfile);

                    // If user asked specifically for posts/carousels or reels on a profile URL, also emit individual post records
                    if ((scrapeMode === 'POSTS_AND_CAROUSELS' || scrapeMode === 'REELS') && Array.isArray(apiProfile.latestPosts)) {
                        const filteredPosts = scrapeMode === 'REELS'
                            ? apiProfile.latestPosts.filter((p) => p.type === 'REEL' || p.isVideo)
                            : apiProfile.latestPosts;
                        for (const p of filteredPosts.slice(0, safeResultsLimit)) {
                            await pushClean({ ...p, sourceUrl: targetUrl });
                        }
                    }
                    continue;
                }
            }
        }
        pendingBrowserTargets.push(targetUrl);
    }

    // ==================== BROWSER CRAWLER FOR REMAINING TARGETS ====================
    if (pendingBrowserTargets.length > 0) {
        log.info(`🌐 Launching Playwright Stealth Engine for ${pendingBrowserTargets.length} target(s)...`);

        const queueName = `ig-scraper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const requestQueue = await RequestQueue.open(queueName);

        try {
            const crawler = new PlaywrightCrawler({
                requestQueue,
                proxyConfiguration,
                maxConcurrency: 1, // Keep memory footprint safe in 1 GB Apify containers
                maxRequestRetries: 2,
                requestHandlerTimeoutSecs: 80,
                navigationTimeoutSecs: 45,
                headless: true,

                launchContext: {
                    launchOptions: {
                        args: [
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-dev-shm-usage',
                            '--disable-blink-features=AutomationControlled',
                            '--disable-infobars',
                            '--window-size=1280,850',
                        ],
                    },
                },

                preNavigationHooks: [
                    async ({ page, context }, gotoOptions) => {
                        gotoOptions.waitUntil = 'domcontentloaded';

                        page._igBag = { users: new Map(), media: new Map() };
                        if (!page._hasIgResponseListener) {
                            page._hasIgResponseListener = true;
                            page.on('response', async (response) => {
                                try {
                                    const resUrl = response.url();
                                    if (!resUrl.includes('/api/v1/') && !resUrl.includes('/graphql/query')) return;
                                    if (response.status() !== 200) return;
                                    const ct = response.headers()['content-type'] || '';
                                    if (!ct.includes('json')) return;
                                    const json = await response.json().catch(() => null);
                                    if (json && page._igBag) {
                                        extractIgJsonEntities(json, page._igBag);
                                    }
                                } catch {
                                    // ignore transient parsing errors
                                }
                            });
                        }

                        await page.setExtraHTTPHeaders({
                            'accept-language': 'en-US,en;q=0.9',
                        });

                        if (customCookies && typeof customCookies === 'string' && customCookies.trim()) {
                            try {
                                const parsedCookies = parseCookieString(customCookies);
                                if (parsedCookies.length > 0) {
                                    await context.addCookies(parsedCookies);
                                }
                            } catch (cookieErr) {
                                log.warning(`⚠️ Failed to parse customCookies: ${cookieErr.message}`);
                            }
                        }

                        await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort());
                    },
                ],

                async requestHandler({ page, request }) {
                    const url = request.url;
                    const activeMode = detectInstagramUrlType(url, scrapeMode);
                    log.info(`🔎 Scraping Instagram [${activeMode}]: ${url}`);

                    await page.waitForSelector('header, article, main, a[href*="/p/"], a[href*="/reel/"]', { timeout: 10000 }).catch(() => {});
                    await page.waitForTimeout(2500);
                    await dismissInstagramLoginModal(page);

                    if (['PROFILES', 'HASHTAGS', 'PLACES', 'TAGGED_POSTS', 'AUDIO_MUSIC'].includes(activeMode)) {
                        for (let i = 0; i < 2; i++) {
                            await page.mouse.wheel(0, 900);
                            await page.waitForTimeout(1000);
                            await dismissInstagramLoginModal(page);
                        }
                    }

                    const bag = page._igBag || { users: new Map(), media: new Map() };
                    let record = null;

                    if (activeMode === 'PROFILES') {
                        const username = extractUsername(url);
                        const apiJsonProfile = username ? bag.users.get(username.toLowerCase()) : null;
                        const domProfile = await extractProfileFromPage(page, url);

                        const bio = apiJsonProfile?.biography || domProfile.biography || '';
                        const leads = extractEmailAndPhone ? extractLeadsFromText(bio) : { email: undefined, phone: undefined };
                        const capturedPosts = Array.from(bag.media.values()).slice(0, safeResultsLimit);

                        record = sanitizeRecord({
                            type: 'PROFILE',
                            url: apiJsonProfile?.url || domProfile.url,
                            id: apiJsonProfile?.id || domProfile.id || username,
                            username: apiJsonProfile?.username || domProfile.username || username,
                            fullName: apiJsonProfile?.fullName || domProfile.fullName || username,
                            biography: bio || undefined,
                            externalUrl: apiJsonProfile?.externalUrl || domProfile.externalUrl,
                            followersCount: apiJsonProfile?.followersCount ?? parseNumericCount(domProfile.followersRaw),
                            followsCount: apiJsonProfile?.followsCount ?? parseNumericCount(domProfile.followsRaw),
                            postsCount: apiJsonProfile?.postsCount ?? parseNumericCount(domProfile.postsRaw),
                            isVerified: Boolean(apiJsonProfile?.isVerified || domProfile.isVerified),
                            isPrivate: apiJsonProfile?.isPrivate,
                            isBusiness: apiJsonProfile?.isBusiness,
                            businessCategory: apiJsonProfile?.businessCategory,
                            email: apiJsonProfile?.email || leads.email,
                            phone: apiJsonProfile?.phone || leads.phone,
                            businessEmail: apiJsonProfile?.businessEmail || leads.email,
                            businessPhone: apiJsonProfile?.businessPhone || leads.phone,
                            profilePicUrl: apiJsonProfile?.profilePicUrl || domProfile.profilePicUrl,
                            latestPosts: capturedPosts.length > 0 ? capturedPosts : undefined,
                            scrapedAt: new Date().toISOString(),
                        });

                        if (!record.username && !record.fullName) {
                            throw new Error(`Unable to extract Instagram profile for ${url} (possible login wall — use customCookies or Residential Proxy)`);
                        }

                        await pushClean(record);
                        log.info(`✅ Successfully scraped [PROFILES] from: ${url}`);

                        if (scrapeMode === 'POSTS_AND_CAROUSELS' && capturedPosts.length > 0) {
                            for (const p of capturedPosts) {
                                await pushClean({ ...p, sourceUrl: url });
                            }
                        }
                    } else if (activeMode === 'POSTS_AND_CAROUSELS') {
                        const shortcodeMatch = url.match(/\/p\/([^/?#]+)/i);
                        const jsonPost = shortcodeMatch ? Array.from(bag.media.values()).find((m) => m.shortcode === shortcodeMatch[1]) : null;
                        const domPost = await extractPostFromPage(page, url);
                        const comments = safeMaxComments > 0 ? await extractCommentsFromPost(page, safeMaxComments) : [];

                        record = sanitizeRecord({
                            ...domPost,
                            ...jsonPost,
                            url,
                            commentsCount: jsonPost?.commentsCount ?? comments.length,
                            likesCount: jsonPost?.likesCount ?? parseNumericCount(domPost.likesRaw) ?? 0,
                            comments: comments.length > 0 ? comments : undefined,
                            scrapedAt: new Date().toISOString(),
                        });
                        delete record.likesRaw;

                        if (!record.id && !record.caption && !record.displayUrl) {
                            throw new Error(`Post could not be extracted from ${url}`);
                        }
                        await pushClean(record);
                        log.info(`✅ Successfully scraped [POSTS_AND_CAROUSELS] from: ${url}`);
                    } else if (activeMode === 'REELS') {
                        const shortcodeMatch = url.match(/\/(?:reel|reels)\/([^/?#]+)/i);
                        const jsonReel = shortcodeMatch ? Array.from(bag.media.values()).find((m) => m.shortcode === shortcodeMatch[1]) : null;
                        const domReel = await extractReelFromPage(page, url);
                        const comments = safeMaxComments > 0 ? await extractCommentsFromPost(page, safeMaxComments) : [];

                        record = sanitizeRecord({
                            ...domReel,
                            ...jsonReel,
                            type: 'REEL',
                            url,
                            videoPlayCount: jsonReel?.videoPlayCount ?? parseNumericCount(domReel.playCountRaw),
                            likesCount: jsonReel?.likesCount ?? parseNumericCount(domReel.likesRaw) ?? 0,
                            commentsCount: jsonReel?.commentsCount ?? Math.max(comments.length, parseNumericCount(domReel.commentsRaw) ?? 0),
                            comments: comments.length > 0 ? comments : undefined,
                            scrapedAt: new Date().toISOString(),
                        });
                        delete record.playCountRaw;
                        delete record.likesRaw;
                        delete record.commentsRaw;

                        await pushClean(record);
                        log.info(`✅ Successfully scraped [REELS] from: ${url}`);
                    } else if (activeMode === 'COMMENTS') {
                        const commentsList = await extractCommentsFromPost(page, safeMaxComments);
                        if (commentsList.length === 0) {
                            throw new Error(`No comments visible on ${url} (Instagram may require customCookies to load comments)`);
                        }
                        for (const c of commentsList) {
                            await pushClean({
                                type: 'COMMENT',
                                id: `${c.username || 'user'}-${c.commentIndex}`,
                                url,
                                sourceUrl: url,
                                username: c.username,
                                caption: c.text,
                                likesCount: parseNumericCount(c.likes) ?? 0,
                                timestamp: c.timestamp,
                            });
                        }
                        log.info(`✅ Successfully scraped [COMMENTS] (${commentsList.length}) from: ${url}`);
                    } else if (activeMode === 'HASHTAGS') {
                        const domTag = await extractHashtagPage(page, url, safeResultsLimit);
                        const capturedPosts = Array.from(bag.media.values()).slice(0, safeResultsLimit);
                        const posts = capturedPosts.length > 0 ? capturedPosts : (domTag.posts || []);

                        record = sanitizeRecord({
                            ...domTag,
                            collectedPostsCount: posts.length,
                            posts: posts.length > 0 ? posts : undefined,
                            scrapedAt: new Date().toISOString(),
                        });

                        await pushClean(record);
                        for (const p of posts.slice(0, safeResultsLimit)) {
                            await pushClean({
                                type: p.type || 'POST',
                                ...p,
                                sourceUrl: url,
                            });
                        }
                        log.info(`✅ Successfully scraped [HASHTAGS] (${posts.length} posts) from: ${url}`);
                    } else if (activeMode === 'PLACES') {
                        const domPlace = await extractPlacePage(page, url, safeResultsLimit);
                        const capturedPosts = Array.from(bag.media.values()).slice(0, safeResultsLimit);
                        const posts = capturedPosts.length > 0 ? capturedPosts : (domPlace.posts || []);

                        record = sanitizeRecord({
                            ...domPlace,
                            posts: posts.length > 0 ? posts : undefined,
                            scrapedAt: new Date().toISOString(),
                        });
                        await pushClean(record);
                        for (const p of posts.slice(0, safeResultsLimit)) {
                            await pushClean({
                                type: p.type || 'POST',
                                ...p,
                                sourceUrl: url,
                            });
                        }
                        log.info(`✅ Successfully scraped [PLACES] (${posts.length} posts) from: ${url}`);
                    } else {
                        const capturedPosts = Array.from(bag.media.values()).slice(0, safeResultsLimit);
                        const domFallback = await extractHashtagPage(page, url, safeResultsLimit);
                        const posts = capturedPosts.length > 0 ? capturedPosts : (domFallback.posts || []);

                        record = sanitizeRecord({
                            type: activeMode,
                            id: url.split('/').filter(Boolean).pop() || 'instagram',
                            url,
                            fullName: (await page.title()) || undefined,
                            posts: posts.length > 0 ? posts : undefined,
                            scrapedAt: new Date().toISOString(),
                        });
                        await pushClean(record);
                        log.info(`✅ Successfully scraped [${activeMode}] from: ${url}`);
                    }
                },

                async failedRequestHandler({ request }, error) {
                    const msg = error?.message || 'Unknown crawler error';
                    log.error(`❌ Request ${request.url} failed: ${msg}`);
                    diagnostics.push(`${request.url}: ${msg}`);
                },
            });

            await crawler.run(pendingBrowserTargets);
        } finally {
            await requestQueue.drop().catch(() => {});
        }
    }

    const summary = {
        status: scrapedRecords.length > 0 ? 'COMPLETED' : 'FAILED',
        totalRecordsScraped: scrapedRecords.length,
        executionMode: scrapeMode,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        recordsSummary: scrapedRecords.map((r) => sanitizeRecord({
            type: r.type,
            id: r.id,
            url: r.url || r.sourceUrl,
            username: r.username,
            name: r.fullName,
            followers: r.followersCount,
            email: r.email || r.businessEmail,
            phone: r.phone || r.businessPhone,
        })),
        finishedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`🎉 Scraped ${scrapedRecords.length} Instagram record(s). Data pushed to Dataset & OUTPUT Key-Value store.`);

    if (scrapedRecords.length === 0) {
        const reason = diagnostics.length > 0 ? diagnostics.join('; ') : 'No Instagram records extracted (login wall or rate limit).';
        await Actor.fail(`Extracted 0 Instagram records. ${reason}`);
    }
} catch (fatalErr) {
    log.exception(fatalErr, '💥 Fatal error in Instagram Ultimate Scraper');
    await Actor.fail(fatalErr.message);
} finally {
    await Actor.exit();
}
