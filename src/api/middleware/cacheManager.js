/**
 * Cache Manager with Size Limits
 * Prevents cache from growing indefinitely and consuming all memory
 */

class CacheManager {
    constructor(options = {}) {
        this.maxSize = options.maxSize || 100; // Max cache entries
        this.ttl = options.ttl || 5 * 60 * 1000; // 5 minutes default
        this.cache = new Map();
        this.hits = 0;
        this.misses = 0;

        // Periodically clean up expired entries
        setInterval(() => this.cleanup(), 60000); // Every minute
    }

    get(key) {
        const entry = this.cache.get(key);

        if (!entry) {
            this.misses++;
            return null;
        }

        // Check if expired
        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }

        this.hits++;
        return entry.data;
    }

    set(key, data) {
        // If cache is full, remove oldest entry
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    cleanup() {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.ttl) {
                this.cache.delete(key);
                removed++;
            }
        }

        if (removed > 0) {
            console.log(`🗑️  Cache cleanup: removed ${removed} expired entries`);
        }
    }

    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }

    getStats() {
        const totalRequests = this.hits + this.misses;
        const hitRate = totalRequests > 0 ? (this.hits / totalRequests * 100).toFixed(1) : 0;

        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            hitRate: `${hitRate}%`,
            ttl: this.ttl
        };
    }
}

module.exports = CacheManager;
