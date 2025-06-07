/**
 * Cuevana3 streaming provider integration for Stremio
 */

// Define constants
const FLAGS = { CORS_ALLOWED: 'CORS_ALLOWED' };
const BASE_URL = 'https://ws-m3u8.moonpic.qzz.io:3008/tmdb';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// Helper function to convert number to base36
function intToBase36(num) {
  if (num === 0) return "0";
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let base36String = "";
  while (num > 0) {
    const remainder = num % 36;
    base36String = alphabet[remainder] + base36String;
    num = Math.floor(num / 36);
  }
  return base36String;
}

// Helper function to deobfuscate the packed JS from streamwish
function deobfuscateStreamwish(packedJs) {
  // Regex to capture p, a, c, k components. Made quotes around p and k flexible.
  const evalMatch = packedJs.match(/eval\(function\(p,a,c,k,e,d\)\{.*?return p\}\((['"])(.*?)\1,\s*(\d+),\s*(\d+),\s*(['"])(.*?)\5\.split\(['"]\|['"]\)/s);
  if (!evalMatch || evalMatch.length < 7) { 
    console.warn("Streamwish: Could not find eval function or its parameters consistently. Match length:", evalMatch ? evalMatch.length : 0);
    if (evalMatch) console.warn("Streamwish evalMatch parts:", evalMatch.slice(1, 7).join(" | "));
    return null;
  }

  let p = evalMatch[2]; // The packed code
  const a = parseInt(evalMatch[3], 10); // base for c.toString(a)
  let c = parseInt(evalMatch[4], 10); // count of keywords
  const k = evalMatch[6].split('|');   // keywords array

  if (isNaN(a) || isNaN(c)) {
    console.warn("Streamwish: Failed to parse radix 'a' or count 'c'.");
    return null;
  }
  
  while (c--) {
    const token = c.toString(a);
    if (k[c]) {
      const regex = new RegExp('\\b' + token + '\\b', 'g');
      p = p.replace(regex, k[c]);
    }
  }
  return p;
}

// Main function to scrape the links - adapted for module usage
async function getCuevanaStreams(tmdbId, mediaType, season, episode) {
  // Build the URL based on media type
  let url = '';
  if (mediaType === 'movie') {
    url = `${BASE_URL}/movie/${tmdbId}`;
  } else if (mediaType === 'tv') {
    if (season == null || episode == null) {
      console.error('Season and episode numbers are required for TV shows');
      return [];
    }
    url = `${BASE_URL}/tv/${tmdbId}/season/${season}/episode/${episode}`;
  } else {
    console.error('Unsupported media type. Use movie or tv');
    return [];
  }

  const initialHeaders = {
    'Origin': 'https://pstream.org',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36'
  };

  console.log(`[Cuevana] Fetching data from ${url}...`);
  
  try {
    const response = await fetch(url, { headers: initialHeaders });
    
    if (!response.ok) {
      console.error(`[Cuevana] Failed to fetch data: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();

    if (!data.embeds || !Array.isArray(data.embeds) || data.embeds.length === 0) {
      console.error('[Cuevana] No valid embeds found in the response');
      return [];
    }

    console.log(`[Cuevana] Found ${data.embeds.length} embed(s). Processing...`);
    
    const streams = [];
    let embedStreamCounter = 0;

    for (const embed of data.embeds) {
      // Extract language from embedId
      let languageForEmbed = 'unk'; // Default to unknown
      if (embed.embedId && embed.embedId.startsWith('streamwish-')) {
        const langPart = embed.embedId.substring('streamwish-'.length);
        if (langPart) {
          languageForEmbed = langPart; // This might be 'eng', 'ENG', 'english', 'ENGLISH' etc.
        }
      }

      // TEMPORARY: Skip English streams - make this check case-insensitive for 'eng' and also check for 'english'
      const lowerLangForEmbed = languageForEmbed.toLowerCase();
      if (lowerLangForEmbed === 'eng' || lowerLangForEmbed === 'english') {
        console.log(`[Cuevana] Skipping English stream (lang: ${languageForEmbed}) as requested: ${embed.url}`);
        continue;
      }

      let embedUrlObject;
      try {
        embedUrlObject = new URL(embed.url);
      } catch (e) {
        console.warn(`[Cuevana] Invalid embed URL: ${embed.url}`);
        continue;
      }
      
      const embedHostname = embedUrlObject.hostname;
      const embedOrigin = embedUrlObject.origin;

      // Only process streamwish/swiftplayers embeds
      if (embed.url && (embedHostname.includes('streamwish.to') || embedHostname.includes('swiftplayers.com') || embedHostname.includes('playerswish.com'))) {
        embedStreamCounter++;
        console.log(`[Cuevana] Processing embed: ${embed.url} (${languageForEmbed})`);
        
        try {
          const embedPageHeaders = { 
            'User-Agent': USER_AGENT,
            'Referer': embedOrigin
          };

          const embedResponse = await fetch(embed.url, { headers: embedPageHeaders });
          
          if (!embedResponse.ok) {
            console.warn(`[Cuevana] Failed to fetch embed ${embed.url}: ${embedResponse.status} ${embedResponse.statusText}`);
            continue;
          }
          
          const embedPageText = await embedResponse.text();
          const deobfuscatedJs = deobfuscateStreamwish(embedPageText);

          if (deobfuscatedJs) {
            const m3u8MasterRegex = /"(?:hls[^"}]*)":\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i;
            const masterMatch = deobfuscatedJs.match(m3u8MasterRegex);

            if (masterMatch && masterMatch[1]) {
              const masterPlaylistUrl = masterMatch[1];
              console.log(`[Cuevana] Found master playlist: ${masterPlaylistUrl}`);
              
              const streamHeaders = {
                'Referer': 'https://swiftplayers.com/',
                'Origin': 'https://swiftplayers.com/',
                'User-Agent': USER_AGENT
              };

              let variantsFound = 0;
              try {
                const masterPlaylistResponse = await fetch(masterPlaylistUrl, { headers: streamHeaders });
                if (masterPlaylistResponse.ok) {
                  const masterPlaylistText = await masterPlaylistResponse.text();
                  const lines = masterPlaylistText.split(/\r?\n/);
                  const masterBaseUrl = masterPlaylistUrl.substring(0, masterPlaylistUrl.lastIndexOf('/') + 1);
                  
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
                      const streamInfoLine = lines[i];
                      let qualityLabel = 'auto';
                      
                      // Try to extract resolution
                      const resolutionMatch = streamInfoLine.match(/RESOLUTION=(\d+x(\d+))/);
                      if (resolutionMatch && resolutionMatch[2]) {
                        qualityLabel = resolutionMatch[2] + 'p';
                      } else {
                        // Fallback to bandwidth
                        const bandwidthMatch = streamInfoLine.match(/BANDWIDTH=(\d+)/);
                        if (bandwidthMatch) {
                          qualityLabel = Math.round(parseInt(bandwidthMatch[1]) / 1000) + 'k';
                        }
                      }

                      // TEMPORARY: Skip 480p or lower quality streams
                      const resolutionNumber = parseInt(qualityLabel.match(/(\d+)p/)?.[1] || '1080', 10);
                      if (resolutionNumber <= 480) {
                        console.log(`[Cuevana] Skipping low quality stream (${qualityLabel}) as requested`);
                        continue;
                      }

                      if (i + 1 < lines.length && lines[i+1].trim() && !lines[i+1].startsWith('#')) {
                        const mediaPlaylistPath = lines[i+1].trim();
                        const mediaPlaylistUrl = new URL(mediaPlaylistPath, masterBaseUrl).href;
                        
                        const streamId = `cuevana-sw-${languageForEmbed}-${qualityLabel}-${embedStreamCounter}-${variantsFound}`;
                        
                        streams.push({
                          id: streamId,
                          type: 'hls',
                          url: mediaPlaylistUrl, // URL that will be used in the addon
                          language: languageForEmbed,
                          quality: qualityLabel,
                          playlist: mediaPlaylistUrl, // For internal reference
                          flags: [FLAGS.CORS_ALLOWED],
                          headers: streamHeaders,
                          provider: 'Cuevana',
                          title: `Cuevana ${languageForEmbed.toUpperCase()} - ${qualityLabel}`
                        });
                        
                        variantsFound++;
                        console.log(`[Cuevana] Extracted variant: Lang(${languageForEmbed}) Qual(${qualityLabel})`);
                      }
                    }
                  }
                  
                  // If no variants found but the playlist itself contains segments
                  if (variantsFound === 0 && masterPlaylistText.includes('#EXTINF:')) {
                    streams.push({
                      id: `cuevana-sw-${languageForEmbed}-auto-${embedStreamCounter}-0`,
                      type: 'hls',
                      url: masterPlaylistUrl, // URL that will be used in the addon
                      language: languageForEmbed,
                      quality: 'auto',
                      playlist: masterPlaylistUrl, // For internal reference
                      flags: [FLAGS.CORS_ALLOWED],
                      headers: streamHeaders,
                      provider: 'Cuevana',
                      title: `Cuevana ${languageForEmbed.toUpperCase()} - Auto`
                    });
                    
                    variantsFound++;
                    console.log(`[Cuevana] Using master as media playlist: Lang(${languageForEmbed}) Qual(auto)`);
                  }

                  if (variantsFound === 0) {
                    console.warn(`[Cuevana] No media playlists found in master: ${masterPlaylistUrl}`);
                  }
                } else {
                  console.warn(`[Cuevana] Failed to fetch master playlist: ${masterPlaylistResponse.status} ${masterPlaylistResponse.statusText}`);
                }
              } catch (err) {
                console.error(`[Cuevana] Error processing master playlist: ${err.message || err}`);
              }
            } else {
              console.warn(`[Cuevana] No M3U8 master link found in deobfuscated JS`);
            }
          } else {
            console.warn(`[Cuevana] Failed to deobfuscate JavaScript`);
          }
        } catch (err) {
          console.error(`[Cuevana] Error processing embed ${embed.url}: ${err.message || err}`);
        }
      } else {
        console.log(`[Cuevana] Skipping non-streamwish embed: ${embed.url}`);
      }
    }

    return streams;
  } catch (error) {
    console.error(`[Cuevana] Error fetching streams: ${error.message || error}`);
    return [];
  }
}

module.exports = { getCuevanaStreams }; 