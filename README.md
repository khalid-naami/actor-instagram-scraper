# Instagram Ultimate All-in-One Scraper (Enterprise Edition)

The most comprehensive, high-speed, and stealthy **Instagram Data & B2B Leads Scraper** on Apify.  
Combines **Fast API Engine (X-IG-App-ID)** with **Playwright Stealth Browser Emulation** to extract maximum data at minimum compute cost.

---

## 🌟 Supported Modules & Features

1. **Profiles & B2B Leads**: Official full name, verification badge, follower counts, following count, post count, biography, **business email**, **business phone / WhatsApp**, website in bio, profile picture, and latest posts preview.
2. **Posts & Multi-Image Carousels**: Text captions, high-resolution media images/videos, like counts, comment counts, publication timestamps, hashtags, and tagged accounts.
3. **Reels & Video Plays**: Full video URL, view/play counts, likes, captions, and **Audio/Music track title & artist**.
4. **Comments & Replies**: Full comments feed, author handles, comment text, and like counts.
5. **Hashtags Exploration**: Volume (#post count) and grid of top posts per hashtag.
6. **Places & Geolocation**: Location addresses, place categories, and geotagged posts.
7. **Search by Query**: Search Instagram keywords to discover matching creators, brands, and hashtags.

---

## ⚡ Dual-Engine Architecture
- **Fast-Path API Engine**: Fetches public profile data via internal Instagram Web APIs in less than **1.5 seconds** per profile (no browser rendering required!).
- **Playwright Stealth Engine**: Handles complex pages, Reels, Comments, and Hashtags with automatic modal dismissal and fingerprint rotation.

---

## 📥 Input Configuration

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scrapeMode` | Select | `"AUTO_DETECT"` | Options: `AUTO_DETECT`, `PROFILES`, `POSTS_AND_CAROUSELS`, `REELS`, `COMMENTS`, `HASHTAGS`, `PLACES`, `TAGGED_POSTS`, `AUDIO_MUSIC`. |
| `directUrls` | Array | Required | List of Instagram URLs or plain usernames (e.g. `nike`, `https://www.instagram.com/cristiano/`). |
| `searchQueries` | Array | `[]` | Optional keywords to search hashtags or creators. |
| `resultsLimit` | Integer | `20` | Max posts or items to collect. |
| `maxCommentsPerPost` | Integer | `15` | Max comments to scrape per post. |
| `extractEmailAndPhone` | Boolean | `true` | Extract emails and phone numbers from bios. |
| `proxyConfiguration` | Object | `RESIDENTIAL` | Apify Residential Proxy configuration. |
| `customCookies` | String | `""` | Optional Instagram session cookies for private or restricted accounts. |

---

## 📤 Sample Output (Profile with Leads)

```json
{
  "type": "PROFILE",
  "url": "https://www.instagram.com/nike/",
  "id": "13426469",
  "username": "nike",
  "fullName": "Nike",
  "biography": "Just Do It. Contact: press@nike.com",
  "externalUrl": "https://www.nike.com",
  "followersCount": 305000000,
  "followsCount": 150,
  "postsCount": 1250,
  "isVerified": true,
  "isBusiness": true,
  "businessCategory": "Sportswear",
  "businessEmail": "press@nike.com",
  "businessPhone": "+18008066453",
  "profilePicUrl": "https://instagram.f...jpg",
  "scrapedAt": "2026-10-08T09:30:00.000Z"
}
```

---

## 🛡️ Anti-Block & Compliance
- Automatic login modal & cookie consent removal.
- Randomized User-Agent and client security headers.
- Uses Residential Proxy rotation by default.

---

## 📄 License
Apache-2.0
