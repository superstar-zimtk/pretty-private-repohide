case 'play': {
    try {
        const fetch = require('node-fetch');
        const ytSearch = require('yt-search');
        const fs = require('fs');
        const { pipeline } = require('stream');
        const { promisify } = require('util');
        const os = require('os');

        // Cache for frequently used data
        const fontCache = new Map();
        const thumbnailCache = new Map();

        function toFancyFont(text) {
            if (fontCache.has(text)) return fontCache.get(text);
            
            const fontMap = {
                'a': 'ᴀ', 'b': 'ʙ', 'c': 'ᴄ', 'd': 'ᴅ', 'e': 'ᴇ', 'f': 'ғ', 'g': 'ɢ', 
                'h': 'ʜ', 'i': 'ɪ', 'j': 'ᴊ', 'k': 'ᴋ', 'l': 'ʟ', 'm': 'ᴍ', 'n': 'ɴ', 
                'o': 'ᴏ', 'p': 'ᴘ', 'q': 'ǫ', 'r': 'ʀ', 's': 's', 't': 'ᴛ', 'u': 'ᴜ', 
                'v': 'ᴠ', 'w': 'ᴡ', 'x': 'x', 'y': 'ʏ', 'z': 'ᴢ'
            };
            
            const result = text.toLowerCase().split('').map(char => fontMap[char] || char).join('');
            fontCache.set(text, result);
            return result;
        }

        const streamPipeline = promisify(pipeline);
        const tmpDir = os.tmpdir();

        // Kaiz-API configuration
        const KAIZ_API_KEY = 'cf2ca612-296f-45ba-abbc-473f18f991eb';
        const KAIZ_API_URL = 'https://kaiz-apis.gleeze.com/api/ytdown-mp3';

        function getYouTubeThumbnail(videoId, quality = 'hqdefault') {
            const cacheKey = `${videoId}_${quality}`;
            if (thumbnailCache.has(cacheKey)) return thumbnailCache.get(cacheKey);
            
            const qualities = {
                'default': 'default.jpg', 'mqdefault': 'mqdefault.jpg', 'hqdefault': 'hqdefault.jpg',
                'sddefault': 'sddefault.jpg', 'maxresdefault': 'maxresdefault.jpg'
            };
            
            const result = `https://i.ytimg.com/vi/${videoId}/${qualities[quality] || qualities['hqdefault']}`;
            thumbnailCache.set(cacheKey, result);
            return result;
        }

        function extractYouTubeId(url) {
            const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
            const match = url.match(regExp);
            return (match && match[7].length === 11) ? match[7] : false;
        }

        // Store user preferences with better session management
        const userSessions = new Map();

        // Session cleanup function
        function cleanupExpiredSessions() {
            const now = Date.now();
            for (const [sender, session] of userSessions.entries()) {
                if (now - session.timestamp > 10 * 60 * 1000) {
                    userSessions.delete(sender);
                    // Clean up file if exists
                    if (session.filePath && fs.existsSync(session.filePath)) {
                        try {
                            fs.unlinkSync(session.filePath);
                        } catch (e) {}
                    }
                }
            }
        }

        // Utility function to fetch video info
        async function fetchVideoInfo(text) {
            const isYtUrl = text.match(/(youtube\.com|youtu\.be)/i);
            
            if (isYtUrl) {
                const videoId = text.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i)?.[1];
                if (!videoId) throw new Error('Invalid YouTube URL format');
                
                const videoInfo = await ytSearch({ videoId });
                if (!videoInfo) throw new Error('Could not fetch video info');
                
                return { url: `https://youtu.be/${videoId}`, info: videoInfo };
            } else {
                const searchResults = await ytSearch(text);
                if (!searchResults?.videos?.length) throw new Error('No results found');
                
                const validVideos = searchResults.videos.filter(v => !v.live && v.duration.seconds < 7200 && v.views > 10000);
                if (!validVideos.length) throw new Error('Only found live streams/unpopular videos');
                
                return { url: validVideos[0].url, info: validVideos[0] };
            }
        }

        // Utility function to fetch audio from Kaiz-API with timeout
        async function fetchAudioData(videoUrl) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout
            
            try {
                const apiUrl = `${KAIZ_API_URL}?url=${encodeURIComponent(videoUrl)}&apikey=${KAIZ_API_KEY}`;
                const response = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    },
                    signal: controller.signal
                });
                
                if (!response.ok) throw new Error('API request failed');
                
                const data = await response.json();
                if (!data?.download_url) throw new Error('Invalid API response');
                
                return data;
            } finally {
                clearTimeout(timeout);
            }
        }

        // Utility function to fetch thumbnail with caching
        async function fetchThumbnail(thumbnailUrl) {
            if (!thumbnailUrl) return null;
            
            // Check cache first
            if (thumbnailCache.has(thumbnailUrl)) {
                return thumbnailCache.get(thumbnailUrl);
            }
            
            try {
                const response = await fetch(thumbnailUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });
                
                if (!response.ok) return null;
                
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
                // Cache the thumbnail for future use
                thumbnailCache.set(thumbnailUrl, buffer);
                
                // Set timeout to clear cache after 10 minutes
                setTimeout(() => {
                    thumbnailCache.delete(thumbnailUrl);
                }, 600000);
                
                return buffer;
            } catch (e) {
                console.error('Thumbnail error:', e);
                return null;
            }
        }

        // Function to format the song info with decorations
        function formatSongInfo(videoInfo, videoUrl) {
            const minutes = Math.floor(videoInfo.duration.seconds / 60);
            const seconds = videoInfo.duration.seconds % 60;
            const formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            
            // Create a decorated song info with ASCII art
            return `
╭───〘  *ᴄᴀsᴇʏʀʜᴏᴅᴇs ᴀɪ* 〙───
├📝 *ᴛɪᴛʟᴇ:* ${videoInfo.title}
├👤 *ᴀʀᴛɪsᴛ:* ${videoInfo.author.name}
├⏱️ *ᴅᴜʀᴀᴛɪᴏɴ:* ${formattedDuration}
├📅 *ᴜᴘʟᴏᴀᴅᴇᴅ:* ${videoInfo.ago}
├👁️ *ᴠɪᴇᴡs:* ${videoInfo.views.toLocaleString()}
├🎵 *Format:* High Quality MP3
╰───────────────┈ ⊷
${toFancyFont("choose download format:")}
            `.trim();
        }

        // React to the command first
        await socket.sendMessage(sender, {
            react: {
                text: "🎵",
                key: msg.key
            }
        });

        // Extract query from message
        const q = msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || 
                  msg.message?.imageMessage?.caption || 
                  msg.message?.videoMessage?.caption || '';
        
        const args = q.split(' ').slice(1);
        const query = args.join(' ').trim();

        if (!query) {
            return await socket.sendMessage(sender, {
                text: '*🎵 Audio Player*\nPlease provide a song name or YouTube URL to play.*'
            }, { quoted: msg });
        }

        console.log('[PLAY] Searching for:', query);

        try {
            // Fetch video info using the new logic
            const { url: videoUrl, info: videoInfo } = await fetchVideoInfo(query);
            
            // Fetch audio data from Kaiz-API
            const apiData = await fetchAudioData(videoUrl);
            
            if (!apiData.download_url) {
                return await socket.sendMessage(sender, {
                    text: '*❌ Download Failed*\nNo download URL available from the service.*'
                }, { quoted: msg });
            }
            
            const videoId = extractYouTubeId(videoUrl) || videoInfo.videoId;
            const thumbnailUrl = getYouTubeThumbnail(videoId, 'maxresdefault');
            
            // Use the decorated song info format
            const songInfo = formatSongInfo(videoInfo, videoUrl);
            
            // Store session data
            const sessionData = {
                downloadUrl: apiData.download_url,
                videoTitle: videoInfo.title,
                videoUrl: videoUrl,
                thumbnailUrl: thumbnailUrl,
                timestamp: Date.now(),
                filePath: null
            };
            
            userSessions.set(sender, sessionData);
            
            // Download thumbnail for image message
            let imageBuffer = await fetchThumbnail(thumbnailUrl);
            
            // Create all buttons in a single array
            const buttons = [
                {
                    buttonId: '.audio',
                    buttonText: { displayText: "🎶 ❯❯ ᴀᴜᴅɪᴏ" },
                    type: 1
                },
                {
                    buttonId: '.document',
                    buttonText: { displayText: "📂 ❯❯ ᴅᴏᴄᴜᴍᴇɴᴛ" },
                    type: 1
                },
                {
                    buttonId: '.voicenote',
                    buttonText: { displayText: "🎤 ❯❯ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ" },
                    type: 1
                }
            ];
            
            // Newsletter context info
            const newsletterContext = {
                forwardingScore: 1,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363302677217436@newsletter',
                    newsletterName: 'POWERED BY CASEYRHODES TECH',
                    serverMessageId: -1
                }
            };
            
            // Send single message with both info and buttons
            if (imageBuffer) {
                await socket.sendMessage(sender, {
                    image: imageBuffer,
                    caption: songInfo,
                    buttons: buttons,
                    footer: '> ᴍᴀᴅᴇ ᴡɪᴛʜ 🤍 ʙʏ ᴄᴀsᴇʏʀʜᴏᴅᴇs ᴀɪ',
                    headerType: 1,
                    contextInfo: newsletterContext
                }, { quoted: msg });
            } else {
                await socket.sendMessage(sender, {
                    text: songInfo,
                    buttons: buttons,
                    footer: '> ᴍᴀᴅᴇ ᴡɪᴛʜ 🤍 ʙʏ ᴄᴀsᴇʏʀʜᴏᴅᴇs ᴀɪ',
                    contextInfo: newsletterContext
                }, { quoted: msg });
            }
            
            // React with success
            await socket.sendMessage(sender, {
                react: {
                    text: "✅",
                    key: msg.key
                }
            });
            
        } catch (error) {
            console.error('[PLAY] Error:', error.message);
            await socket.sendMessage(sender, {
                text: `*❌ Error*\n${error.message || 'Failed to process your request. Please try again.'}*`
            }, { quoted: msg });
        }

    } catch (err) {
        console.error('[PLAY] Main Error:', err.message);
        await socket.sendMessage(sender, {
            text: '*❌ Unexpected Error*\nAn unexpected error occurred. Please try again later.*'
        }, { quoted: msg });
    }
    break;
}

