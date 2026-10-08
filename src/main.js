/**
 * Apify Actor: Instagram Ultimate All-in-One Scraper (Enterprise Edition)
 * Technology: JavaScript (ES Modules), Crawlee, Playwright, got-scraping
 * Supports dual-engine mode: High-Speed API (X-IG-App-ID) + Playwright Stealth.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    normalizeInstagramUrl,
    detectInstagramUrlType,
    extractUsername,
    parseNumericCount,
    extractLeadsFromText,
    dismissInstagramLoginModal,
    fetchProfileViaApi,
    extractProfileFromPage,
    extractPostFromPage,
    extractReelFromPage,
    extractCommentsFromPost,
    extractHashtagPage,
    extractPlacePage
} from './extractors.js';

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
        customCookies = ''
    } = input;

    log.info(`🚀 Starting Instagram Ultimate Scraper | Mode: ${scrapeMode} | Targets: ${directUrls.length}`);

    // Build targets list (including search queries)
    const targets = [];
    for (const item of directUrls) {
        const rawUrl = typeof item === 'string' ? item : item.url;
        if (rawUrl) targets.push(normalizeInstagramUrl(rawUrl));
    }
    for (const query of searchQueries) {
        if (query && typeof query === 'string') {
            // Add hashtag search
            const tag = query.trim().replace(/^#/, '');
            targets.push(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`);
        }
    }

    if (targets.length === 0) {
        targets.push('https://www.instagram.com/nike/');
    }

    // Setup Apify Residential Proxy
    let proxyConfiguration;
    if (proxyInput) {
        proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
    } else {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL']
        }).catch(() => undefined);
    }

    const scrapedRecords = [];
    const pendingBrowserTargets = [];

    // ==================== FAST-PATH: API EXTRACTION FOR PROFILES ====================
    for (const targetUrl of targets) {
        const mode = scrapeMode === 'AUTO_DETECT' ? detectInstagramUrlType(targetUrl) : scrapeMode;
        if (mode === 'PROFILES') {
            const username = extractUsername(targetUrl);
            if (username) {
                log.info(`⚡ Fast API: Attempting direct profile fetch for @${username}...`);
                const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : null;
                const apiProfile = await fetchProfileViaApi(username, proxyUrl, customCookies);
                if (apiProfile) {
                    log.info(`✅ Fast API Success: @${username} | Followers: ${apiProfile.followersCount?.toLocaleString()} | Email: ${apiProfile.businessEmail || 'N/A'}`);
                    await Actor.pushData(apiProfile);
                    scrapedRecords.push(apiProfile);
                    continue;
                }
            }
        }
        pendingBrowserTargets.push(targetUrl);
    }

    // ==================== BROWSER CRAWLER FOR REMAINING TARGETS ====================
    if (pendingBrowserTargets.length > 0) {
        log.info(`🌐 Launching Playwright Stealth Engine for ${pendingBrowserTargets.length} target(s)...`);

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 75,
            navigationTimeoutSecs: 45,
            headless: true,

            launchContext: {
                launchOptions: {
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--window-size=1280,850'
                    ]
                }
            },

            preNavigationHooks: [
                async ({ page, context }) => {
                    await page.setExtraHTTPHeaders({
                        'accept-language': 'en-US,en;q=0.9',
                        'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"'
                    });

                    // Apply custom session cookies
                    if (customCookies && typeof customCookies === 'string') {
                        try {
                            let parsedCookies = [];
                            if (customCookies.trim().startsWith('[')) {
                                parsedCookies = JSON.parse(customCookies);
                            } else {
                                parsedCookies = customCookies.split(';').map((pair) => {
                                    const [name, ...val] = pair.trim().split('=');
                                    return {
                                        name: name.trim(),
                                        value: val.join('=').trim(),
                                        domain: '.instagram.com',
                                        path: '/'
                                    };
                                }).filter(c => c.name && c.value);
                            }
                            if (parsedCookies.length > 0) {
                                await context.addCookies(parsedCookies);
                                log.info(`🔑 Applied ${parsedCookies.length} Instagram session cookies.`);
                            }
                        } catch (cookieErr) {
                            log.warning(`Failed to parse custom cookies: ${cookieErr.message}`);
                        }
                    }

                    // Abort video streaming to save compute units
                    await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort());
                }
            ],

            async requestHandler({ page, request }) {
                const url = request.url;
                const activeMode = scrapeMode === 'AUTO_DETECT' ? detectInstagramUrlType(url) : scrapeMode;
                log.info(`🔎 Scraping Instagram [${activeMode}]: ${url}`);

                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(2500);

                // Dismiss login modals
                await dismissInstagramLoginModal(page);

                // Scroll if extracting feeds/posts
                if (['POSTS_AND_CAROUSELS', 'REELS', 'HASHTAGS', 'PLACES'].includes(activeMode)) {
                    for (let i = 0; i < 2; i++) {
                        await page.mouse.wheel(0, 800);
                        await page.waitForTimeout(1000);
                        await dismissInstagramLoginModal(page);
                    }
                }

                let record = null;

                switch (activeMode) {
                    case 'PROFILES': {
                        const raw = await extractProfileFromPage(page, url);
                        const leads = extractEmailAndPhone ? extractLeadsFromText(raw.biography || '') : { email: null, phone: null };
                        record = {
                            ...raw,
                            followersCount: parseNumericCount(raw.followersRaw),
                            followsCount: parseNumericCount(raw.followsRaw),
                            postsCount: parseNumericCount(raw.postsRaw),
                            email: leads.email,
                            phone: leads.phone,
                            scrapedAt: new Date().toISOString()
                        };
                        break;
                    }
                    case 'POSTS_AND_CAROUSELS': {
                        const postData = await extractPostFromPage(page, url);
                        let comments = [];
                        if (maxCommentsPerPost > 0) {
                            comments = await extractCommentsFromPost(page, maxCommentsPerPost);
                        }
                        record = {
                            ...postData,
                            likesCount: parseNumericCount(postData.likesRaw),
                            commentsCount: comments.length,
                            comments,
                            scrapedAt: new Date().toISOString()
                        };
                        break;
                    }
                    case 'REELS': {
                        const reelData = await extractReelFromPage(page, url);
                        let comments = [];
                        if (maxCommentsPerPost > 0) {
                            comments = await extractCommentsFromPost(page, maxCommentsPerPost);
                        }
                        record = {
                            ...reelData,
                            playCount: parseNumericCount(reelData.playCount),
                            likesCount: parseNumericCount(reelData.likesRaw),
                            commentsCount: comments.length,
                            comments,
                            scrapedAt: new Date().toISOString()
                        };
                        break;
                    }
                    case 'COMMENTS': {
                        const commentsList = await extractCommentsFromPost(page, maxCommentsPerPost);
                        record = {
                            type: 'COMMENTS_FEED',
                            sourceUrl: url,
                            totalComments: commentsList.length,
                            comments: commentsList,
                            scrapedAt: new Date().toISOString()
                        };
                        break;
                    }
                    case 'HASHTAGS': {
                        record = {
                            ...(await extractHashtagPage(page, url, resultsLimit)),
                            scrapedAt: new Date().toISOString()
                        };
                        break;
                    }
                    case 'PLACES': {
                        record = {
                            ...(await extractPlacePage(page, url, resultsLimit)),
                            scrapedAt: new Date().toISOString()
                        };
                        break;
                    }
                    default: {
                        record = {
                            type: 'GENERIC_INSTAGRAM',
                            url,
                            title: await page.title(),
                            scrapedAt: new Date().toISOString()
                        };
                    }
                }

                if (record) {
                    log.info(`✅ Successfully scraped [${activeMode}] from: ${url}`);
                    await Actor.pushData(record);
                    scrapedRecords.push(record);
                }
            },

            async failedRequestHandler({ request, error }) {
                log.error(`❌ Request ${request.url} failed: ${error.message}`);
            }
        });

        await crawler.run(pendingBrowserTargets);
    }

    // Save summary in Key-Value store
    const summary = {
        totalRecordsScraped: scrapedRecords.length,
        executionMode: scrapeMode,
        recordsSummary: scrapedRecords.map((r) => ({
            type: r.type,
            url: r.url || r.postUrl || r.reelUrl || r.placeUrl,
            username: r.username,
            name: r.fullName || r.placeName || r.type,
            followers: r.followersCount,
            email: r.email || r.businessEmail,
            phone: r.phone || r.businessPhone
        })),
        finishedAt: new Date().toISOString()
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`🎉 Scraped ${scrapedRecords.length} Instagram record(s). Data pushed to Dataset & OUTPUT Key-Value store.`);

} catch (error) {
    log.error(`Actor failed: ${error.message}`, { stack: error.stack });
    throw error;
} finally {
    await Actor.exit();
}
