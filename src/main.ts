import { Actor } from 'apify';

interface Input {
    windowDays?: number;
    maxNewUsers?: number;
    maxWindows?: number;
    startTimestamp?: number;
}

interface AlgoliaHit {
    author: string;
    created_at_i: number;
    objectID: string;
}

interface AlgoliaSearchResponse {
    hits: AlgoliaHit[];
    nbPages: number;
    page: number;
}

interface AlgoliaUser {
    username: string;
    about: string | null;
    karma: number;
    created_at: string;
}

interface UserRecord {
    username: string;
    profileLink: string;
    bio: string;
    links: string[];
}

interface RunState {
    cursor: number;
    seenUsernames: string[];
}

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';
const HN_PROFILE_BASE = 'https://news.ycombinator.com/user?id=';
const STATE_KEY = 'SHOW_HN_STATE';

// Show HN itself did not exist as a tagged thing from day one of Hacker
// News, so there is nothing meaningful to fetch before this. If Algolia's
// own index genuinely starts later than this, empty windows are simply
// skipped and the cursor keeps moving forward, so this is a safe floor
// either way.
const DEFAULT_START_TIMESTAMP = 1178668291; // 2007-05-09, HN's own launch day

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function stripHtml(value: string): string {
    return value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .trim();
}

function extractLinksFromBio(rawAboutHtml: string): string[] {
    const links = new Set<string>();

    const hrefMatches = rawAboutHtml.matchAll(/href="([^"]+)"/gi);
    for (const match of hrefMatches) {
        links.add(match[1]);
    }

    const plainText = stripHtml(rawAboutHtml);
    const urlMatches = plainText.matchAll(/https?:\/\/[^\s<>"')]+/gi);
    for (const match of urlMatches) {
        links.add(match[0]);
    }

    // People often list a site or handle without the http prefix, for
    // example "twitter.com/example" or "myproject.dev". This catches common
    // domain endings so those still get picked up, without being so loose
    // that ordinary sentences start matching by accident.
    const bareDomainPattern =
        /\b[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|org|net|io|dev|co|me|xyz|app|blog|page|so|to|sh)(?:\/[^\s<>"')]*)?\b/gi;
    const bareMatches = plainText.matchAll(bareDomainPattern);

    for (const match of bareMatches) {
        const alreadyCovered = Array.from(links).some((link) => link.includes(match[0]));
        if (!alreadyCovered) {
            links.add(match[0]);
        }
    }

    return Array.from(links);
}

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'ShowHNProfileScraper (contact via Apify)' },
    });

    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status} for ${url}`);
    }

    return (await response.json()) as T;
}

async function fetchShowHnAuthorsInWindow(
    windowStart: number,
    windowEnd: number,
): Promise<string[]> {
    const authors: string[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
        const url =
            `${ALGOLIA_BASE}/search_by_date?tags=show_hn&hitsPerPage=1000&page=${page}` +
            `&numericFilters=created_at_i>=${windowStart},created_at_i<${windowEnd}`;

        const data = await fetchJson<AlgoliaSearchResponse>(url);

        for (const hit of data.hits) {
            if (hit.author) {
                authors.push(hit.author);
            }
        }

        totalPages = data.nbPages;
        page++;
    }

    return authors;
}

async function fetchUserProfile(username: string): Promise<UserRecord | null> {
    try {
        const user = await fetchJson<AlgoliaUser>(
            `${ALGOLIA_BASE}/users/${encodeURIComponent(username)}`,
        );

        const rawAbout = user.about ?? '';

        const record: UserRecord = {
            username: user.username,
            profileLink: `${HN_PROFILE_BASE}${encodeURIComponent(user.username)}`,
            bio: stripHtml(rawAbout),
            links: extractLinksFromBio(rawAbout),
        };

        return record;
    } catch (error) {
        console.log(`Could not fetch profile for ${username}: ${errorMessage(error)}`);
        return null;
    }
}

async function loadState(fallbackStartTimestamp: number): Promise<RunState> {
    const saved = await Actor.getValue<RunState>(STATE_KEY);

    if (saved) {
        return saved;
    }

    return { cursor: fallbackStartTimestamp, seenUsernames: [] };
}

async function saveState(state: RunState): Promise<void> {
    await Actor.setValue(STATE_KEY, state);
}

await Actor.init();

try {
    const input = (await Actor.getInput<Input>()) ?? {};

    const windowDays = Math.max(1, input.windowDays ?? 30);
    const windowSeconds = windowDays * 24 * 60 * 60;
    const maxNewUsers = Math.max(0, input.maxNewUsers ?? 200);
    const maxWindows = Math.max(0, input.maxWindows ?? 0);
    const startTimestamp = input.startTimestamp ?? DEFAULT_START_TIMESTAMP;

    const state = await loadState(startTimestamp);
    const seen = new Set(state.seenUsernames);

    const nowSeconds = Math.floor(Date.now() / 1000);

    console.log('==============================');
    console.log('SHOW HN PROFILE SCRAPER');
    console.log('==============================');
    console.log(`Resuming from: ${new Date(state.cursor * 1000).toISOString()}`);
    console.log(`Window size: ${windowDays} day(s)`);
    console.log(`Max new users to save this run: ${maxNewUsers === 0 ? 'UNLIMITED' : maxNewUsers}`);
    console.log(`Max windows to scan this run: ${maxWindows === 0 ? 'UNLIMITED' : maxWindows}`);
    console.log(`Usernames already known from previous runs: ${seen.size}`);

    let cursor = state.cursor;
    let windowsScanned = 0;
    let newUsersSaved = 0;
    let reachedPresentDay = false;

    while (cursor < nowSeconds) {
        if (maxWindows > 0 && windowsScanned >= maxWindows) {
            console.log(`Reached configured window limit: ${maxWindows}.`);
            break;
        }

        if (maxNewUsers > 0 && newUsersSaved >= maxNewUsers) {
            console.log(`Reached configured new user limit: ${maxNewUsers}.`);
            break;
        }

        const windowStart = cursor;
        const windowEnd = Math.min(cursor + windowSeconds, nowSeconds);

        console.log(
            `\nScanning window: ${new Date(windowStart * 1000).toISOString()} to ` +
                `${new Date(windowEnd * 1000).toISOString()}`,
        );

        let authors: string[] = [];

        try {
            authors = await fetchShowHnAuthorsInWindow(windowStart, windowEnd);
        } catch (error) {
            console.log(`Window fetch failed, will retry this same window next run: ${errorMessage(error)}`);
            break;
        }

        const uniqueInWindow = Array.from(new Set(authors));
        console.log(`Show HN posts found in window: ${authors.length}, unique authors: ${uniqueInWindow.length}`);

        for (const username of uniqueInWindow) {
            if (seen.has(username)) continue;

            if (maxNewUsers > 0 && newUsersSaved >= maxNewUsers) {
                break;
            }

            const profile = await fetchUserProfile(username);
            seen.add(username);

            if (profile) {
                await Actor.pushData(profile);
                newUsersSaved++;
                console.log(`SAVED: ${username} (${profile.links.length} link(s) in bio)`);
            }
        }

        cursor = windowEnd;
        windowsScanned++;

        // Save progress after every window, not just at the end, so a run
        // that stops partway through never has to repeat work already done.
        await saveState({ cursor, seenUsernames: Array.from(seen) });

        if (windowEnd >= nowSeconds) {
            reachedPresentDay = true;
        }
    }

    console.log('\n==============================');
    console.log('RUN FINISHED');
    console.log('==============================');
    console.log(`Windows scanned this run: ${windowsScanned}`);
    console.log(`New profiles saved this run: ${newUsersSaved}`);
    console.log(`Total known usernames so far: ${seen.size}`);
    console.log(
        reachedPresentDay
            ? 'Caught all the way up to today. Nothing left to walk forward through.'
            : `Stopped at ${new Date(cursor * 1000).toISOString()}. Run again to continue from here.`,
    );
} catch (error) {
    console.error(`FATAL ACTOR ERROR: ${errorMessage(error)}`);
    throw error;
} finally {
    await Actor.exit();
}