case 'audio':
case 'document':
case 'voicenote': {
    try {
        const fetch = require('node-fetch');
        const fs = require('fs');
        const { pipeline } = require('stream');
        const { promisify } = require('util');
        const os = require('os');

        const streamPipeline = promisify(pipeline);
        const tmpDir = os.tmpdir();

        // React to the command first
        await socket.sendMessage(sender, {
            react: {
                text: "⬇️",
                key: msg.key
            }
        });

        const session = userSessions.get(sender);
        
        if (!session || (Date.now() - session.timestamp > 10 * 60 * 1000)) {
            if (session) userSessions.delete(sender);
            return await socket.sendMessage(sender, {
                text: '*❌ Session Expired*\nPlease use the .play command again to search for a new song.*'
            }, { quoted: msg });
        }
        
        try {
            let audioData;
            const fileName = `${session.videoTitle.replace(/[^\w\s]/gi, '').replace(/\s+/g, '_').substring(0, 50)}_${Date.now()}`;
            const filePath = `${tmpDir}/${fileName}.mp3`;
            
            // Download the audio file
            const audioResponse = await fetch(session.downloadUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://www.youtube.com/',
                    'Accept-Encoding': 'identity'
                }
            });
            
            if (!audioResponse.ok) throw new Error("Download failed");
            
            const fileStream = fs.createWriteStream(filePath);
            await streamPipeline(audioResponse.body, fileStream);
            
            audioData = fs.readFileSync(filePath);
            
            // Newsletter context info
            const newsletterContext = {
                externalAdReply: {
                    title: session.videoTitle.substring(0, 30) || 'Audio Download',
                    body: 'Powered by CASEYRHODES API',
                    mediaType: 1,
                    sourceUrl: session.videoUrl,
                    thumbnailUrl: session.thumbnailUrl,
                    renderLargerThumbnail: false
                }
            };
            
            if (command === "audio") {
                // Send as audio message
                await socket.sendMessage(sender, {
                    audio: audioData,
                    mimetype: 'audio/mpeg',
                    ptt: false,
                    fileName: `${session.videoTitle.replace(/[^\w\s]/gi, '')}.mp3`.substring(0, 50) || 'audio.mp3',
                    contextInfo: newsletterContext
                }, { quoted: msg });
            } else if (command === "document") {
                // Send as document
                await socket.sendMessage(sender, {
                    document: audioData,
                    mimetype: 'audio/mpeg',
                    fileName: `${session.videoTitle.replace(/[^\w\s]/gi, '')}.mp3`.substring(0, 50) || 'audio.mp3',
                    contextInfo: newsletterContext
                }, { quoted: msg });
            } else if (command === "voicenote") {
                // Send as voice note (ptt: true)
                await socket.sendMessage(sender, {
                    audio: audioData,
                    mimetype: 'audio/mpeg',
                    ptt: true, // This makes it a voice note
                    fileName: `${session.videoTitle.replace(/[^\w\s]/gi, '')}.mp3`.substring(0, 50) || 'voice_note.mp3',
                    contextInfo: newsletterContext
                }, { quoted: msg });
            }
            
            // React with success
            await socket.sendMessage(sender, {
                react: {
                    text: "✅",
                    key: msg.key
                }
            });
            
            // Clean up file after 30 seconds
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                } catch (e) {}
            }, 30000);
            
        } catch (error) {
            console.error(`[${command.toUpperCase()}] Error:`, error.message);
            await socket.sendMessage(sender, {
                text: `*❌ Download Failed*\nFailed to process ${command} file. Please try again.*`
            }, { quoted: msg });
            
            // Clean up on error
            userSessions.delete(sender);
        }

    } catch (err) {
        console.error(`[${command.toUpperCase()}] Main Error:`, err.message);
        await socket.sendMessage(sender, {
            text: '*❌ Unexpected Error*\nAn unexpected error occurred. Please try again.*'
        }, { quoted: msg });
    }
    break;
                                }
