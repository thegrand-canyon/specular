/**
 * Request Limiter Middleware
 * Prevents API server from being overwhelmed by too many concurrent requests
 */

class RequestLimiter {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 20; // Max concurrent requests
        this.queueSize = options.queueSize || 100; // Max queued requests
        this.timeout = options.timeout || 30000; // Request timeout (30s)

        this.activeRequests = 0;
        this.queue = [];
        this.stats = {
            totalRequests: 0,
            queuedRequests: 0,
            rejectedRequests: 0,
            timeouts: 0
        };
    }

    middleware() {
        return async (req, res, next) => {
            this.stats.totalRequests++;

            // If under limit, process immediately
            if (this.activeRequests < this.maxConcurrent) {
                this.activeRequests++;
                this.processRequest(req, res, next);
                return;
            }

            // If queue is full, reject immediately
            if (this.queue.length >= this.queueSize) {
                this.stats.rejectedRequests++;
                return res.status(503).json({
                    error: 'Server overloaded',
                    message: `Too many concurrent requests. Active: ${this.activeRequests}, Queued: ${this.queue.length}`,
                    retryAfter: 5
                });
            }

            // Add to queue
            this.stats.queuedRequests++;
            const queueItem = { req, res, next, timestamp: Date.now() };
            this.queue.push(queueItem);

            // Set timeout for queued request
            setTimeout(() => {
                const index = this.queue.indexOf(queueItem);
                if (index !== -1) {
                    this.queue.splice(index, 1);
                    this.stats.timeouts++;
                    if (!res.headersSent) {
                        res.status(504).json({
                            error: 'Request timeout',
                            message: 'Request was queued for too long and timed out',
                            queuedFor: Date.now() - queueItem.timestamp
                        });
                    }
                }
            }, this.timeout);
        };
    }

    processRequest(req, res, next) {
        // Wrap response.end to track completion
        const originalEnd = res.end;
        const limiter = this;

        res.end = function(...args) {
            limiter.activeRequests--;
            limiter.processNext();
            return originalEnd.apply(this, args);
        };

        next();
    }

    processNext() {
        if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
            const { req, res, next } = this.queue.shift();
            this.activeRequests++;
            this.processRequest(req, res, next);
        }
    }

    getStats() {
        return {
            ...this.stats,
            activeRequests: this.activeRequests,
            queuedRequests: this.queue.length,
            queueCapacity: this.queueSize,
            maxConcurrent: this.maxConcurrent
        };
    }
}

module.exports = RequestLimiter;
