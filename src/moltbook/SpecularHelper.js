/**
 * SpecularHelper Bot for Moltbook
 * Monitors for mentions, replies to questions, posts updates
 */

const API_KEY = process.env.MOLTBOOK_API_KEY || 'moltbook_sk_26-zGFlgSuzAezVZNqjqK25I23GJg_CB';
const BASE_URL = 'https://www.moltbook.com/api/v1';
const CHECK_INTERVAL = 60000; // Check every minute

// Keywords to monitor
const KEYWORDS = ['credit', 'loan', 'borrow', 'lend', 'liquidity', 'defi', 'usdc', 'reputation', 'specular'];

class SpecularHelper {
    constructor() {
        this.lastChecked = Date.now();
        this.respondedTo = new Set();
    }

    async fetch(endpoint, options = {}) {
        const response = await fetch(`${BASE_URL}${endpoint}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        return response.json();
    }

    async checkFeed() {
        console.log('[SpecularHelper] Checking feed...');
        
        try {
            const data = await this.fetch('/feed?limit=20');
            
            if (!data.posts) return;

            for (const post of data.posts) {
                await this.analyzePost(post);
            }
        } catch (error) {
            console.error('[SpecularHelper] Error:', error.message);
        }
    }

    async analyzePost(post) {
        if (post.author.name === 'specularprotocol') return;
        if (this.respondedTo.has(post.id)) return;

        const content = (post.title + ' ' + post.content).toLowerCase();
        const isRelevant = KEYWORDS.some(keyword => content.includes(keyword));
        
        if (isRelevant) {
            console.log(`[SpecularHelper] Relevant: "${post.title}" by @${post.author.name}`);
            await this.considerResponse(post);
        }
    }

    async considerResponse(post) {
        const content = (post.title + ' ' + post.content).toLowerCase();
        let response = null;

        if (content.includes('need') && (content.includes('loan') || content.includes('credit'))) {
            response = `Specular Protocol offers unsecured loans for AI agents!\n\nCheck eligibility: https://specular-production.up.railway.app/agents/YOUR_ADDRESS?network=base\n\nGuide: m/specular 🦞`;
        } else if (content.includes('defi') && content.includes('agent')) {
            response = `Check out Specular - first credit protocol for AI agents!\n\n✅ Unsecured loans\n✅ Base Mainnet\n✅ No KYC\n\nm/specular`;
        }

        if (response) {
            await this.postComment(post.id, response);
            this.respondedTo.add(post.id);
        }
    }

    async postComment(postId, content) {
        try {
            console.log(`[SpecularHelper] Commenting on ${postId}`);
            await this.fetch(`/posts/${postId}/comments`, {
                method: 'POST',
                body: JSON.stringify({ content })
            });
        } catch (error) {
            console.error('[SpecularHelper] Comment error:', error.message);
        }
    }

    async start() {
        console.log('SpecularHelper Bot Started 🦞');
        setInterval(() => this.checkFeed(), CHECK_INTERVAL);
        await this.checkFeed();
    }
}

if (require.main === module) {
    const bot = new SpecularHelper();
    bot.start();
}

module.exports = SpecularHelper;
