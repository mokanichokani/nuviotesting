const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { parse } = require('hls-parser');
const { URL } = require('url');

// Use default export for node-fetch v3+
let fetchPromise = fetch;
if (fetch.default) {
    fetchPromise = fetch.default;
}

// --- Constants ---
const API_BASE_URL = 'https://ftmoh345xme.com';
const ORIGIN = 'https://friness-cherlormur-i-275.site';
const PROXY_URL = process.env.EIGHTSTREAM_PROXY_URL || process.env.SHOWBOX_PROXY_URL_VALUE;

// --- Helper Functions ---

// Generic fetcher with proxy support for this provider
async function proxiedFetch(url, options = {}, isJsonExpected = false) {
    const finalFetch = await fetchPromise;
    const fetchUrl = PROXY_URL ? `${PROXY_URL}${encodeURIComponent(url)}` : url;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await finalFetch(fetchUrl, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Response not OK: ${response.status} ${response.statusText}`);
        }

        if (isJsonExpected) {
            const textData = await response.text();
            try {
                return JSON.parse(textData);
            } catch (e) {
                console.error(`[eightstream] Expected JSON but failed to parse. Content: ${textData.substring(0, 200)}`);
                throw new Error('Failed to parse JSON response from eightstream');
            }
        }
        return response.text();
    } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[eightstream] Fetch error for ${url}:`, error.message);
        throw error;
    }
}

// Function to convert TMDB ID to IMDb ID
async function convertTmdbToImdb(tmdbId, mediaType, apiKey) {
    if (!apiKey) {
        console.warn('[eightstream] TMDB_API_KEY not found, cannot convert to IMDb ID.');
        return null;
    }
    const finalFetch = await fetchPromise;
    const type = mediaType === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${apiKey}`;
    try {
        const response = await finalFetch(url);
        if (!response.ok) throw new Error('Failed to fetch external IDs from TMDB');
        const data = await response.json();
        return data.imdb_id || null;
    } catch (error) {
        console.error(`[eightstream] Error converting TMDB to IMDb:`, error.message);
        return null;
    }
}

// Gets initial media info and language playlist
async function getMediaInfo(imdbId) {
    const url = `${API_BASE_URL}/play/${imdbId}`;
    const headers = { 'Origin': ORIGIN, 'Referer': 'https://google.com/', 'Dnt': '1' };

    console.log(`[eightstream] Fetching initial info from: ${url}`);
    const resultHtml = await proxiedFetch(url, { headers });
    const $ = cheerio.load(resultHtml);

    const script = $('script').last().html();
    if (!script) throw new Error('Could not find script tag with media data.');

    const contentMatch = script.match(/(\{[^;]+});/)?.[1] || script.match(/\((\{.*\})\)/)?.[1];
    if (!contentMatch) throw new Error('Could not extract media JSON from script.');

    const data = JSON.parse(contentMatch);
    let playlistUrl = data.file;
    if (!playlistUrl) throw new Error('Playlist URL not found in media JSON.');

    if (playlistUrl.startsWith('/')) playlistUrl = API_BASE_URL + playlistUrl;
    const key = data.key;
    if (!key) throw new Error('CSRF key not found in media JSON.');

    console.log(`[eightstream] Fetching language playlist from: ${playlistUrl}`);
    const playlistData = await proxiedFetch(playlistUrl, {
        headers: { ...headers, 'X-Csrf-Token': key },
    }, true);

    return { playlist: playlistData, key };
}

// Gets the final M3U8 URL from the selected file
async function getFinalStreamUrl(filePath, key) {
    if (!filePath || typeof filePath !== 'string') throw new Error('Invalid file path for final stream.');
    const path = `${filePath.slice(1)}.txt`;
    const url = `${API_BASE_URL}/playlist/${path}`;
    const headers = { 'Origin': ORIGIN, 'Referer': 'https://google.com/', 'Dnt': '1', 'X-Csrf-Token': key };
    
    console.log(`[eightstream] Fetching final M3U8 link from: ${url}`);
    return await proxiedFetch(url, { headers });
}

// Parses M3U8 content for different quality streams
function parseM3U8(m3u8Content, baseUrl) {
    try {
        const playlist = parse(m3u8Content);
        const streams = [];

        if (playlist.isMasterPlaylist && playlist.variants?.length > 0) {
            playlist.variants.forEach((variant, index) => {
                const quality = variant.resolution ? `${variant.resolution.height}p` : `Quality ${index + 1}`;
                streams.push({
                    url: new URL(variant.uri, baseUrl).href,
                    quality: quality,
                    provider: 'eightstream',
                });
            });
        } else {
            streams.push({ url: baseUrl, quality: 'Auto', provider: 'eightstream' });
        }
        return streams;
    } catch (error) {
        console.error('[eightstream] Failed to parse M3U8 playlist, returning direct link.', error.message);
        return [{ url: baseUrl, quality: 'Auto', provider: 'eightstream' }];
    }
}

// Main exported function for the addon
async function geteightstreamStreams(tmdbId, mediaType, seasonNum, episodeNum, apiKey) {
    console.log(`[eightstream] Getting streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    const imdbId = await convertTmdbToImdb(tmdbId, mediaType, apiKey);
    if (!imdbId) {
        console.error(`[eightstream] Could not get IMDb ID for TMDB ID ${tmdbId}. Skipping.`);
        return [];
    }
    console.log(`[eightstream] Converted TMDB ID ${tmdbId} to IMDb ID ${imdbId}`);

    try {
        const { playlist, key } = await getMediaInfo(imdbId);
        let targetFile = null;

        if (mediaType === 'movie') {
            if (!playlist || !Array.isArray(playlist)) throw new Error('Invalid movie playlist.');
            targetFile = playlist.find(item => item?.title?.toLowerCase() === 'english') || playlist[0];
        } else if (mediaType === 'tv') {
            if (!playlist || !Array.isArray(playlist)) throw new Error('Invalid TV playlist.');
            const seasonData = playlist.find(s => s?.id === String(seasonNum));
            if (!seasonData) throw new Error(`Season ${seasonNum} not found.`);
            const episodeData = seasonData.folder?.find(e => e?.episode === String(episodeNum));
            if (!episodeData) throw new Error(`Episode ${episodeNum} not found.`);
            targetFile = episodeData.folder?.find(f => f?.title?.toLowerCase() === 'english') || episodeData.folder?.[0];
        }

        if (!targetFile?.file) throw new Error('Could not find a suitable media file.');

        const m3u8Link = await getFinalStreamUrl(targetFile.file, key);
        if (!m3u8Link?.startsWith('http')) throw new Error(`Invalid M3U8 link: ${m3u8Link}`);

        const m3u8Content = await proxiedFetch(m3u8Link);
        if (!m3u8Content.includes('#EXTM3U')) {
            console.warn('[eightstream] Content is not M3U8. Returning direct link.');
            return [{ url: m3u8Link, quality: 'Auto', provider: 'eightstream' }];
        }
        
        const streams = parseM3U8(m3u8Content, m3u8Link);
        console.log(`[eightstream] Extracted ${streams.length} streams.`);
        return streams;

    } catch (error) {
        console.error(`[eightstream] Error in geteightstreamStreams:`, error.message);
        return [];
    }
}

module.exports = { geteightstreamStreams };