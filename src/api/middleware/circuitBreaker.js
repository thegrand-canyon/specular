/**
 * Circuit Breaker Middleware
 * Protects server from crashing due to high memory usage
 */

const v8 = require('v8');

class CircuitBreaker {
    constructor(options = {}) {
        this.memoryThreshold = options.memoryThreshold || 0.85; // 85% memory usage
        this.checkInterval = options.checkInterval || 5000; // Check every 5s
        this.cooldownPeriod = options.cooldownPeriod || 30000; // 30s cooldown

        this.isOpen = false;
        this.lastCheck = 0;
        this.tripCount = 0;

        // Start monitoring
        this.startMonitoring();
    }

    startMonitoring() {
        setInterval(() => {
            const memUsage = process.memoryUsage();
            const heapStats = v8.getHeapStatistics();
            const heapUsedPercent = memUsage.heapUsed / heapStats.heap_size_limit;

            // Open circuit if memory is too high
            if (heapUsedPercent > this.memoryThreshold) {
                if (!this.isOpen) {
                    console.log(`⚠️  Circuit breaker OPEN - Memory usage: ${(heapUsedPercent * 100).toFixed(1)}%`);
                    this.isOpen = true;
                    this.tripCount++;
                    this.lastCheck = Date.now();

                    // Force garbage collection if available
                    if (global.gc) {
                        console.log('🗑️  Running garbage collection...');
                        global.gc();
                    }

                    // Auto-close after cooldown
                    setTimeout(() => {
                        this.isOpen = false;
                        console.log('✅ Circuit breaker CLOSED - Memory recovered');
                    }, this.cooldownPeriod);
                }
            }
        }, this.checkInterval);
    }

    middleware() {
        return (req, res, next) => {
            if (this.isOpen) {
                const memUsage = process.memoryUsage();
                const heapStats = v8.getHeapStatistics();
                const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
                const heapLimitMB = (heapStats.heap_size_limit / 1024 / 1024).toFixed(2);

                return res.status(503).json({
                    error: 'Service temporarily unavailable',
                    message: 'Server is under high memory pressure. Please try again in a moment.',
                    memoryUsage: {
                        used: `${heapUsedMB} MB`,
                        limit: `${heapLimitMB} MB`,
                        percent: `${((memUsage.heapUsed / heapStats.heap_size_limit) * 100).toFixed(1)}%`
                    },
                    retryAfter: Math.ceil((this.cooldownPeriod - (Date.now() - this.lastCheck)) / 1000)
                });
            }
            next();
        };
    }

    getStatus() {
        const memUsage = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        return {
            isOpen: this.isOpen,
            tripCount: this.tripCount,
            memory: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
                heapLimit: Math.round(heapStats.heap_size_limit / 1024 / 1024), // MB
                rss: Math.round(memUsage.rss / 1024 / 1024), // MB
                external: Math.round(memUsage.external / 1024 / 1024), // MB
                usagePercent: ((memUsage.heapUsed / heapStats.heap_size_limit) * 100).toFixed(1)
            }
        };
    }
}

module.exports = CircuitBreaker;
